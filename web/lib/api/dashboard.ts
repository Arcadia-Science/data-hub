import { and, desc, eq, isNull, type SQL, sql } from "drizzle-orm";
import { cache } from "react";
import type { UserAvatarUser } from "@/components/user-avatar";
import { db } from "@/lib/db";
import {
  files,
  instrumentRuns,
  instruments,
  runAttributions,
  runComments,
  users,
  watchers,
} from "@/lib/db/schema";
import { toInitials } from "@/lib/utils";

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

export interface MyRunsStats {
  commentsLast7Days: {
    count: number;
  };
  pendingUploads: {
    count: number;
    totalBytes: number;
  };
  runsLast7Days: {
    total: number;
    bytesGenerated: number;
  };
  runsLast24Hours: {
    total: number;
    bytesGenerated: number;
  };
}

// Correlated EXISTS against `run_attributions`, matching the `ranBy` predicate
// used by `buildRunListQuery` so the "My runs" cards count the same runs the
// table below them lists.
function attributedToUser(userId: string): SQL {
  return sql`exists (select 1 from ${runAttributions} where ${runAttributions.runId} = ${instrumentRuns.id} and ${runAttributions.userId} = ${userId})`;
}

/**
 * Aggregates the four "My runs" summary metrics, all scoped to runs the viewer
 * is attributed to. Like `getDashboardStats`, each metric is a single
 * COUNT/SUM issued in parallel to keep the per-query plans simple.
 *
 * Unlike the fleet dashboard, this is intentionally not restricted to active
 * instruments — a user's own runs stay relevant even after an instrument is
 * retired, and this matches the unrestricted `ranBy` run list on the page.
 * `cache()` keys on `userId` so parallel requests from different users don't
 * collide.
 */
export const getMyRunsStats = cache(async function getMyRunsStats(
  userId: string
): Promise<MyRunsStats> {
  const attributed = attributedToUser(userId);

  const [[runsRow], [bytesRow], [commentsRow], [pendingRow]] =
    await Promise.all([
      // Both run-count windows in one pass — the 24-hour window is a subset of
      // the weekly window, so a FILTER clause gives us both from one scan.
      db
        .select({
          last24Hours: sql<number>`cast(count(*) filter (where coalesce(${instrumentRuns.acquiredAt}, ${instrumentRuns.createdAt}) > now() - interval '24 hours') as int)`,
          last7Days: sql<number>`cast(count(*) as int)`,
        })
        .from(instrumentRuns)
        .where(
          and(
            isNull(instrumentRuns.deletedAt),
            sql`coalesce(${instrumentRuns.acquiredAt}, ${instrumentRuns.createdAt}) > now() - interval '7 days'`,
            attributed
          )
        ),
      // Bytes generated, anchored to each run's acquisition time so the windows
      // line up with the run-count cards above.
      db
        .select({
          bytesLast24Hours: sql<string>`coalesce(sum(${files.sizeBytes}) filter (where coalesce(${instrumentRuns.acquiredAt}, ${instrumentRuns.createdAt}) > now() - interval '24 hours'), 0)`,
          bytesLast7Days: sql<string>`coalesce(sum(${files.sizeBytes}), 0)`,
        })
        .from(files)
        .innerJoin(instrumentRuns, eq(files.instrumentRunId, instrumentRuns.id))
        .where(
          and(
            isNull(files.deletedAt),
            isNull(instrumentRuns.deletedAt),
            sql`coalesce(${instrumentRuns.acquiredAt}, ${instrumentRuns.createdAt}) > now() - interval '7 days'`,
            attributed
          )
        ),
      // Comments left in the last 7 days on runs the viewer is attributed to
      // (including the viewer's own comments).
      db
        .select({
          count: sql<number>`cast(count(*) as int)`,
        })
        .from(runComments)
        .innerJoin(instrumentRuns, eq(instrumentRuns.id, runComments.runId))
        .where(
          and(
            isNull(runComments.deletedAt),
            isNull(instrumentRuns.deletedAt),
            sql`${runComments.createdAt} > now() - interval '7 days'`,
            attributed
          )
        ),
      // Pending uploads across all of the viewer's attributed runs (no time
      // window — a stuck upload from last month still needs attention).
      db
        .select({
          count: sql<number>`cast(count(*) as int)`,
          totalBytes: sql<number>`cast(coalesce(sum(${files.sizeBytes}), 0) as bigint)`,
        })
        .from(files)
        .innerJoin(instrumentRuns, eq(files.instrumentRunId, instrumentRuns.id))
        .where(
          and(
            isNull(files.deletedAt),
            isNull(instrumentRuns.deletedAt),
            sql`${files.status} in ('detected', 'upload_requested')`,
            attributed
          )
        ),
    ]);

  return {
    runsLast24Hours: {
      total: runsRow?.last24Hours ?? 0,
      bytesGenerated: Number(bytesRow?.bytesLast24Hours ?? 0),
    },
    runsLast7Days: {
      total: runsRow?.last7Days ?? 0,
      bytesGenerated: Number(bytesRow?.bytesLast7Days ?? 0),
    },
    commentsLast7Days: {
      count: commentsRow?.count ?? 0,
    },
    pendingUploads: {
      count: pendingRow?.count ?? 0,
      totalBytes: Number(pendingRow?.totalBytes ?? 0),
    },
  };
});

export interface TopAttributor {
  bytesGenerated: number;
  runCount: number;
  user: UserAvatarUser;
}

/**
 * The user attributed to the most active-instrument runs in the last 7 days,
 * with the volume of data across those runs. Ties are broken by data
 * generated. Returns null when no runs were attributed this week. Powers the
 * "Most runs this week" leaderboard card on the dashboard.
 */
export const getTopAttributorThisWeek = cache(
  async function getTopAttributorThisWeek(): Promise<TopAttributor | null> {
    const runCountExpr = sql`count(distinct ${instrumentRuns.id})`;
    const bytesExpr = sql`coalesce(sum(${files.sizeBytes}), 0)`;

    // Each (run, file) pair is one joined row, but counting distinct run ids
    // keeps the run tally correct, and every file belongs to exactly one run so
    // the byte sum isn't double-counted.
    const [row] = await db
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        image: users.image,
        runCount: sql<number>`cast(${runCountExpr} as int)`,
        bytesGenerated: sql<string>`${bytesExpr}`,
      })
      .from(runAttributions)
      .innerJoin(instrumentRuns, eq(instrumentRuns.id, runAttributions.runId))
      .innerJoin(instruments, eq(instruments.id, instrumentRuns.instrumentId))
      .innerJoin(users, eq(users.id, runAttributions.userId))
      .leftJoin(
        files,
        and(
          eq(files.instrumentRunId, instrumentRuns.id),
          isNull(files.deletedAt)
        )
      )
      .where(
        and(
          eq(instruments.status, "active"),
          isNull(instrumentRuns.deletedAt),
          sql`coalesce(${instrumentRuns.acquiredAt}, ${instrumentRuns.createdAt}) > now() - interval '7 days'`
        )
      )
      .groupBy(users.id, users.name, users.email, users.image)
      .orderBy(desc(runCountExpr), desc(bytesExpr))
      .limit(1);

    if (!row) {
      return null;
    }

    const displayName = row.name ?? row.email ?? "Unknown";
    return {
      user: {
        userId: row.userId,
        displayName,
        initials: toInitials(displayName),
        avatarUrl: row.image,
      },
      runCount: row.runCount,
      bytesGenerated: Number(row.bytesGenerated),
    };
  }
);
