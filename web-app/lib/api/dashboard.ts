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
  instruments: {
    online: number;
    activeTotal: number;
    offline: number;
  };
  pendingUploads: {
    count: number;
    totalBytes: number;
  };
  runsThisWeek: {
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
    [instrumentsRow],
    [watcherRow],
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
    db
      .select({
        completed: sql<number>`cast(count(*) filter (where ${files.status} = 'completed') as int)`,
        failed: sql<number>`cast(count(*) filter (where ${files.status} = 'failed') as int)`,
      })
      .from(files)
      .where(
        and(
          isNull(files.deletedAt),
          sql`${files.processedAt} >= date_trunc('day', now())`
        )
      ),
    db
      .select({
        activeTotal: sql<number>`cast(count(*) filter (where ${instruments.status} = 'active') as int)`,
      })
      .from(instruments),
    // Roll watchers up by instrument so an instrument with multiple watchers
    // only counts once toward online/offline totals.
    db
      .select({
        online: sql<number>`cast(count(*) filter (where has_online) as int)`,
      })
      .from(
        db
          .select({
            instrumentId: watchers.instrumentId,
            // Use a SQL interval rather than binding a JS Date — drizzle
            // serialises the Date with `.toString()` here (instead of ISO), and
            // Postgres rejects "Fri Apr 24 2026 15:42:41 GMT-0700 (..)" as a
            // timestamp. The interval form mirrors getInstrumentListWithCounts.
            hasOnline:
              sql<boolean>`bool_or(${watchers.status} = 'watching' and ${watchers.lastHeartbeatAt} > now() - interval '${sql.raw(String(HEARTBEAT_STALE_MINUTES))} minutes')`.as(
                "has_online"
              ),
          })
          .from(watchers)
          .where(isNull(watchers.deletedAt))
          .groupBy(watchers.instrumentId)
          .as("watcher_rollup")
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

  const online = Number(watcherRow?.online ?? 0);
  const activeTotal = instrumentsRow?.activeTotal ?? 0;

  return {
    runsToday: {
      total: runsTodayRow?.total ?? 0,
      filesCompleted: filesProcessedTodayRow?.completed ?? 0,
      filesFailed: filesProcessedTodayRow?.failed ?? 0,
    },
    instruments: {
      online,
      activeTotal,
      // "Offline" rolls up everything not actively heartbeating — both
      // registered-but-stale watchers and instruments with no watcher at all.
      offline: Math.max(0, activeTotal - online),
    },
    pendingUploads: {
      count: pendingRow?.count ?? 0,
      // bigint sums come back as strings from pg; coerce explicitly.
      totalBytes: Number(pendingRow?.totalBytes ?? 0),
    },
    runsThisWeek: {
      mine: runsThisWeekRow?.mine ?? 0,
      unattributed: runsThisWeekRow?.unattributed ?? 0,
    },
  };
}
