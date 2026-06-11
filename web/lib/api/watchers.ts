import { db } from "@/lib/db";
import {
  files,
  instrumentRuns,
  instruments,
  watcherEventTypeEnum,
  watcherEvents,
  watcherHeartbeats,
  watchers,
} from "@/lib/db/schema";
import { and, asc, count, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { cache } from "react";
import YAML from "yaml";

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
 * Extracts `instrument.watch_directory` from a watcher's stored config YAML.
 * Returns null when the YAML is missing or unparseable. Mirrors the
 * `extractFilePatterns` helper in `lib/api/instruments.ts`.
 */
export function extractWatchDirectory(
  configYaml: string | null
): string | null {
  if (!configYaml) return null;
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
 * new one and the watcher would otherwise re-error on each heartbeat poll
 * (ENG-1397). Returns the reverted file ids (for event reporting).
 */
export async function revertPendingUploadRequests(
  instrumentId: string
): Promise<number[]> {
  const reverted = await db
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

type WatcherLike = {
  status: string;
  lastHeartbeatAt: Date | null;
};

export type EffectiveStatus = "registered" | "watching" | "stopped" | "stale";

/**
 * Derives the display status from stored status + heartbeat recency.
 * "stale" is never stored in the DB — it's a virtual status computed here.
 * Watchers in "registered" state haven't sent their first heartbeat yet,
 * so they're exempt from staleness checks.
 */
export function computeEffectiveStatus(watcher: WatcherLike): EffectiveStatus {
  if (watcher.status === "registered") return "registered";

  if (!watcher.lastHeartbeatAt) return "stale";

  const age = Date.now() - watcher.lastHeartbeatAt.getTime();
  return age > STALE_THRESHOLD_MS
    ? "stale"
    : (watcher.status as EffectiveStatus);
}

// ---------------------------------------------------------------------------
// List page
// ---------------------------------------------------------------------------

export type WatcherListItem = {
  id: string;
  instrumentId: string;
  instrumentDisplayName: string | null;
  hostname: string | null;
  watcherVersion: string | null;
  effectiveStatus: EffectiveStatus;
  lastHeartbeatAt: Date | null;
  createdAt: Date;
  deletedAt: Date | null;
};

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
    })
    .from(watchers)
    .leftJoin(instruments, eq(instruments.id, watchers.instrumentId))
    // No deletedAt filter — the detail page renders deregistered watchers too,
    // with muted styling and historical data still visible.
    .where(eq(watchers.id, watcherId))
    .limit(1);

  if (!row) return null;

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
  };
});

// ---------------------------------------------------------------------------
// Heartbeats
// ---------------------------------------------------------------------------

export type WatcherHeartbeatRow = {
  id: number;
  timestamp: Date;
  status: string;
  uploadMode: string | null;
  filesUploadedSinceLast: number | null;
  runsReportedSinceLast: number | null;
  errorsSinceLast: number | null;
  uptimeSeconds: number | null;
};

// Default time window for heartbeat/event queries when no explicit range is
// given. Kept in the data layer (not the page component) to avoid calling
// Date.now() during server component render, which the React purity lint
// rule forbids.
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export const WATCHER_PAGE_SIZE = 20;

export type PaginatedResult<T> = { rows: T[]; total: number };

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

  return db
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

export type WatcherEventRow = {
  id: number;
  eventType: string;
  message: string;
  details: unknown;
  timestamp: Date;
};

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
