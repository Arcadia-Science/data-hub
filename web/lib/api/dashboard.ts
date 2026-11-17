import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { cache } from "react";
import { attributedToUser } from "@/lib/api/attributions";
import { runsNeedingAttentionColumns } from "@/lib/api/instrument-runs";
import {
  getInstrumentWatcherInfo,
  NO_WATCHER_INFO,
} from "@/lib/api/instrument-watchers";
import type { UserAvatarUser } from "@/lib/avatar-color";
import { startOfTodayISO, startOfWeekISO } from "@/lib/date";
import { db } from "@/lib/db";
import {
  files,
  instrumentRuns,
  instruments,
  runAttributions,
  runComments,
  users,
} from "@/lib/db/schema";
import {
  type Connection,
  toLegacyWatcherStatus,
} from "@/lib/instruments/connection";
import { filePendingUploadSql } from "@/lib/runs/file-buckets.sql";
import type { RunsNeedingAttention } from "@/lib/runs/run-status";
import { toInitials } from "@/lib/utils";
import { getViewerTimeZone } from "@/lib/viewer-timezone";

export interface InstrumentSummary {
  // How the instrument is connected to its watcher, the same value its
  // instrument responses carry.
  connection: Connection;
  displayName: string;
  filesPendingUpload: number;
  id: string;
  lastRunAt: Date | null;
  runCount: number;
  runsNeedingAttention: RunsNeedingAttention;
  status: "pending" | "active" | "inactive";
  /**
   * @deprecated Use `connection.state`, or `connection.reason`.
   */
  watcherStatus: "online" | "offline" | "no_watcher";
}

