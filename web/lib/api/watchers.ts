import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { cache } from "react";
import {
  type Actor,
  type ActorRef,
  actorColumns,
  resolveActor,
} from "@/lib/api/actor";
import type { AuthResult } from "@/lib/api/auth";
import { apiError, FORBIDDEN } from "@/lib/api/errors";
import { instrumentHasOnlineWatcher } from "@/lib/api/instruments";
import { touchRuns } from "@/lib/api/touch-runs";
import {
  decideWatcherBinding,
  isBoundToOtherToken,
} from "@/lib/api/watcher-binding";
import type { ConfigRevisionStatus } from "@/lib/api/watcher-config/revisions";
import {
  isRestartStopReason,
  RESTART_STOP_REASONS,
  UPLOAD_REQUEST_REVERT_GRACE_MS,
} from "@/lib/api/watcher-status";
import { type DbExecutor, db } from "@/lib/db";
import {
  files,
  instrumentRuns,
  instruments,
  personalAccessTokens,
  users,
  watcherConfigRevisions,
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
 * registered PAT. A null binding, or a binding to a revoked token, is claimed
 * trust-on-first-use (atomic), then enforced thereafter.
 */
export async function enforceWatcherBinding(
  authResult: AuthResult,
  watcher: { id: string; registeredByToken: string | null }
): Promise<Response | null> {
  const verdict = decideWatcherBinding(authResult, watcher.registeredByToken);

  if (verdict === "allow") {
    return null;
  }

  // Revoking a token clears its bindings, but a request that authenticated
  // just before the revoke can still bind afterwards. So a binding to a
  // revoked token counts as no binding. Only a token bound elsewhere gets
  // this second look, which keeps the common allow path free of extra queries.
  const claimable =
    verdict === "tofu" ||
    isBoundToOtherToken(authResult, watcher.registeredByToken);
  const tokenId = authResult.tokenId;
  if (!(claimable && tokenId)) {
    return apiError(403, FORBIDDEN, "Token is not authorized for this watcher");
  }

  // TOFU: first token to check in claims the row. The `where` clause makes
  // concurrent claims atomic: the loser re-reads and is denied.
  const claimed = await db
    .update(watchers)
    .set({ registeredByToken: tokenId })
    .where(
      and(
        eq(watchers.id, watcher.id),
        or(
          isNull(watchers.registeredByToken),
          inArray(
            watchers.registeredByToken,
            db
              .select({ id: personalAccessTokens.id })
              .from(personalAccessTokens)
              .where(isNotNull(personalAccessTokens.revokedAt))
          )
        )
      )
    )
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
    .returning({ id: files.id, instrumentRunId: files.instrumentRunId });
  await touchRuns(
    reverted.map((row) => row.instrumentRunId),
    executor
  );
  return reverted.map((row) => row.id);
}

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
  // The acting person or token, recorded on the row for the "Deregistered by"
  // display. Null only when no caller identity is available.
  actor: ActorRef | null,
  executor: DbExecutor = db
): Promise<Date> {
  const now = new Date();
  const { userId, tokenId } = actorColumns(actor);
  await executor
    .update(watchers)
    .set({
      deletedAt: now,
      deregisteredBy: userId,
      deregisteredByToken: tokenId,
    })
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
  actor: ActorRef | null,
  executor: DbExecutor = db
): Promise<number> {
  const active = await executor
    .select({ id: watchers.id, instrumentId: watchers.instrumentId })
    .from(watchers)
    .where(
      and(eq(watchers.instrumentId, instrumentId), isNull(watchers.deletedAt))
    );

  for (const watcher of active) {
    await deregisterWatcherRow(watcher, "instrument_retired", actor, executor);
  }

  return active.length;
}

interface WatcherLike {
  lastHeartbeatAt: Date | null;
  status: string;
  /** Why the watcher is `waiting`, or why it `stopped` for a restart. */
  statusReason: string | null;
}

export type EffectiveStatus =
  | "registered"
  | "watching"
  | "stopped"
  | "waiting"
  | "stale";

