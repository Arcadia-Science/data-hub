import { db } from "@/lib/db";
import {
  instrumentRuns,
  instruments,
  type InstrumentType,
  watchers,
} from "@/lib/db/schema";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { cache } from "react";
import YAML from "yaml";

export type InstrumentListItem = {
  id: string;
  displayName: string;
  status: "pending" | "active" | "inactive";
  instrumentType: InstrumentType;
  filePatterns: string[];
  runCount: number;
  runsThisWeek: number;
  lastRunAt: Date | null;
  watcherCount: number;
  watchersOnline: number;
  /** Most recent heartbeat from any watcher attached to this instrument. */
  lastWatcherHeartbeatAt: Date | null;
  createdAt: Date;
};

// A watcher is stale when its last heartbeat is older than this threshold,
// even if its DB status is "watching". Must match the window in dashboard.ts.
const HEARTBEAT_STALE_MINUTES = 5;

/**
 * Extracts `instrument.file_patterns` from a watcher's stored config YAML.
 * Returns an empty array when the YAML is missing or unparseable.
 */
function extractFilePatterns(configYaml: string | null): string[] {
  if (!configYaml) return [];
  try {
    const doc = YAML.parse(configYaml);
    const patterns = doc?.instrument?.file_patterns;
    if (Array.isArray(patterns)) return patterns.map(String);
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
    for (const p of extractFilePatterns(yaml)) set.add(p);
  }
  return [...set].sort();
}

// Uses pre-aggregated sub-selects instead of direct joins to avoid row
// multiplication (instruments × runs × watchers would inflate counts).
export async function getInstrumentListWithCounts(): Promise<
  InstrumentListItem[]
> {
  const runCountSq = db
    .select({
      instrumentId: instrumentRuns.instrumentId,
      count: sql<number>`cast(count(*) as int)`.as("run_count"),
      countThisWeek:
        sql<number>`cast(count(*) filter (where ${instrumentRuns.createdAt} > now() - interval '7 days') as int)`.as(
          "run_count_this_week"
        ),
      lastRunAt: sql<Date | null>`max(${instrumentRuns.createdAt})`.as(
        "last_run_at"
      ),
    })
    .from(instrumentRuns)
    .where(isNull(instrumentRuns.deletedAt))
    .groupBy(instrumentRuns.instrumentId)
    .as("run_counts");

  const watcherCountSq = db
    .select({
      instrumentId: watchers.instrumentId,
      count: sql<number>`cast(count(*) as int)`.as("watcher_count"),
      online:
        sql<number>`cast(count(*) filter (where ${watchers.status} = 'watching' and ${watchers.lastHeartbeatAt} > now() - interval '${sql.raw(String(HEARTBEAT_STALE_MINUTES))} minutes') as int)`.as(
          "online_count"
        ),
      lastHeartbeatAt: sql<Date | null>`max(${watchers.lastHeartbeatAt})`.as(
        "last_heartbeat_at"
      ),
    })
    .from(watchers)
    .where(isNull(watchers.deletedAt))
    .groupBy(watchers.instrumentId)
    .as("watcher_counts");

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
        lastWatcherHeartbeatAt: watcherCountSq.lastHeartbeatAt,
      })
      .from(instruments)
      .leftJoin(runCountSq, eq(runCountSq.instrumentId, instruments.id))
      .leftJoin(watcherCountSq, eq(watcherCountSq.instrumentId, instruments.id))
      .orderBy(instruments.displayName),
    db
      .select({
        instrumentId: watchers.instrumentId,
        configYaml: watchers.configYaml,
      })
      .from(watchers)
      .where(isNull(watchers.deletedAt)),
  ]);

  const configsByInstrument = new Map<string, (string | null)[]>();
  for (const w of watcherConfigs) {
    const arr = configsByInstrument.get(w.instrumentId) ?? [];
    arr.push(w.configYaml);
    configsByInstrument.set(w.instrumentId, arr);
  }

  return rows.map((row) => ({
    ...row,
    // Aggregates flow through drizzle's raw `sql` template, which doesn't
    // apply the timestamp parser the column would — coerce to Date so callers
    // can safely call Date methods on the result.
    lastRunAt: row.lastRunAt ? new Date(row.lastRunAt) : null,
    lastWatcherHeartbeatAt: row.lastWatcherHeartbeatAt
      ? new Date(row.lastWatcherHeartbeatAt)
      : null,
    filePatterns: mergeFilePatterns(configsByInstrument.get(row.id) ?? []),
  }));
}

export type InstrumentDetail = {
  id: string;
  displayName: string;
  status: "pending" | "active" | "inactive";
  instrumentType: InstrumentType;
  filePatterns: string[];
  createdAt: Date;
  updatedAt: Date;
  runCount: number;
  watcherCount: number;
  watchersOnline: number;
  watchersOffline: number;
  /** Most recent heartbeat from any watcher attached to this instrument. */
  lastWatcherHeartbeatAt: Date | null;
  activeWatcherId: string | null;
};

export const getInstrumentById = cache(async function getInstrumentById(
  instrumentId: string
): Promise<InstrumentDetail | null> {
  const [instrument] = await db
    .select()
    .from(instruments)
    .where(eq(instruments.id, instrumentId))
    .limit(1);

  if (!instrument) return null;

  const [runCountResult, watcherRows] = await Promise.all([
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
        status: watchers.status,
        lastHeartbeatAt: watchers.lastHeartbeatAt,
        configYaml: watchers.configYaml,
      })
      .from(watchers)
      .where(
        and(eq(watchers.instrumentId, instrumentId), isNull(watchers.deletedAt))
      ),
  ]);

  const staleThreshold = new Date(
    Date.now() - HEARTBEAT_STALE_MINUTES * 60 * 1000
  );

  let watchersOnline = 0;
  let watchersOffline = 0;
  let activeWatcherId: string | null = null;
  let lastWatcherHeartbeatAt: Date | null = null;
  for (const w of watcherRows) {
    const isOnline =
      w.status === "watching" &&
      w.lastHeartbeatAt &&
      w.lastHeartbeatAt > staleThreshold;
    if (isOnline) {
      watchersOnline++;
      activeWatcherId ??= w.id;
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
  activeWatcherId ??= watcherRows[0]?.id ?? null;

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
    activeWatcherId,
  };
});