export const getInstrumentSummaries = cache(
  async function getInstrumentSummaries(): Promise<InstrumentSummary[]> {
    // Instrument stats and watcher state are fetched separately to avoid a
    // combinatorial explosion from joining instruments × runs × files × watchers
    // in a single query.
    const rows = await db
      .select({
        id: instruments.id,
        displayName: instruments.displayName,
        status: instruments.status,
        runCount: sql<number>`cast(count(distinct ${instrumentRuns.id}) filter (where ${instrumentRuns.deletedAt} is null) as int)`,
        lastRunAt: sql<Date | null>`max(coalesce(${instrumentRuns.acquiredAt}, ${instrumentRuns.createdAt})) filter (where ${instrumentRuns.deletedAt} is null)`,
        filesPendingUpload: sql<number>`cast(count(distinct ${files.id}) filter (where ${filePendingUploadSql(new Date())} and ${files.deletedAt} is null and ${instrumentRuns.deletedAt} is null) as int)`,
      })
      .from(instruments)
      .leftJoin(instrumentRuns, eq(instrumentRuns.instrumentId, instruments.id))
      .leftJoin(files, eq(files.instrumentRunId, instrumentRuns.id))
      .groupBy(instruments.id, instruments.displayName, instruments.status)
      .orderBy(instruments.displayName);

    // Counted per run in its own query: the status predicates look at each
    // run's files, so running them on the runs × files join above would
    // repeat them for every file.
    const [infoById, attentionRows] = await Promise.all([
      getInstrumentWatcherInfo(rows.map((r) => r.id)),
      db
        .select({
          instrumentId: instrumentRuns.instrumentId,
          ...runsNeedingAttentionColumns(new Date()),
        })
        .from(instrumentRuns)
        .where(isNull(instrumentRuns.deletedAt))
        .groupBy(instrumentRuns.instrumentId),
    ]);
    const attentionById = new Map(
      attentionRows.map((row) => [row.instrumentId, row])
    );

    return rows.map((row) => {
      const { connection } = infoById.get(row.id) ?? NO_WATCHER_INFO;
      // This status never named a deregistered watcher: an instrument whose
      // only watcher was deregistered reads `no_watcher`, as one that never had
      // a watcher does.
      const legacy = toLegacyWatcherStatus(connection);

      return {
        id: row.id,
        displayName: row.displayName,
        status: row.status,
        connection,
        runCount: row.runCount,
        // SQL `max(...)` can land as a Postgres timestamp string; normalize
        // like `hydrateInstrumentRow` so callers get a real Date.
        lastRunAt: row.lastRunAt ? new Date(row.lastRunAt) : null,
        filesPendingUpload: row.filesPendingUpload,
        runsNeedingAttention: toRunsNeedingAttention(attentionById.get(row.id)),
        watcherStatus: legacy === "deregistered" ? "no_watcher" : legacy,
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
  runsNeedingAttention: RunsNeedingAttention;
  runsThisWeek: {
    total: number;
    bytesGenerated: number;
  };
  runsToday: {
    total: number;
    bytesGenerated: number;
  };
}

/**
 * Aggregates the four dashboard summary metrics surfaced above the instruments
 * table. Each metric is a single COUNT/SUM, so we issue them in parallel rather
 * than as one mega-join — that keeps the per-query plans simple and avoids the
 * row-multiplication problems we'd hit joining instruments × runs × files ×
 * attributions in a single statement.
 *
 * Fleet-wide counts, keyed only by the viewer's timezone (cookie → Vercel IP
 * zone → UTC). Zero-arg `cache()` is safe within a request: one timezone, one
 * result shared by duplicate callers (e.g. layout + page).
 */
export const getDashboardStats = cache(
  async function getDashboardStats(): Promise<DashboardStats> {
    const timeZone = await getViewerTimeZone();
    const todayStart = startOfTodayISO(timeZone);
    const weekStart = startOfWeekISO(timeZone);

    const [
      [runsTodayRow],
      [bytesGeneratedRow],
      [attentionRow],
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
            sql`coalesce(${instrumentRuns.acquiredAt}, ${instrumentRuns.createdAt}) >= ${todayStart}::timestamptz`
          )
        ),
      // Span today + this calendar week in a single pass; today is a subset
      // of the weekly window, so FILTER clauses give us both with one index
      // scan. Bytes are attributed to the file's owning run so the time
      // window matches the corresponding "Runs today"/"Runs this week" card
      // — this avoids the null-`processedAt` blind spot for not-yet-processed
      // files (which still represent data the instrument generated). Windows
      // are anchored to the run's actual acquisition time when known so
      // backfilled historical data doesn't pollute the today/this-week counts.
      db
        .select({
          bytesToday: sql<string>`coalesce(sum(${files.sizeBytes}) filter (where coalesce(${instrumentRuns.acquiredAt}, ${instrumentRuns.createdAt}) >= ${todayStart}::timestamptz), 0)`,
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
            sql`coalesce(${instrumentRuns.acquiredAt}, ${instrumentRuns.createdAt}) >= ${weekStart}::timestamptz`
          )
        ),
      // Runs on active instruments whose status needs someone to act, of any
      // age: a run that couldn't upload a year ago still does.
      db
        .select(runsNeedingAttentionColumns(new Date()))
        .from(instrumentRuns)
        .innerJoin(instruments, eq(instruments.id, instrumentRuns.instrumentId))
        .where(
          and(
            eq(instruments.status, "active"),
            isNull(instrumentRuns.deletedAt)
          )
        ),
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
            sql`coalesce(${instrumentRuns.acquiredAt}, ${instrumentRuns.createdAt}) >= ${weekStart}::timestamptz`
          )
        ),
    ]);

    return {
      runsToday: {
        total: runsTodayRow?.total ?? 0,
        // bigint sums come back as strings from pg; coerce explicitly.
        bytesGenerated: Number(bytesGeneratedRow?.bytesToday ?? 0),
      },
      runsNeedingAttention: toRunsNeedingAttention(attentionRow),
      runsThisWeek: {
        total: runsThisWeekRow?.total ?? 0,
        bytesGenerated: Number(bytesGeneratedRow?.bytesWeek ?? 0),
      },
    };
  }
);

function toRunsNeedingAttention(
  row: { failed: number; stalled: number; uploadFailed: number } | undefined
): RunsNeedingAttention {
  const failed = row?.failed ?? 0;
  const stalled = row?.stalled ?? 0;
  const uploadFailed = row?.uploadFailed ?? 0;
  return {
    failed,
    stalled,
    uploadFailed,
    total: failed + stalled + uploadFailed,
  };
}

export interface UserProfile extends UserAvatarUser {
  email: string | null;
}

// For MCP `get_me` / `datahub://me`. Distinct from avatar-oriented `UserProfile`.
export interface AuthenticatedUser {
  email: string | null;
  id: string;
  image: string | null;
  isAdmin: boolean;
  name: string | null;
}

export async function getUserById(
  userId: string
): Promise<AuthenticatedUser | null> {
  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      image: users.image,
      isAdmin: users.isAdmin,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return row ?? null;
}

