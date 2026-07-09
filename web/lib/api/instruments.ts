import { and, count, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { cache } from "react";
import YAML from "yaml";
import { type DbExecutor, db } from "@/lib/db";
import {
  type InstrumentType,
  instrumentRuns,
  instruments,
  watchers,
} from "@/lib/db/schema";

export interface InstrumentListItem {
  createdAt: Date;
  displayName: string;
  filePatterns: string[];
  /**
   * True when the instrument has a deregistered watcher. With
   * `watcherCount === 0`, distinguishes "Deregistered" from "No Watcher".
   */
  hasDeregisteredWatcher: boolean;
  id: string;
  instrumentType: InstrumentType;
  lastRunAt: Date | null;
  /** Most recent heartbeat from any watcher attached to this instrument. */
  lastWatcherHeartbeatAt: Date | null;
  runCount: number;
  runsThisWeek: number;
  status: "pending" | "active" | "inactive";
  watcherCount: number;
  watchersOnline: number;
}

// A watcher is stale when its last heartbeat is older than this threshold,
// even if its DB status is "watching". Must match the window in dashboard.ts.
const HEARTBEAT_STALE_MINUTES = 5;

/**
 * Returns true when the instrument has at least one watcher that is actively
 * heartbeating (status "watching" with a heartbeat inside the staleness
 * window). Uploads transfer through the watcher agent, so the upload-request
 * routes use this to reject queueing when no watcher could pick the files up —
 * otherwise files sit in `upload_requested` forever and the UI shows a
 * perpetual "Uploading" spinner with no error.
 */
export async function instrumentHasOnlineWatcher(
  instrumentId: string,
  executor: DbExecutor = db
): Promise<boolean> {
  const staleThreshold = new Date(
    Date.now() - HEARTBEAT_STALE_MINUTES * 60 * 1000
  );

  const [row] = await executor
    .select({ value: count() })
    .from(watchers)
    .where(
      and(
        eq(watchers.instrumentId, instrumentId),
        isNull(watchers.deletedAt),
        eq(watchers.status, "watching"),
        gt(watchers.lastHeartbeatAt, staleThreshold)
      )
    );

  return (row?.value ?? 0) > 0;
}

/**
 * Extracts `instrument.file_patterns` from a watcher's stored config YAML.
 * Returns an empty array when the YAML is missing or unparseable.
 */
function extractFilePatterns(configYaml: string | null): string[] {
  if (!configYaml) {
    return [];
  }
  try {
    const doc = YAML.parse(configYaml);
    const patterns = doc?.instrument?.file_patterns;
    if (Array.isArray(patterns)) {
      return patterns.map(String);
    }
  } catch {
    // Malformed YAML — silently ignore.
  }
  return [];
}

/**
 * Deduplicates and merges file patterns from all watcher configs for an
 * instrument. When multiple watchers exist, patterns are unioned.
 */
function mergeFilePatterns(configs: (string | null)[]): string[] {
  const set = new Set<string>();
  for (const yaml of configs) {
    for (const p of extractFilePatterns(yaml)) {
      set.add(p);
    }
  }
  return [...set].sort();
}

// Pre-aggregated sub-select builders used by both the full list and the
// focused dashboard query. Inlined helpers (rather than module-level
// constants) so each caller gets a fresh drizzle alias and the queries can
// be composed independently.
function buildRunCountSubquery() {
  // `runsThisWeek` and `lastRunAt` are anchored to the run's true
  // acquisition time when known so backfilled runs (where created_at is
  // "today" but the data is older) don't pollute the recent-runs window
  // or get reported as the most recent activity. Falls back to created_at
  // for Lambda-only and pre-backfill runs where acquired_at is NULL.
  return db
    .select({
      instrumentId: instrumentRuns.instrumentId,
      count: sql<number>`cast(count(*) as int)`.as("run_count"),
      countThisWeek:
        sql<number>`cast(count(*) filter (where coalesce(${instrumentRuns.acquiredAt}, ${instrumentRuns.createdAt}) > now() - interval '7 days') as int)`.as(
          "run_count_this_week"
        ),
      lastRunAt:
        sql<Date | null>`max(coalesce(${instrumentRuns.acquiredAt}, ${instrumentRuns.createdAt}))`.as(
          "last_run_at"
        ),
    })
    .from(instrumentRuns)
    .where(isNull(instrumentRuns.deletedAt))
    .groupBy(instrumentRuns.instrumentId)
    .as("run_counts");
}

function buildWatcherCountSubquery() {
  // No `deleted_at` filter so instruments whose only watcher was deregistered
  // still appear; the per-column `filter (...)` clauses keep live counts live
  // while also exposing a deregistered tally.
  return db
    .select({
      instrumentId: watchers.instrumentId,
      count:
        sql<number>`cast(count(*) filter (where ${watchers.deletedAt} is null) as int)`.as(
          "watcher_count"
        ),
      online:
        sql<number>`cast(count(*) filter (where ${watchers.status} = 'watching' and ${watchers.lastHeartbeatAt} > now() - interval '${sql.raw(String(HEARTBEAT_STALE_MINUTES))} minutes' and ${watchers.deletedAt} is null) as int)`.as(
          "online_count"
        ),
      deregistered:
        sql<number>`cast(count(*) filter (where ${watchers.deletedAt} is not null) as int)`.as(
          "deregistered_count"
        ),
      lastHeartbeatAt:
        sql<Date | null>`max(${watchers.lastHeartbeatAt}) filter (where ${watchers.deletedAt} is null)`.as(
          "last_heartbeat_at"
        ),
    })
    .from(watchers)
    .groupBy(watchers.instrumentId)
    .as("watcher_counts");
}

// Coerces drizzle's raw-sql aggregate output into the InstrumentListItem
// shape callers expect. Aggregates flow through the `sql` template without
// the timestamp parser the column would apply, so we re-wrap dates here.
interface InstrumentListRow {
  createdAt: Date;
  displayName: string;
  id: string;
  instrumentType: InstrumentType;
  lastRunAt: Date | null;
  lastWatcherHeartbeatAt: Date | null;
  runCount: number;
  runsThisWeek: number;
  status: "pending" | "active" | "inactive";
  watcherCount: number;
  watchersDeregistered: number;
  watchersOnline: number;
}

function hydrateInstrumentRow(
  row: InstrumentListRow,
  configsByInstrument: Map<string, (string | null)[]>
): InstrumentListItem {
  const { watchersDeregistered, ...rest } = row;
  return {
    ...rest,
    lastRunAt: row.lastRunAt ? new Date(row.lastRunAt) : null,
    lastWatcherHeartbeatAt: row.lastWatcherHeartbeatAt
      ? new Date(row.lastWatcherHeartbeatAt)
      : null,
    filePatterns: mergeFilePatterns(configsByInstrument.get(row.id) ?? []),
    hasDeregisteredWatcher: watchersDeregistered > 0,
  };
}

function indexConfigsByInstrument(
  rows: { instrumentId: string; configYaml: string | null }[]
): Map<string, (string | null)[]> {
  const configsByInstrument = new Map<string, (string | null)[]>();
  for (const w of rows) {
    const arr = configsByInstrument.get(w.instrumentId) ?? [];
    arr.push(w.configYaml);
    configsByInstrument.set(w.instrumentId, arr);
  }
  return configsByInstrument;
}

// Uses pre-aggregated sub-selects instead of direct joins to avoid row
// multiplication (instruments × runs × watchers would inflate counts).
//
// Wrapped in `cache()` so concurrent server components on the same request
// (e.g. layout + page) share a single result.
export const getInstrumentListWithCounts = cache(
  async function getInstrumentListWithCounts(): Promise<InstrumentListItem[]> {
    const runCountSq = buildRunCountSubquery();
    const watcherCountSq = buildWatcherCountSubquery();

    const [rows, watcherConfigs] = await Promise.all([
      db
        .select({
          id: instruments.id,
          displayName: instruments.displayName,
          status: instruments.status,
          instrumentType: instruments.instrumentType,
          createdAt: instruments.createdAt,
          runCount: sql<number>`coalesce(${runCountSq.count}, 0)`,
          runsThisWeek: sql<number>`coalesce(${runCountSq.countThisWeek}, 0)`,
          lastRunAt: runCountSq.lastRunAt,
          watcherCount: sql<number>`coalesce(${watcherCountSq.count}, 0)`,
          watchersOnline: sql<number>`coalesce(${watcherCountSq.online}, 0)`,
          watchersDeregistered: sql<number>`coalesce(${watcherCountSq.deregistered}, 0)`,
          lastWatcherHeartbeatAt: watcherCountSq.lastHeartbeatAt,
        })
        .from(instruments)
        .leftJoin(runCountSq, eq(runCountSq.instrumentId, instruments.id))
        .leftJoin(
          watcherCountSq,
          eq(watcherCountSq.instrumentId, instruments.id)
        )
        .orderBy(instruments.displayName),
      db
        .select({
          instrumentId: watchers.instrumentId,
          configYaml: watchers.configYaml,
        })
        .from(watchers)
        .where(isNull(watchers.deletedAt)),
    ]);

    const configsByInstrument = indexConfigsByInstrument(watcherConfigs);
    return rows.map((row) => hydrateInstrumentRow(row, configsByInstrument));
  }
);

export interface DashboardInstrumentSummary {
  rows: InstrumentListItem[];
  totalActive: number;
}

/**
 * Focused query for the dashboard's truncated instruments table: pulls only
 * the N most-recently-active instruments and the active total. Avoids
 * loading every instrument just to discard the long tail in JS.
 *
 * Watcher configs are loaded in parallel for the resulting instrument IDs
 * after the row query resolves; this keeps the focused query truly bounded
 * while still avoiding an instruments × watchers join.
 */
export const getRecentActiveInstrumentsForDashboard = cache(
  async function getRecentActiveInstrumentsForDashboard(
    limit: number
  ): Promise<DashboardInstrumentSummary> {
    const runCountSq = buildRunCountSubquery();
    const watcherCountSq = buildWatcherCountSubquery();

    // Row fetch and the active-count run in parallel; they share no data.
    const [rows, totalActiveResult] = await Promise.all([
      db
        .select({
          id: instruments.id,
          displayName: instruments.displayName,
          status: instruments.status,
          instrumentType: instruments.instrumentType,
          createdAt: instruments.createdAt,
          runCount: sql<number>`coalesce(${runCountSq.count}, 0)`,
          runsThisWeek: sql<number>`coalesce(${runCountSq.countThisWeek}, 0)`,
          lastRunAt: runCountSq.lastRunAt,
          watcherCount: sql<number>`coalesce(${watcherCountSq.count}, 0)`,
          watchersOnline: sql<number>`coalesce(${watcherCountSq.online}, 0)`,
          watchersDeregistered: sql<number>`coalesce(${watcherCountSq.deregistered}, 0)`,
          lastWatcherHeartbeatAt: watcherCountSq.lastHeartbeatAt,
        })
        .from(instruments)
        .leftJoin(runCountSq, eq(runCountSq.instrumentId, instruments.id))
        .leftJoin(
          watcherCountSq,
          eq(watcherCountSq.instrumentId, instruments.id)
        )
        .where(eq(instruments.status, "active"))
        // `nulls last` so instruments that have never run sink to the bottom
        // rather than dominating the top with a NULL `lastRunAt`.
        .orderBy(sql`${runCountSq.lastRunAt} desc nulls last`)
        .limit(limit),
      db
        .select({ count: sql<number>`cast(count(*) as int)` })
        .from(instruments)
        .where(eq(instruments.status, "active")),
    ]);

    const totalActive = totalActiveResult[0]?.count ?? 0;

    if (rows.length === 0) {
      return { rows: [], totalActive };
    }

    // Configs only for the selected instruments — bounded by `limit` rather
    // than by total fleet size.
    const instrumentIds = rows.map((r) => r.id);
    const watcherConfigs = await db
      .select({
        instrumentId: watchers.instrumentId,
        configYaml: watchers.configYaml,
      })
      .from(watchers)
      .where(
        and(
          isNull(watchers.deletedAt),
          inArray(watchers.instrumentId, instrumentIds)
        )
      );

    const configsByInstrument = indexConfigsByInstrument(watcherConfigs);
    return {
      rows: rows.map((row) => hydrateInstrumentRow(row, configsByInstrument)),
      totalActive,
    };
  }
);

export interface InstrumentDetail {
  /**
   * True when `activeWatcherId` is a deregistered watcher (no live one
   * remains). Lets the header distinguish "was deregistered" from "never had
   * a watcher".
   */
  activeWatcherDeregistered: boolean;
  /** Desktop hostname of the canonical watcher, if any. */
  activeWatcherHostname: string | null;
  /**
   * The "canonical" watcher for the header: the most recently heartbeating
   * live watcher, else the earliest by `createdAt`. When no live watcher
   * remains, falls back to the most recently deregistered one so the header
   * can still link to it (counts below stay based on live watchers).
   */
  activeWatcherId: string | null;
  createdAt: Date;
  displayName: string;
  filePatterns: string[];
  id: string;
  instrumentType: InstrumentType;
  /** Most recent heartbeat from any watcher attached to this instrument. */
  lastWatcherHeartbeatAt: Date | null;
  runCount: number;
  status: "pending" | "active" | "inactive";
  updatedAt: Date;
  watcherCount: number;
  watchersOffline: number;
  watchersOnline: number;
}

export const getInstrumentById = cache(async function getInstrumentById(
  instrumentId: string
): Promise<InstrumentDetail | null> {
  const [instrument] = await db
    .select()
    .from(instruments)
    .where(eq(instruments.id, instrumentId))
    .limit(1);

  if (!instrument) {
    return null;
  }

  const [runCountResult, allWatcherRows] = await Promise.all([
    db
      .select({ value: count() })
      .from(instrumentRuns)
      .where(
        and(
          eq(instrumentRuns.instrumentId, instrumentId),
          isNull(instrumentRuns.deletedAt)
        )
      ),
    db
      .select({
        id: watchers.id,
        hostname: watchers.hostname,
        status: watchers.status,
        lastHeartbeatAt: watchers.lastHeartbeatAt,
        createdAt: watchers.createdAt,
        configYaml: watchers.configYaml,
        deletedAt: watchers.deletedAt,
      })
      .from(watchers)
      .where(eq(watchers.instrumentId, instrumentId)),
  ]);

  // Counts and roll-ups use live watchers only; deregistered rows are kept
  // just to resolve the canonical watcher link below.
  const watcherRows = allWatcherRows.filter((w) => w.deletedAt === null);

  const staleThreshold = new Date(
    Date.now() - HEARTBEAT_STALE_MINUTES * 60 * 1000
  );

  let watchersOnline = 0;
  let watchersOffline = 0;
  let lastWatcherHeartbeatAt: Date | null = null;
  for (const w of watcherRows) {
    const isOnline =
      w.status === "watching" &&
      w.lastHeartbeatAt &&
      w.lastHeartbeatAt > staleThreshold;
    if (isOnline) {
      watchersOnline++;
    } else {
      watchersOffline++;
    }
    if (
      w.lastHeartbeatAt &&
      (!lastWatcherHeartbeatAt || w.lastHeartbeatAt > lastWatcherHeartbeatAt)
    ) {
      lastWatcherHeartbeatAt = w.lastHeartbeatAt;
    }
  }

  // Canonical "active" watcher: the most recently heartbeating one, falling
  // back to the earliest registered when no watcher has ever heartbeated.
  // This keeps `activeWatcherId` aligned with `lastWatcherHeartbeatAt` so
  // downstream UI (the watcher link in the header, status badge route)
  // points at the same row the heartbeat timestamp came from.
  const activeWatcher =
    watcherRows.length === 0
      ? null
      : (watcherRows
          .filter((w) => w.lastHeartbeatAt !== null)
          .sort(
            (a, b) =>
              (b.lastHeartbeatAt?.getTime() ?? 0) -
              (a.lastHeartbeatAt?.getTime() ?? 0)
          )[0] ??
        [...watcherRows].sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
        )[0]);

  // Fall back to the most recently deregistered watcher so the header can
  // still link to it once no live watcher remains (e.g. after retirement).
  const canonicalWatcher =
    activeWatcher ??
    allWatcherRows
      .filter((w) => w.deletedAt !== null)
      .sort(
        (a, b) => (b.deletedAt?.getTime() ?? 0) - (a.deletedAt?.getTime() ?? 0)
      )[0] ??
    null;

  return {
    id: instrument.id,
    displayName: instrument.displayName,
    status: instrument.status,
    instrumentType: instrument.instrumentType,
    filePatterns: mergeFilePatterns(watcherRows.map((w) => w.configYaml)),
    createdAt: instrument.createdAt,
    updatedAt: instrument.updatedAt,
    runCount: runCountResult[0].value,
    watcherCount: watcherRows.length,
    watchersOnline,
    watchersOffline,
    lastWatcherHeartbeatAt,
    activeWatcherId: canonicalWatcher?.id ?? null,
    activeWatcherHostname: canonicalWatcher?.hostname ?? null,
    activeWatcherDeregistered:
      activeWatcher === null && canonicalWatcher !== null,
  };
});