/**
 * Derives the display status from stored status, stop reason, and heartbeat
 * recency. "stale" is never stored in the DB: it's a virtual status computed
 * here, and `effectiveStatusCondition` below must agree with it.
 *
 * - `registered`: no heartbeat yet, so it is exempt from staleness checks.
 * - `watching` and `waiting`: `stale` once the last heartbeat is more than
 *   `STALE_THRESHOLD_MS` old, or missing.
 * - `stopped` for a restart (see `RESTART_STOP_REASONS`): the watcher is
 *   expected back, so it reads `stale` once the last heartbeat is more than
 *   `UPLOAD_REQUEST_REVERT_GRACE_MS` old, or missing.
 * - Any other `stopped`: always `stopped`. The watcher said it was stopping,
 *   so it can't send another heartbeat and its silence is not a fault.
 */
export function computeEffectiveStatus(
  watcher: WatcherLike,
  now: Date = new Date()
): EffectiveStatus {
  if (watcher.status === "registered") {
    return "registered";
  }

  const age = watcher.lastHeartbeatAt
    ? now.getTime() - watcher.lastHeartbeatAt.getTime()
    : Number.POSITIVE_INFINITY;

  if (watcher.status === "stopped") {
    const expectedBack = isRestartStopReason(watcher.statusReason);
    return expectedBack && age > UPLOAD_REQUEST_REVERT_GRACE_MS
      ? "stale"
      : "stopped";
  }

  return age > STALE_THRESHOLD_MS
    ? "stale"
    : (watcher.status as EffectiveStatus);
}

/**
 * The SQL condition that selects the watchers whose `computeEffectiveStatus`
 * is `status`, for list filters. It uses the same thresholds as that function,
 * and each watcher row satisfies the condition of exactly one status.
 * `now` is the moment the thresholds count back from.
 */
export function effectiveStatusCondition(
  status: EffectiveStatus,
  now: Date = new Date()
): SQL {
  const heartbeat = watchers.lastHeartbeatAt;
  const staleBefore = new Date(now.getTime() - STALE_THRESHOLD_MS);
  const restartStaleBefore = new Date(
    now.getTime() - UPLOAD_REQUEST_REVERT_GRACE_MS
  );
  const restartReasons = sql.join(
    RESTART_STOP_REASONS.map((reason) => sql`${reason}`),
    sql`, `
  );

  switch (status) {
    case "registered":
      return sql`${watchers.status} = 'registered'`;
    case "watching":
      return sql`(${watchers.status} = 'watching' and ${heartbeat} >= ${staleBefore})`;
    case "waiting":
      return sql`(${watchers.status} = 'waiting' and ${heartbeat} >= ${staleBefore})`;
    case "stopped":
      // `status_reason` is checked for NULL first, because `NULL not in (...)`
      // is NULL, not true, and a plain stop has no reason.
      return sql`(${watchers.status} = 'stopped' and (${watchers.statusReason} is null or ${watchers.statusReason} not in (${restartReasons}) or ${heartbeat} >= ${restartStaleBefore}))`;
    case "stale":
      return sql`((${watchers.status} in ('watching', 'waiting') and (${heartbeat} is null or ${heartbeat} < ${staleBefore})) or (${watchers.status} = 'stopped' and ${watchers.statusReason} in (${restartReasons}) and (${heartbeat} is null or ${heartbeat} < ${restartStaleBefore})))`;
    default:
      return status satisfies never;
  }
}

// ---------------------------------------------------------------------------
// List page
// ---------------------------------------------------------------------------

export interface WatcherListItem {
  appliedConfigRevision: number | null;
  configRevision: number | null;
  /** Status of the current config revision, for the list badges. */
  configRevisionStatus: ConfigRevisionStatus | null;
  createdAt: Date;
  deletedAt: Date | null;
  effectiveStatus: EffectiveStatus;
  hostname: string | null;
  id: string;
  instrumentDisplayName: string | null;
  instrumentId: string;
  lastHeartbeatAt: Date | null;
  /**
   * True when the newest change is a PC edit the running watcher hasn't
   * loaded: it takes effect when the watcher restarts (see
   * `pickRestartPending` in `watcher-config/revisions.ts`).
   */
  pcEditAwaitingRestart: boolean;
  /**
   * Why the watcher is waiting, or why it stopped for a restart (one of
   * `RESTART_STOP_REASONS`); null otherwise.
   */
  statusReason: string | null;
  watcherVersion: string | null;
}

