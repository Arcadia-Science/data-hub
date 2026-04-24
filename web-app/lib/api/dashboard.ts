import { db } from "@/lib/db";
import {
  files,
  instrumentRuns,
  instruments,
  runAttributions,
  watchers,
} from "@/lib/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";

export type InstrumentSummary = {
  id: string;
  displayName: string;
  status: "pending" | "active" | "inactive";
  runCount: number;
  lastRunAt: Date | null;
  watcherStatus: "online" | "offline" | "no_watcher";
  filesPendingUpload: number;
};

// A watcher is considered stale (offline) if it hasn't sent a heartbeat
// within this window, even if its DB status is still "watching".
const HEARTBEAT_STALE_MINUTES = 5;

export async function getInstrumentSummaries(): Promise<InstrumentSummary[]> {
  // Instrument stats and watcher liveness are fetched separately to avoid a
  // combinatorial explosion from joining instruments × runs × files × watchers
  // in a single query. The watcher lookup is lightweight (one row per agent).
  const rows = await db
    .select({
      id: instruments.id,
      displayName: instruments.displayName,
      status: instruments.status,
      runCount: sql<number>`cast(count(distinct ${instrumentRuns.id}) filter (where ${instrumentRuns.deletedAt} is null) as int)`,
      lastRunAt: sql<Date | null>`max(${instrumentRuns.createdAt}) filter (where ${instrumentRuns.deletedAt} is null)`,
      filesPendingUpload: sql<number>`cast(count(distinct ${files.id}) filter (where ${files.status} in ('detected', 'upload_requested') and ${files.deletedAt} is null) as int)`,
    })
    .from(instruments)
    .leftJoin(instrumentRuns, eq(instrumentRuns.instrumentId, instruments.id))
    .leftJoin(files, eq(files.instrumentRunId, instrumentRuns.id))
    .groupBy(instruments.id, instruments.displayName, instruments.status)
    .orderBy(instruments.displayName);

  const watcherRows = await db
    .select({
      instrumentId: watchers.instrumentId,
      status: watchers.status,
      lastHeartbeatAt: watchers.lastHeartbeatAt,
    })
    .from(watchers)
    .where(isNull(watchers.deletedAt));

  // Index watchers by instrument so we can do O(1) lookups when enriching rows.
  const watcherMap = new Map<
    string,
    { status: string; lastHeartbeatAt: Date | null }[]
  >();
  for (const w of watcherRows) {
    const arr = watcherMap.get(w.instrumentId) ?? [];
    arr.push(w);
    watcherMap.set(w.instrumentId, arr);
  }

  const staleThreshold = new Date(
    Date.now() - HEARTBEAT_STALE_MINUTES * 60 * 1000
  );

  return rows.map((row) => {
    const instrumentWatchers = watcherMap.get(row.id) ?? [];
    let watcherStatus: InstrumentSummary["watcherStatus"] = "no_watcher";

    // An instrument is "online" only if at least one watcher is actively
    // heartbeating. Registered watchers that have gone silent are "offline".
    if (instrumentWatchers.length > 0) {
      const hasOnline = instrumentWatchers.some(
        (w) =>
          w.status === "watching" &&
          w.lastHeartbeatAt &&
          w.lastHeartbeatAt > staleThreshold
      );
      watcherStatus = hasOnline ? "online" : "offline";
    }

    return {
      id: row.id,
      displayName: row.displayName,
      status: row.status,
      runCount: row.runCount,
      lastRunAt: row.lastRunAt,
      filesPendingUpload: row.filesPendingUpload,
      watcherStatus,
    };
  });
}

export async function getInstruments() {
  return db
    .select({
      id: instruments.id,
      displayName: instruments.displayName,
      status: instruments.status,
    })
    .from(instruments)
    .orderBy(instruments.displayName);
}

export type DashboardStats = {
  runsToday: {
    total: number;
    filesCompleted: number;
    filesFailed: number;
  };
  pendingUploads: {
    count: number;
    totalBytes: number;
  };
  runsThisWeek: {
    total: number;
    filesCompleted: number;
    filesFailed: number;
    mine: number;
    unattributed: number;
  };
};