// Returns null on an unknown id so the page can `notFound()`. `cache()`-keyed
// on `userId` so the page header and `generateMetadata` share one lookup.
export const getUserProfile = cache(async function getUserProfile(
  userId: string
): Promise<UserProfile | null> {
  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      image: users.image,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!row) {
    return null;
  }

  const displayName = row.name ?? row.email ?? "Unknown user";
  return {
    userId: row.id,
    displayName,
    initials: toInitials(displayName),
    avatarUrl: row.image,
    email: row.email,
  };
});

export interface MyRunsStats {
  commentsThisWeek: {
    count: number;
  };
  runsNeedingAttention: RunsNeedingAttention;
  runsThisWeek: {
    total: number;
    bytesGenerated: number;
  };
  runsToday: {
    total: number;
    bytesGenerated: number;
  };
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
 * collide. Day/week windows use `getViewerTimeZone()` (cookie → IP → UTC).
 */
export const getMyRunsStats = cache(async function getMyRunsStats(
  userId: string
): Promise<MyRunsStats> {
  const attributed = attributedToUser(userId);
  const timeZone = await getViewerTimeZone();
  const todayStart = startOfTodayISO(timeZone);
  const weekStart = startOfWeekISO(timeZone);

  const [[runsRow], [bytesRow], [commentsRow], [attentionRow]] =
    await Promise.all([
      // Both run-count windows in one pass — today is a subset of this week,
      // so a FILTER clause gives us both from one scan.
      db
        .select({
          today: sql<number>`cast(count(*) filter (where coalesce(${instrumentRuns.acquiredAt}, ${instrumentRuns.createdAt}) >= ${todayStart}::timestamptz) as int)`,
          thisWeek: sql<number>`cast(count(*) as int)`,
        })
        .from(instrumentRuns)
        .where(
          and(
            isNull(instrumentRuns.deletedAt),
            sql`coalesce(${instrumentRuns.acquiredAt}, ${instrumentRuns.createdAt}) >= ${weekStart}::timestamptz`,
            attributed
          )
        ),
      // Bytes generated, anchored to each run's acquisition time so the windows
      // line up with the run-count cards above.
      db
        .select({
          bytesToday: sql<string>`coalesce(sum(${files.sizeBytes}) filter (where coalesce(${instrumentRuns.acquiredAt}, ${instrumentRuns.createdAt}) >= ${todayStart}::timestamptz), 0)`,
          bytesThisWeek: sql<string>`coalesce(sum(${files.sizeBytes}), 0)`,
        })
        .from(files)
        .innerJoin(instrumentRuns, eq(files.instrumentRunId, instrumentRuns.id))
        .where(
          and(
            isNull(files.deletedAt),
            isNull(instrumentRuns.deletedAt),
            sql`coalesce(${instrumentRuns.acquiredAt}, ${instrumentRuns.createdAt}) >= ${weekStart}::timestamptz`,
            attributed
          )
        ),
      // Comments left this calendar week on runs the viewer is attributed to
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
            sql`${runComments.createdAt} >= ${weekStart}::timestamptz`,
            attributed
          )
        ),
      // The viewer's attributed runs that need someone to act, of any age: a
      // run that couldn't upload last month still does.
      db
        .select(runsNeedingAttentionColumns(new Date()))
        .from(instrumentRuns)
        .where(and(isNull(instrumentRuns.deletedAt), attributed)),
    ]);

  return {
    runsToday: {
      total: runsRow?.today ?? 0,
      bytesGenerated: Number(bytesRow?.bytesToday ?? 0),
    },
    runsThisWeek: {
      total: runsRow?.thisWeek ?? 0,
      bytesGenerated: Number(bytesRow?.bytesThisWeek ?? 0),
    },
    commentsThisWeek: {
      count: commentsRow?.count ?? 0,
    },
    runsNeedingAttention: toRunsNeedingAttention(attentionRow),
  };
});

export interface TopAttributor {
  bytesGenerated: number;
  runCount: number;
  user: UserAvatarUser;
}

/**
 * The user attributed to the most active-instrument runs this calendar week
 * (Monday midnight in the viewer's timezone), with the volume of data across
 * those runs. Ties are broken by data generated. Returns null when no runs
 * were attributed this week. Powers the "Most runs this week" leaderboard
 * card on the dashboard.
 */
export const getTopAttributorThisWeek = cache(
  async function getTopAttributorThisWeek(): Promise<TopAttributor | null> {
    const timeZone = await getViewerTimeZone();
    const weekStart = startOfWeekISO(timeZone);
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
          sql`coalesce(${instrumentRuns.acquiredAt}, ${instrumentRuns.createdAt}) >= ${weekStart}::timestamptz`
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
