import { and, eq, isNull, sql } from "drizzle-orm";
import { cache } from "react";
import { db } from "@/lib/db";
import {
  files,
  instrumentRuns,
  instruments,
  runAttributions,
  watchers,
} from "@/lib/db/schema";

export interface InstrumentSummary {
  displayName: string;
  filesPendingUpload: number;
  id: string;
  lastRunAt: Date | null;
  runCount: number;
  status: "pending" | "active" | "inactive";
  watcherStatus: "online" | "offline" | "no_watcher";
}

// A watcher is considered stale (offline) if it hasn't sent a heartbeat
// within this window, even if its DB status is still "watching".
const HEARTBEAT_STALE_MINUTES = 5;

export const getInstrumentSummaries = cache(
  async function getInstrumentSummaries(): Promise<InstrumentSummary[]> {
    // Instrument stats and watcher liveness are fetched separately to avoid a
    // combinatorial explosion from joining instruments × runs × files × watchers
    // in a single query. The watcher lookup is lightweight (one row per agent).
    const rows = await db
      .select({
        id: instruments.id,
        displayName: instruments.displayName,
        status: instruments.status,
        runCount: sql<number>`cast(count(distinct ${instrumentRuns.id}) filter (where ${instrumentRuns.deletedAt} is null) as int)`,
        lastRunAt: sql<Date | null>`max(coalesce(${instrumentRuns.acquiredAt}, ${instrumentRuns.createdAt})) filter (where ${instrumentRuns.deletedAt} is null)`,
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
);

// `activeOnly` is a primitive so `cache()` dedupes calls with the same value
// within a request; an options object would key on identity and miss.
export const getInstruments = cache(async function getInstruments(
  activeOnly = false
) {
  return await db
    .select({
      id: instruments.id,
      displayName: instruments.displayName,
      status: instruments.status,
    })
    .from(instruments)
    .where(activeOnly ? eq(instruments.status, "active") : undefined)
    .orderBy(instruments.displayName);
});

export interface DashboardStats {
  pendingUploads: {
    count: number;
    totalBytes: number;
  };
  runsLast24Hours: {
    total: number;
    bytesGenerated: number;
  };
  runsThisWeek: {
    total: number;
    bytesGenerated: number;
    mine: number;
    unattributed: number;
  };
}

/**
 * Aggregates the four dashboard summary metrics surfaced above the instruments
 * table. Each metric is a single COUNT/SUM, so we issue them in parallel rather
 * than as one mega-join — that keeps the per-query plans simple and avoids the
 * row-multiplication problems we'd hit joining instruments × runs × files ×
 * attributions in a single statement.
 *
 * Wrapped in `cache()` so duplicate calls within the same request (e.g. layout
 * + page) share a result. The cache key includes `currentUserId`, so different
 * users on parallel requests don't collide.
 */
export const getDashboardStats = cache(async function getDashboardStats(
  currentUserId: string | null
): Promise<DashboardStats> {
  const [
    [runsLast24HoursRow],
    [bytesGeneratedRow],
    [pendingRow],
    [runsThisWeekRow],
  ] = await Promise.all([
    db
      .select({
        total: sql<number>`cast(count(*) as int)`,
      })
      .from(instrumentRuns)
      .innerJoin(instruments, eq(instruments.id, instrumentRuns.instrumentId))
      .where(
        and(
          eq(instruments.status, "active"),
          isNull(instrumentRuns.deletedAt),
          sql`coalesce(${instrumentRuns.acquiredAt}, ${instrumentRuns.createdAt}) > now() - interval '24 hours'`
        )
      ),
    // Span the last 24 hours + the past 7 days in a single pass; the 24-hour
    // window is a subset of the weekly window, so FILTER clauses give us both
    // with one index scan. Bytes are attributed to the file's owning run so
    // the time window matches the corresponding "Runs in the last X" card —
    // this avoids the null-`processedAt` blind spot for not-yet-processed
    // files (which still represent data the instrument generated). Windows
    // are anchored to the run's actual acquisition time when known so
    // backfilled historical data doesn't pollute the "last 24h"/"this week"
    // counts.
    db
      .select({
        bytesLast24Hours: sql<string>`coalesce(sum(${files.sizeBytes}) filter (where coalesce(${instrumentRuns.acquiredAt}, ${instrumentRuns.createdAt}) > now() - interval '24 hours'), 0)`,
        bytesWeek: sql<string>`coalesce(sum(${files.sizeBytes}), 0)`,
      })
      .from(files)
      .innerJoin(instrumentRuns, eq(files.instrumentRunId, instrumentRuns.id))
      .innerJoin(instruments, eq(instruments.id, instrumentRuns.instrumentId))
      .where(
        and(
          eq(instruments.status, "active"),
          isNull(files.deletedAt),
          isNull(instrumentRuns.deletedAt),
          sql`coalesce(${instrumentRuns.acquiredAt}, ${instrumentRuns.createdAt}) > now() - interval '7 days'`
        )
      ),
    db
      .select({
        count: sql<number>`cast(count(*) as int)`,
        totalBytes: sql<number>`cast(coalesce(sum(${files.sizeBytes}), 0) as bigint)`,
      })
      .from(files)
      .innerJoin(instrumentRuns, eq(files.instrumentRunId, instrumentRuns.id))
      .innerJoin(instruments, eq(instruments.id, instrumentRuns.instrumentId))
      .where(
        and(
          eq(instruments.status, "active"),
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
      .innerJoin(instruments, eq(instruments.id, instrumentRuns.instrumentId))
      .where(
        and(
          eq(instruments.status, "active"),
          isNull(instrumentRuns.deletedAt),
          sql`coalesce(${instrumentRuns.acquiredAt}, ${instrumentRuns.createdAt}) > now() - interval '7 days'`
        )
      ),
  ]);

  return {
    runsLast24Hours: {
      total: runsLast24HoursRow?.total ?? 0,
      // bigint sums come back as strings from pg; coerce explicitly.
      bytesGenerated: Number(bytesGeneratedRow?.bytesLast24Hours ?? 0),
    },
    pendingUploads: {
      count: pendingRow?.count ?? 0,
      totalBytes: Number(pendingRow?.totalBytes ?? 0),
    },
    runsThisWeek: {
      total: runsThisWeekRow?.total ?? 0,
      bytesGenerated: Number(bytesGeneratedRow?.bytesWeek ?? 0),
      mine: runsThisWeekRow?.mine ?? 0,
      unattributed: runsThisWeekRow?.unattributed ?? 0,
    },
  };
});