// Status of the watcher's current config revision: the newest one that
// wasn't superseded. A pending change can sit below a higher superseded PC
// edit (when Data Hub wins an offline conflict), so this skips superseded
// rows rather than reading the highest revision.
const currentRevisionStatus = sql<ConfigRevisionStatus | null>`(
  select ${watcherConfigRevisions.status}
  from ${watcherConfigRevisions}
  where ${watcherConfigRevisions.watcherId} = ${watchers.id}
    and ${watcherConfigRevisions.status} <> 'superseded'
  order by ${watcherConfigRevisions.revision} desc
  limit 1
)`;

// Same rule as `pickRestartPending`: the newest pending or applied revision
// is an applied PC edit newer than the revision the watcher reports running.
// False when the watcher hasn't reported one.
const pcEditAwaitingRestart = sql<boolean>`coalesce((
  select ${watcherConfigRevisions.status} = 'applied'
    and ${watcherConfigRevisions.source} = 'pc'
    and ${watcherConfigRevisions.revision} > ${watchers.appliedConfigRevision}
  from ${watcherConfigRevisions}
  where ${watcherConfigRevisions.watcherId} = ${watchers.id}
    and ${watcherConfigRevisions.status} in ('pending', 'applied')
  order by ${watcherConfigRevisions.revision} desc
  limit 1
), false)`;

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
      statusReason: watchers.statusReason,
      configRevision: watchers.configRevision,
      appliedConfigRevision: watchers.appliedConfigRevision,
      configRevisionStatus: currentRevisionStatus,
      pcEditAwaitingRestart,
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
    statusReason: row.statusReason,
    configRevision: row.configRevision,
    appliedConfigRevision: row.appliedConfigRevision,
    configRevisionStatus: row.configRevisionStatus,
    pcEditAwaitingRestart: row.pcEditAwaitingRestart,
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
  deregisteredBy: Actor | null;
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
      statusReason: watchers.statusReason,
      configRevision: watchers.configRevision,
      appliedConfigRevision: watchers.appliedConfigRevision,
      configRevisionStatus: currentRevisionStatus,
      pcEditAwaitingRestart,
      lastHeartbeatAt: watchers.lastHeartbeatAt,
      configYaml: watchers.configYaml,
      configChecksum: watchers.configChecksum,
      createdAt: watchers.createdAt,
      updatedAt: watchers.updatedAt,
      deletedAt: watchers.deletedAt,
      deregisteredByUserId: watchers.deregisteredBy,
      deregisteredByTokenId: watchers.deregisteredByToken,
      deregisteredByName: users.name,
      deregisteredByEmail: users.email,
      deregisteredByImage: users.image,
      deregisteredByTokenName: personalAccessTokens.name,
      deregisteredByTokenRevokedAt: personalAccessTokens.revokedAt,
    })
    .from(watchers)
    .leftJoin(instruments, eq(instruments.id, watchers.instrumentId))
    // Resolve the actor who deregistered the watcher for display; all NULL
    // when live or deregistered before `deregistered_by` existed.
    .leftJoin(users, eq(users.id, watchers.deregisteredBy))
    .leftJoin(
      personalAccessTokens,
      eq(personalAccessTokens.id, watchers.deregisteredByToken)
    )
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
    statusReason: row.statusReason,
    configRevision: row.configRevision,
    appliedConfigRevision: row.appliedConfigRevision,
    configRevisionStatus: row.configRevisionStatus,
    pcEditAwaitingRestart: row.pcEditAwaitingRestart,
    lastHeartbeatAt: row.lastHeartbeatAt,
    configYaml: row.configYaml,
    configChecksum: row.configChecksum,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    deregisteredBy: resolveActor({
      userId: row.deregisteredByUserId,
      userName: row.deregisteredByName,
      userEmail: row.deregisteredByEmail,
      userImage: row.deregisteredByImage,
      tokenId: row.deregisteredByTokenId,
      tokenName: row.deregisteredByTokenName,
      tokenRevokedAt: row.deregisteredByTokenRevokedAt,
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
