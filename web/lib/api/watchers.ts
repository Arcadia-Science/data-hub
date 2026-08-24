import { and, asc, count, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { cache } from "react";
import YAML from "yaml";
import { type ActorUser, resolveActorUser } from "@/lib/api/actor";
import type { AuthResult } from "@/lib/api/auth";
import { apiError, FORBIDDEN } from "@/lib/api/errors";
import { instrumentHasOnlineWatcher } from "@/lib/api/instruments";
import { decideWatcherBinding } from "@/lib/api/watcher-binding";
import { type DbExecutor, db } from "@/lib/db";
import {
  files,
  instrumentRuns,
  instruments,
  users,
  watcherEvents,
  watcherEventTypeEnum,
  watcherHeartbeats,
  watchers,
} from "@/lib/db/schema";

export const STALE_THRESHOLD_MS = 5 * 60 * 1000;

export async function findActiveWatcher(watcherId: string) {
  const [watcher] = await db
    .select()
    .from(watchers)
    .where(and(eq(watchers.id, watcherId), isNull(watchers.deletedAt)))
    .limit(1);

  return watcher ?? null;
}

/**
 * Returns null when the caller may act on this watcher, or a Response the
 * handler should return. Sessions are denied — watcher agent routes are
 * PAT-only via `authorizeToken`. Token callers must match the watcher's
 * registered PAT. A null binding is claimed trust-on-first-use (atomic),
 * then enforced thereafter.
 */
export async function enforceWatcherBinding(
  authResult: AuthResult,
  watcher: { id: string; registeredByToken: string | null }
): Promise<Response | null> {
  const verdict = decideWatcherBinding(authResult, watcher.registeredByToken);

  if (verdict === "allow") {
    return null;
  }
  if (verdict === "deny") {
    return apiError(403, FORBIDDEN, "Token is not authorized for this watcher");
  }

  // `decideWatcherBinding` only returns "tofu" when tokenId is set.
  const tokenId = authResult.tokenId;
  if (!tokenId) {
    return apiError(403, FORBIDDEN, "Token is not authorized for this watcher");
  }

  // TOFU: first token to check in claims the row. The `is null` guard
  // makes concurrent claims atomic — the loser re-reads and is denied.
  const claimed = await db
    .update(watchers)
    .set({ registeredByToken: tokenId })
    .where(and(eq(watchers.id, watcher.id), isNull(watchers.registeredByToken)))
    .returning({ id: watchers.id });

  if (claimed.length > 0) {
    return null;
  }

  const [current] = await db
    .select({ registeredByToken: watchers.registeredByToken })
    .from(watchers)
    .where(eq(watchers.id, watcher.id))
    .limit(1);

  if (current?.registeredByToken === tokenId) {
    return null;
  }

  return apiError(403, FORBIDDEN, "Token is not authorized for this watcher");
}

/**
 * Extracts `instrument.watch_directory` from a watcher's stored config YAML.
 * Returns null when the YAML is missing or unparseable. Mirrors the
 * `extractFilePatterns` helper in `lib/api/instruments.ts`.
 */
export function extractWatchDirectory(
  configYaml: string | null
): string | null {
  if (!configYaml) {
    return null;
  }
  try {
    const doc = YAML.parse(configYaml);
    const dir = doc?.instrument?.watch_directory;
    return typeof dir === "string" ? dir : null;
  } catch {
    return null;
  }
}

/**
 * Reverts an instrument's pending upload requests back to `detected`,
 * clearing `upload_requested_at` so they drop out of the upload queue.
 *
 * Called when a watcher's `watch_directory` changes: every queued file's
 * `relative_path` was anchored to the old root, so none resolve under the
 * new one and the watcher would otherwise re-error on each heartbeat poll.
 * Returns the reverted file ids (for event reporting).
 */
export async function revertPendingUploadRequests(
  instrumentId: string,
  executor: DbExecutor = db
): Promise<number[]> {
  const reverted = await executor
    .update(files)
    .set({ status: "detected", uploadRequestedAt: null })
    .where(
      and(
        inArray(
          files.instrumentRunId,
          db
            .select({ id: instrumentRuns.id })
            .from(instrumentRuns)
            .where(eq(instrumentRuns.instrumentId, instrumentId))
        ),
        eq(files.status, "upload_requested"),
        isNull(files.uploadedAt),
        isNull(files.deletedAt)
      )
    )
    .returning({ id: files.id });
  return reverted.map((row) => row.id);
}

// Sweep-only grace window, wider than the 5-minute online threshold so a brief
// heartbeat blip doesn't churn the queue. The graceful-stop path skips it: an
// explicit stop is intentional and reverts immediately.
export const UPLOAD_REQUEST_REVERT_GRACE_MS = 15 * 60 * 1000;

type UploadRevertReason =
  | "watcher_stopped"
  | "watcher_deregistered"
  | "watcher_offline_sweep"
  | "instrument_retired";

/**
 * Reverts an instrument's pending upload requests to `detected` when no watcher
 * is online to drain them, recording a `watcherEvents` row. Returns the count
 * reverted. The online check is defensive given the one-active-watcher index,
 * but lets the sweep attribute an event to a soft-deleted watcher without
 * touching a live one.
 */
export async function revertUploadQueueIfWatcherOffline(
  opts: {
    instrumentId: string;
    watcherId: string;
    reason: UploadRevertReason;
  },
  executor: DbExecutor = db
): Promise<number> {
  if (await instrumentHasOnlineWatcher(opts.instrumentId, executor)) {
    return 0;
  }

  const revertedIds = await revertPendingUploadRequests(
    opts.instrumentId,
    executor
  );
  if (revertedIds.length === 0) {
    return 0;
  }

  // Reuse existing enum values to avoid a migration: intentional teardowns map
  // to `watcher_stopped`, the unattended sweep to `error`. `kind`/`reason` in
  // details let callers treat them uniformly (mirrors the config-route revert).
  const eventType: "watcher_stopped" | "error" =
    opts.reason === "watcher_offline_sweep" ? "error" : "watcher_stopped";

  await executor.insert(watcherEvents).values({
    watcherId: opts.watcherId,
    eventType,
    message: `Reverted ${revertedIds.length} pending upload request(s) — no online watcher to upload them`,
    details: {
      kind: "upload_requests_cancelled",
      reason: opts.reason,
      cancelled_count: revertedIds.length,
    },
    timestamp: new Date(),
  });

  return revertedIds.length;
}

/**
 * Soft-deletes a resolved watcher and reverts its instrument's upload queue.
 * Shared by the watcher DELETE route and instrument retirement so both
 * teardown paths behave identically. Returns the `deleted_at` timestamp.
 */
export async function deregisterWatcherRow(
  watcher: { id: string; instrumentId: string },
  reason: UploadRevertReason,
  // The acting session/PAT user, recorded on the row for the "Deregistered by"
  // display. Null only when no caller identity is available.
  actorId: string | null,
  executor: DbExecutor = db
): Promise<Date> {
  const now = new Date();
  await executor
    .update(watchers)
    .set({ deletedAt: now, deregisteredBy: actorId })
    .where(eq(watchers.id, watcher.id));

  // Must run after the soft-delete so the helper's online check excludes this
  // watcher; otherwise a deregistered instrument's queue would sit undrained.
  await revertUploadQueueIfWatcherOffline(
    {
      instrumentId: watcher.instrumentId,
      watcherId: watcher.id,
      reason,
    },
    executor
  );

  return now;
}

/**
 * Deregisters every active watcher attached to an instrument (on retire).
 * Accepts an `executor` so the caller can run it inside the same transaction
 * as the status flip, keeping retirement atomic.
 */
export async function deregisterInstrumentWatchers(
  instrumentId: string,
  actorId: string | null,
  executor: DbExecutor = db
): Promise<number> {
  const active = await executor
    .select({ id: watchers.id, instrumentId: watchers.instrumentId })
    .from(watchers)
    .where(
      and(eq(watchers.instrumentId, instrumentId), isNull(watchers.deletedAt))
    );

  for (const watcher of active) {
    await deregisterWatcherRow(
      watcher,
      "instrument_retired",
      actorId,
      executor
    );
  }

  return active.length;
}

interface WatcherLike {
  lastHeartbeatAt: Date | null;
  status: string;
}

export type EffectiveStatus = "registered" | "watching" | "stopped" | "stale";

/**
 * Derives the display status from stored status + heartbeat recency.
 * "stale" is never stored in the DB — it's a virtual status computed here.
 * Watchers in "registered" state haven't sent their first heartbeat yet,
 * so they're exempt from staleness checks.
 */
export function computeEffectiveStatus(watcher: WatcherLike): EffectiveStatus {
  if (watcher.status === "registered") {
    return "registered";
  }

  if (!watcher.lastHeartbeatAt) {
    return "stale";
  }

  const age = Date.now() - watcher.lastHeartbeatAt.getTime();
  return age > STALE_THRESHOLD_MS
    ? "stale"
    : (watcher.status as EffectiveStatus);
}

// ---------------------------------------------------------------------------
// List page
// ---------------------------------------------------------------------------

export interface WatcherListItem {
  createdAt: Date;
  deletedAt: Date | null;
  effectiveStatus: EffectiveStatus;
  hostname: string | null;
  id: string;
  instrumentDisplayName: string | null;
  instrumentId: string;
  lastHeartbeatAt: Date | null;
  watcherVersion: string | null;
}

// Fetches all watchers (optionally including soft-deleted ones) with their
// parent instrument's display name. The total count is small enough that we
// fetch everything and partition active vs deregistered in JS on the server.
export async function getWatcherList(opts: {
  includeDeleted: boolean;
}): Promise<WatcherListItem[]> {
  const conditions = opts.includeDeleted ? [] : [isNull(watchers.deletedAt)];

  const rows = await db
    .select({
      id: watchers.id,
      instrumentId: watchers.instrumentId,
      instrumentDisplayName: instruments.displayName,
      hostname: watchers.hostname,
      watcherVersion: watchers.watcherVersion,
      status: watchers.status,
      lastHeartbeatAt: watchers.lastHeartbeatAt,
      createdAt: watchers.createdAt,
      deletedAt: watchers.deletedAt,
    })
    .from(watchers)
    .leftJoin(instruments, eq(instruments.id, watchers.instrumentId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(watchers.createdAt));

  return rows.map((row) => ({
    id: row.id,
    instrumentId: row.instrumentId,
    instrumentDisplayName: row.instrumentDisplayName,
    hostname: row.hostname,
    watcherVersion: row.watcherVersion,
    // Deregistered watchers always show as "stopped" regardless of their
    // last DB status — they can no longer heartbeat so staleness is moot.
    effectiveStatus: row.deletedAt ? "stopped" : computeEffectiveStatus(row),
    lastHeartbeatAt: row.lastHeartbeatAt,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  }));
}

// ---------------------------------------------------------------------------
// Detail page
// ---------------------------------------------------------------------------

export type WatcherDetail = WatcherListItem & {
  osInfo: string | null;
  configYaml: string | null;
  configChecksum: string | null;
  updatedAt: Date;
  /** Who deregistered the watcher; null when live or unknown. */
  deregisteredByUser: ActorUser | null;
};

// React.cache() deduplicates calls within a single request — used by both
// generateMetadata (for the page title) and the page body (for rendering).
export const getWatcherById = cache(async function getWatcherById(
  watcherId: string
): Promise<WatcherDetail | null> {
  const [row] = await db
    .select({
      id: watchers.id,
      instrumentId: watchers.instrumentId,
      instrumentDisplayName: instruments.displayName,
      hostname: watchers.hostname,
      osInfo: watchers.osInfo,
      watcherVersion: watchers.watcherVersion,
      status: watchers.status,
      lastHeartbeatAt: watchers.lastHeartbeatAt,
      configYaml: watchers.configYaml,
      configChecksum: watchers.configChecksum,
      createdAt: watchers.createdAt,
      updatedAt: watchers.updatedAt,
      deletedAt: watchers.deletedAt,
      deregisteredBy: watchers.deregisteredBy,
      deregisteredByName: users.name,
      deregisteredByEmail: users.email,
      deregisteredByImage: users.image,
    })
    .from(watchers)
    .leftJoin(instruments, eq(instruments.id, watchers.instrumentId))
    // Resolve the actor who deregistered the watcher for display; all NULL
    // when live or deregistered before `deregistered_by` existed.
    .leftJoin(users, eq(users.id, watchers.deregisteredBy))
    // No deletedAt filter — the detail page renders deregistered watchers too,
    // with muted styling and historical data still visible.
    .where(eq(watchers.id, watcherId))
    .limit(1);

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    instrumentId: row.instrumentId,
    instrumentDisplayName: row.instrumentDisplayName,
    hostname: row.hostname,
    osInfo: row.osInfo,
    watcherVersion: row.watcherVersion,
    effectiveStatus: row.deletedAt ? "stopped" : computeEffectiveStatus(row),
    lastHeartbeatAt: row.lastHeartbeatAt,
    configYaml: row.configYaml,
    configChecksum: row.configChecksum,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    deregisteredByUser: resolveActorUser({
      userId: row.deregisteredBy,
      name: row.deregisteredByName,
      email: row.deregisteredByEmail,
      image: row.deregisteredByImage,
    }),
  };
});

// ---------------------------------------------------------------------------
// Heartbeats
// ---------------------------------------------------------------------------

export interface WatcherHeartbeatRow {
  errorsSinceLast: number | null;
  filesUploadedSinceLast: number | null;
  id: number;
  runsReportedSinceLast: number | null;
  status: string;
  timestamp: Date;
  uploadMode: string | null;
  uptimeSeconds: number | null;
}

// Default time window for heartbeat/event queries when no explicit range is
// given. Kept in the data layer (not the page component) to avoid calling
// Date.now() during server component render, which the React purity lint
// rule forbids.
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export const WATCHER_PAGE_SIZE = 20;

export interface PaginatedResult<T> {
  rows: T[];
  total: number;
}

export async function getWatcherHeartbeats(
  watcherId: string,
  opts: { since?: Date; page?: number; pageSize?: number } = {}
): Promise<PaginatedResult<WatcherHeartbeatRow>> {
  const pageSize = opts.pageSize ?? WATCHER_PAGE_SIZE;
  const page = Math.max(1, opts.page ?? 1);
  const offset = (page - 1) * pageSize;
  const since = opts.since ?? new Date(Date.now() - DEFAULT_LOOKBACK_MS);
  const conditions = [
    eq(watcherHeartbeats.watcherId, watcherId),
    gte(watcherHeartbeats.timestamp, since),
  ];

  const [rows, [{ value: total }]] = await Promise.all([
    db
      .select({
        id: watcherHeartbeats.id,
        timestamp: watcherHeartbeats.timestamp,
        status: watcherHeartbeats.status,
        uploadMode: watcherHeartbeats.uploadMode,
        filesUploadedSinceLast: watcherHeartbeats.filesUploadedSinceLast,
        runsReportedSinceLast: watcherHeartbeats.runsReportedSinceLast,
        errorsSinceLast: watcherHeartbeats.errorsSinceLast,
        uptimeSeconds: watcherHeartbeats.uptimeSeconds,
      })
      .from(watcherHeartbeats)
      .where(and(...conditions))
      .orderBy(desc(watcherHeartbeats.timestamp))
      .limit(pageSize)
      .offset(offset),
    db
      .select({ value: count() })
      .from(watcherHeartbeats)
      .where(and(...conditions)),
  ]);

  return { rows, total };
}

export async function getAllWatcherHeartbeats(
  watcherId: string,
  opts: { since?: Date } = {}
): Promise<WatcherHeartbeatRow[]> {
  const since = opts.since ?? new Date(Date.now() - DEFAULT_LOOKBACK_MS);

  return await db
    .select({
      id: watcherHeartbeats.id,
      timestamp: watcherHeartbeats.timestamp,
      status: watcherHeartbeats.status,
      uploadMode: watcherHeartbeats.uploadMode,
      filesUploadedSinceLast: watcherHeartbeats.filesUploadedSinceLast,
      runsReportedSinceLast: watcherHeartbeats.runsReportedSinceLast,
      errorsSinceLast: watcherHeartbeats.errorsSinceLast,
      uptimeSeconds: watcherHeartbeats.uptimeSeconds,
    })
    .from(watcherHeartbeats)
    .where(
      and(
        eq(watcherHeartbeats.watcherId, watcherId),
        gte(watcherHeartbeats.timestamp, since)
      )
    )
    .orderBy(asc(watcherHeartbeats.timestamp))
    .limit(5000);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface WatcherEventRow {
  details: unknown;
  eventType: string;
  id: number;
  message: string;
  timestamp: Date;
}

export async function getWatcherEvents(
  watcherId: string,
  opts: {
    since?: Date;
    eventTypes?: string[];
    page?: number;
    pageSize?: number;
  } = {}
): Promise<PaginatedResult<WatcherEventRow>> {
  const pageSize = opts.pageSize ?? WATCHER_PAGE_SIZE;
  const page = Math.max(1, opts.page ?? 1);
  const offset = (page - 1) * pageSize;
  const since = opts.since ?? new Date(Date.now() - DEFAULT_LOOKBACK_MS);
  const conditions = [
    eq(watcherEvents.watcherId, watcherId),
    gte(watcherEvents.timestamp, since),
  ];
  // URL params arrive as plain strings — validate against the Drizzle enum
  // values so the inArray query is type-safe and ignores bogus filter values.
  if (opts.eventTypes && opts.eventTypes.length > 0) {
    const validTypes = watcherEventTypeEnum.enumValues;
    const filtered = opts.eventTypes.filter(
      (t): t is (typeof validTypes)[number] =>
        (validTypes as readonly string[]).includes(t)
    );
    if (filtered.length > 0) {
      conditions.push(inArray(watcherEvents.eventType, filtered));
    }
  }

  const [rows, [{ value: total }]] = await Promise.all([
    db
      .select({
        id: watcherEvents.id,
        eventType: watcherEvents.eventType,
        message: watcherEvents.message,
        details: watcherEvents.details,
        timestamp: watcherEvents.timestamp,
      })
      .from(watcherEvents)
      .where(and(...conditions))
      .orderBy(desc(watcherEvents.timestamp))
      .limit(pageSize)
      .offset(offset),
    db
      .select({ value: count() })
      .from(watcherEvents)
      .where(and(...conditions)),
  ]);

  return { rows, total };
}
