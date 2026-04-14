import { db } from "@/lib/db";
import { instrumentRuns, instruments, watchers } from "@/lib/db/schema";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { cache } from "react";

export type InstrumentListItem = {
  id: string;
  displayName: string;
  status: "pending" | "active" | "inactive";
  instrumentType: "generic" | "plate_reader";
  filePatterns: string[] | null;
  runCount: number;
  watcherCount: number;
  watchersOnline: number;
  createdAt: Date;
};

// A watcher is stale when its last heartbeat is older than this threshold,
// even if its DB status is "watching". Must match the window in dashboard.ts.
const HEARTBEAT_STALE_MINUTES = 5;

// Uses pre-aggregated sub-selects instead of direct joins to avoid row
// multiplication (instruments × runs × watchers would inflate counts).
export async function getInstrumentListWithCounts(): Promise<
  InstrumentListItem[]
> {
  const runCountSq = db
    .select({
      instrumentId: instrumentRuns.instrumentId,
      count: sql<number>`cast(count(*) as int)`.as("run_count"),
    })
    .from(instrumentRuns)
    .where(isNull(instrumentRuns.deletedAt))
    .groupBy(instrumentRuns.instrumentId)
    .as("run_counts");

  const watcherCountSq = db
    .select({
      instrumentId: watchers.instrumentId,
      count: sql<number>`cast(count(*) as int)`.as("watcher_count"),
      online: sql<number>`cast(count(*) filter (where ${watchers.status} = 'watching' and ${watchers.lastHeartbeatAt} > now() - interval '${sql.raw(String(HEARTBEAT_STALE_MINUTES))} minutes') as int)`.as(
        "online_count"
      ),
    })
    .from(watchers)
    .where(isNull(watchers.deletedAt))
    .groupBy(watchers.instrumentId)
    .as("watcher_counts");

  const rows = await db
    .select({
      id: instruments.id,
      displayName: instruments.displayName,
      status: instruments.status,
      instrumentType: instruments.instrumentType,
      filePatterns: instruments.filePatterns,
      createdAt: instruments.createdAt,
      runCount: sql<number>`coalesce(${runCountSq.count}, 0)`,
      watcherCount: sql<number>`coalesce(${watcherCountSq.count}, 0)`,
      watchersOnline: sql<number>`coalesce(${watcherCountSq.online}, 0)`,
    })
    .from(instruments)
    .leftJoin(runCountSq, eq(runCountSq.instrumentId, instruments.id))
    .leftJoin(watcherCountSq, eq(watcherCountSq.instrumentId, instruments.id))
    .orderBy(instruments.displayName);

  return rows;
}

export type InstrumentDetail = {
  id: string;
  displayName: string;
  status: "pending" | "active" | "inactive";
  instrumentType: "generic" | "plate_reader";
  filePatterns: string[] | null;
  s3TriggerSuffix: string | null;
  createdAt: Date;
  updatedAt: Date;
  runCount: number;
  watcherCount: number;
  watchersOnline: number;
  watchersOffline: number;
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

  // Fetch run count and watcher rows in parallel — watcher rows are returned
  // individually so we can classify each as online/offline based on heartbeat.
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
        status: watchers.status,
        lastHeartbeatAt: watchers.lastHeartbeatAt,
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
  for (const w of watcherRows) {
    const isOnline =
      w.status === "watching" &&
      w.lastHeartbeatAt &&
      w.lastHeartbeatAt > staleThreshold;
    if (isOnline) watchersOnline++;
    else watchersOffline++;
  }

  return {
    id: instrument.id,
    displayName: instrument.displayName,
    status: instrument.status,
    instrumentType: instrument.instrumentType,
    filePatterns: instrument.filePatterns,
    s3TriggerSuffix: instrument.s3TriggerSuffix,
    createdAt: instrument.createdAt,
    updatedAt: instrument.updatedAt,
    runCount: runCountResult[0].value,
    watcherCount: watcherRows.length,
    watchersOnline,
    watchersOffline,
  };
});