/**
 * Aggregates the four dashboard summary metrics surfaced above the instruments
 * table. Each metric is a single COUNT/SUM, so we issue them in parallel rather
 * than as one mega-join — that keeps the per-query plans simple and avoids the
 * row-multiplication problems we'd hit joining instruments × runs × files ×
 * attributions in a single statement.
 */
export async function getDashboardStats(
  currentUserId: string | null
): Promise<DashboardStats> {
  const [
    [runsTodayRow],
    [filesProcessedTodayRow],
    [pendingRow],
    [runsThisWeekRow],
  ] = await Promise.all([
    db
      .select({
        total: sql<number>`cast(count(*) as int)`,
      })
      .from(instrumentRuns)
      .where(
        and(
          isNull(instrumentRuns.deletedAt),
          sql`${instrumentRuns.createdAt} >= date_trunc('day', now())`
        )
      ),
    // Span today + the past 7 days in a single pass; the today metrics are a
    // subset of the weekly window, so FILTER clauses give us both with one
    // index scan instead of two near-identical queries.
    db
      .select({
        completedToday: sql<number>`cast(count(*) filter (where ${files.status} = 'completed' and ${files.processedAt} >= date_trunc('day', now())) as int)`,
        failedToday: sql<number>`cast(count(*) filter (where ${files.status} = 'failed' and ${files.processedAt} >= date_trunc('day', now())) as int)`,
        completedWeek: sql<number>`cast(count(*) filter (where ${files.status} = 'completed') as int)`,
        failedWeek: sql<number>`cast(count(*) filter (where ${files.status} = 'failed') as int)`,
      })
      .from(files)
      .where(
        and(
          isNull(files.deletedAt),
          sql`${files.processedAt} > now() - interval '7 days'`
        )
      ),
    db
      .select({
        count: sql<number>`cast(count(*) as int)`,
        totalBytes: sql<number>`cast(coalesce(sum(${files.sizeBytes}), 0) as bigint)`,
      })
      .from(files)
      .where(
        and(
          isNull(files.deletedAt),
          sql`${files.status} in ('detected', 'upload_requested')`
        )
      ),
    // "Mine" requires a user; the unattributed count is fleet-wide and
    // independent of the viewer.
    db
      .select({
        total: sql<number>`cast(count(*) as int)`,
        mine: currentUserId
          ? sql<number>`cast(count(*) filter (where exists (select 1 from ${runAttributions} where ${runAttributions.runId} = ${instrumentRuns.id} and ${runAttributions.userId} = ${currentUserId})) as int)`
          : sql<number>`cast(0 as int)`,
        unattributed: sql<number>`cast(count(*) filter (where not exists (select 1 from ${runAttributions} where ${runAttributions.runId} = ${instrumentRuns.id})) as int)`,
      })
      .from(instrumentRuns)
      .where(
        and(
          isNull(instrumentRuns.deletedAt),
          sql`${instrumentRuns.createdAt} > now() - interval '7 days'`
        )
      ),
  ]);

  return {
    runsToday: {
      total: runsTodayRow?.total ?? 0,
      filesCompleted: filesProcessedTodayRow?.completedToday ?? 0,
      filesFailed: filesProcessedTodayRow?.failedToday ?? 0,
    },
    pendingUploads: {
      count: pendingRow?.count ?? 0,
      // bigint sums come back as strings from pg; coerce explicitly.
      totalBytes: Number(pendingRow?.totalBytes ?? 0),
    },
    runsThisWeek: {
      total: runsThisWeekRow?.total ?? 0,
      filesCompleted: filesProcessedTodayRow?.completedWeek ?? 0,
      filesFailed: filesProcessedTodayRow?.failedWeek ?? 0,
      mine: runsThisWeekRow?.mine ?? 0,
      unattributed: runsThisWeekRow?.unattributed ?? 0,
    },
  };
}
