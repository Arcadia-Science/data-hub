import { and, count, eq, isNull, sql } from "drizzle-orm";
import { cache } from "react";
import { type Actor, resolveActor } from "@/lib/api/actor";
import {
  getInstrumentWatcherInfo,
  type InstrumentWatcherInfo,
  NO_WATCHER_INFO,
} from "@/lib/api/instrument-watchers";
import { startOfWeekISO } from "@/lib/date";
import { db } from "@/lib/db";
import {
  type InstrumentType,
  instrumentRuns,
  instruments,
  personalAccessTokens,
  users,
} from "@/lib/db/schema";
import type {
  Connection,
  InstrumentWatcher,
} from "@/lib/instruments/connection";
import { getViewerTimeZone } from "@/lib/viewer-timezone";

export interface InstrumentListItem {
  /**
   * Watcher the instrument's menu links to: the active watcher, else the most
   * recently deregistered one.
   * @deprecated Use `watcher?.id`. It is kept, with its value unchanged, until
   * every client has moved to `watcher`.
   */
  activeWatcherId: string | null;
  /** How the instrument is connected to its watcher. */
  connection: Connection;
  createdAt: Date;
  displayName: string;
  /**
   * The watcher's file patterns, de-duplicated and sorted.
   * @deprecated Use `watcher?.filePatterns`, which keeps the config's order.
   */
  filePatterns: string[];
  /**
   * True when the instrument has a deregistered watcher.
   * @deprecated Use `pastWatcherCount > 0`, or `connection.reason`.
   */
  hasDeregisteredWatcher: boolean;
  id: string;
  instrumentType: InstrumentType;
  lastRunAt: Date | null;
  /**
   * The active watcher's last heartbeat.
   * @deprecated Use `watcher?.lastHeartbeatAt`.
   */
  lastWatcherHeartbeatAt: Date | null;
  /** How many deregistered watchers the instrument has had. */
  pastWatcherCount: number;
  runCount: number;
  runsThisWeek: number;
  status: "pending" | "active" | "inactive";
  /**
   * The instrument's active watcher, or null when it has none. An instrument
   * has at most one.
   */
  watcher: InstrumentWatcher | null;
  /**
   * 1 when the instrument has an active watcher, else 0.
   * @deprecated Use `watcher !== null`.
   */
  watcherCount: number;
  /**
   * 1 when the connection is online, else 0.
   * @deprecated Use `connection.state === "online"`.
   */
  watchersOnline: number;
}

// Pre-aggregated sub-select builders used by both the full list and the
// focused dashboard query. Inlined helpers (rather than module-level
// constants) so each caller gets a fresh drizzle alias and the queries can
// be composed independently.
function buildRunCountSubquery(weekStartISO: string) {
  // `runsThisWeek` and `lastRunAt` are anchored to the run's true
  // acquisition time when known so backfilled runs (where created_at is
  // "today" but the data is older) don't pollute the recent-runs window
  // or get reported as the most recent activity. Falls back to created_at
  // for Lambda-only and pre-backfill runs where acquired_at is NULL.
  // `weekStartISO` is Monday 00:00 from `getViewerTimeZone()` (cookie → IP → UTC).
  return db
    .select({
      instrumentId: instrumentRuns.instrumentId,
      count: sql<number>`cast(count(*) as int)`.as("run_count"),
      countThisWeek:
        sql<number>`cast(count(*) filter (where coalesce(${instrumentRuns.acquiredAt}, ${instrumentRuns.createdAt}) >= ${weekStartISO}::timestamptz) as int)`.as(
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

// The instrument columns the list builds on. Aggregates flow through the `sql`
// template without the timestamp parser the column would apply, so
// `hydrateInstrumentRow` re-wraps `lastRunAt` as a date.
interface InstrumentListRow {
  createdAt: Date;
  displayName: string;
  id: string;
  instrumentType: InstrumentType;
  lastRunAt: Date | null;
  runCount: number;
  runsThisWeek: number;
  status: "pending" | "active" | "inactive";
}

/**
 * The deprecated top-level `filePatterns`: the watcher's patterns,
 * de-duplicated and sorted, as the patterns merged from an instrument's
 * watchers always were.
 */
function sortedDistinctPatterns(patterns: readonly string[]): string[] {
  return [...new Set(patterns)].sort();
}

/**
 * The deprecated fields that are the same on the list and the detail, filled
 * from the one watcher so their values match what the old per-watcher counts
 * gave.
 */
function deprecatedWatcherFields({
  watcher,
  connection,
  pastWatcherCount,
  mostRecentPastWatcher,
}: InstrumentWatcherInfo) {
  return {
    watcherCount: watcher ? 1 : 0,
    watchersOnline: connection.state === "online" ? 1 : 0,
    lastWatcherHeartbeatAt: watcher?.lastHeartbeatAt ?? null,
    filePatterns: sortedDistinctPatterns(watcher?.filePatterns ?? []),
    activeWatcherId: watcher?.id ?? mostRecentPastWatcher?.id ?? null,
    hasDeregisteredWatcher: pastWatcherCount > 0,
  };
}

function hydrateInstrumentRow(
  row: InstrumentListRow,
  info: InstrumentWatcherInfo
): InstrumentListItem {
  return {
    ...row,
    lastRunAt: row.lastRunAt ? new Date(row.lastRunAt) : null,
    watcher: info.watcher,
    connection: info.connection,
    pastWatcherCount: info.pastWatcherCount,
    ...deprecatedWatcherFields(info),
  };
}

// Uses a pre-aggregated sub-select for the run counts instead of a direct join
// to avoid row multiplication (instruments × runs would inflate counts). The
// watchers come from `getInstrumentWatcherInfo`, one batched read for every
// instrument.
//
// Wrapped in `cache()` so concurrent server components on the same request
// (e.g. layout + page) share a single result.
export const getInstrumentListWithCounts = cache(
  async function getInstrumentListWithCounts(): Promise<InstrumentListItem[]> {
    const weekStart = startOfWeekISO(await getViewerTimeZone());
    const runCountSq = buildRunCountSubquery(weekStart);

    const rows = await db
      .select({
        id: instruments.id,
        displayName: instruments.displayName,
        status: instruments.status,
        instrumentType: instruments.instrumentType,
        createdAt: instruments.createdAt,
        runCount: sql<number>`coalesce(${runCountSq.count}, 0)`,
        runsThisWeek: sql<number>`coalesce(${runCountSq.countThisWeek}, 0)`,
        lastRunAt: runCountSq.lastRunAt,
      })
      .from(instruments)
      .leftJoin(runCountSq, eq(runCountSq.instrumentId, instruments.id))
      .orderBy(instruments.displayName);

    const infoById = await getInstrumentWatcherInfo(rows.map((r) => r.id));
    return rows.map((row) =>
      hydrateInstrumentRow(row, infoById.get(row.id) ?? NO_WATCHER_INFO)
    );
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
 * The watchers are read for the resulting instrument IDs after the row query
 * resolves; this keeps the focused query truly bounded.
 */
export const getRecentActiveInstrumentsForDashboard = cache(
  async function getRecentActiveInstrumentsForDashboard(
    limit: number
  ): Promise<DashboardInstrumentSummary> {
    const weekStart = startOfWeekISO(await getViewerTimeZone());
    const runCountSq = buildRunCountSubquery(weekStart);

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
        })
        .from(instruments)
        .leftJoin(runCountSq, eq(runCountSq.instrumentId, instruments.id))
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

    // Watchers only for the selected instruments, bounded by `limit` rather
    // than by total fleet size.
    const infoById = await getInstrumentWatcherInfo(rows.map((r) => r.id));
    return {
      rows: rows.map((row) =>
        hydrateInstrumentRow(row, infoById.get(row.id) ?? NO_WATCHER_INFO)
      ),
      totalActive,
    };
  }
);

export interface InstrumentDetail {
  /**
   * True when `activeWatcherId` is a deregistered watcher (no active one
   * remains). Lets the header distinguish "was deregistered" from "never had
   * a watcher".
   * @deprecated Use `connection.reason === "deregistered"`.
   */
  activeWatcherDeregistered: boolean;
  /**
   * Desktop hostname of the watcher `activeWatcherId` names, if any.
   * @deprecated Use `watcher?.hostname`.
   */
  activeWatcherHostname: string | null;
  /**
   * The active watcher, else the most recently deregistered one, so the header
   * can still link to it when no active watcher remains.
   * @deprecated Use `watcher?.id`.
   */
  activeWatcherId: string | null;
  /**
   * `watch_directory` from the active watcher's config. Null when no active
   * watcher remains, since a deregistered watcher no longer watches anything.
   * @deprecated Use `watcher?.watchDirectory`.
   */
  activeWatcherWatchDirectory: string | null;
  /** How the instrument is connected to its watcher. */
  connection: Connection;
  createdAt: Date;
  displayName: string;
  /**
   * The watcher's file patterns, de-duplicated and sorted.
   * @deprecated Use `watcher?.filePatterns`, which keeps the config's order.
   */
  filePatterns: string[];
  id: string;
  instrumentType: InstrumentType;
  /**
   * The active watcher's last heartbeat.
   * @deprecated Use `watcher?.lastHeartbeatAt`.
   */
  lastWatcherHeartbeatAt: Date | null;
  /** How many deregistered watchers the instrument has had. */
  pastWatcherCount: number;
  /** When the instrument was retired; null unless `status` is `inactive`. */
  retiredAt: Date | null;
  /** Who retired the instrument; null when unknown or not retired. */
  retiredBy: Actor | null;
  runCount: number;
  status: "pending" | "active" | "inactive";
  updatedAt: Date;
  /**
   * The instrument's active watcher, or null when it has none. An instrument
   * has at most one.
   */
  watcher: InstrumentWatcher | null;
  /**
   * 1 when the instrument has an active watcher, else 0.
   * @deprecated Use `watcher !== null`.
   */
  watcherCount: number;
  /**
   * 1 when the instrument has an active watcher that isn't online, else 0.
   * @deprecated Use `connection.state`.
   */
  watchersOffline: number;
  /**
   * 1 when the connection is online, else 0.
   * @deprecated Use `connection.state === "online"`.
   */
  watchersOnline: number;
}

export const getInstrumentById = cache(async function getInstrumentById(
  instrumentId: string
): Promise<InstrumentDetail | null> {
  const [instrument] = await db
    .select({
      id: instruments.id,
      displayName: instruments.displayName,
      status: instruments.status,
      instrumentType: instruments.instrumentType,
      createdAt: instruments.createdAt,
      updatedAt: instruments.updatedAt,
      retiredAt: instruments.retiredAt,
      retiredByUserId: instruments.retiredBy,
      retiredByTokenId: instruments.retiredByToken,
      retiredByName: users.name,
      retiredByEmail: users.email,
      retiredByImage: users.image,
      retiredByTokenName: personalAccessTokens.name,
      retiredByTokenRevokedAt: personalAccessTokens.revokedAt,
    })
    .from(instruments)
    // Resolve the retirer for display; all NULL when active or retired before
    // `retired_by` existed.
    .leftJoin(users, eq(users.id, instruments.retiredBy))
    .leftJoin(
      personalAccessTokens,
      eq(personalAccessTokens.id, instruments.retiredByToken)
    )
    .where(eq(instruments.id, instrumentId))
    .limit(1);

  if (!instrument) {
    return null;
  }

  const [runCountResult, infoById] = await Promise.all([
    db
      .select({ value: count() })
      .from(instrumentRuns)
      .where(
        and(
          eq(instrumentRuns.instrumentId, instrumentId),
          isNull(instrumentRuns.deletedAt)
        )
      ),
    getInstrumentWatcherInfo([instrumentId]),
  ]);
  const info = infoById.get(instrumentId) ?? NO_WATCHER_INFO;
  const { watcher, mostRecentPastWatcher } = info;
  const deprecated = deprecatedWatcherFields(info);

  return {
    id: instrument.id,
    displayName: instrument.displayName,
    status: instrument.status,
    instrumentType: instrument.instrumentType,
    createdAt: instrument.createdAt,
    updatedAt: instrument.updatedAt,
    retiredAt: instrument.retiredAt,
    retiredBy: resolveActor({
      userId: instrument.retiredByUserId,
      userName: instrument.retiredByName,
      userEmail: instrument.retiredByEmail,
      userImage: instrument.retiredByImage,
      tokenId: instrument.retiredByTokenId,
      tokenName: instrument.retiredByTokenName,
      tokenRevokedAt: instrument.retiredByTokenRevokedAt,
    }),
    runCount: runCountResult[0].value,
    watcher,
    connection: info.connection,
    pastWatcherCount: info.pastWatcherCount,
    watcherCount: deprecated.watcherCount,
    watchersOnline: deprecated.watchersOnline,
    watchersOffline: deprecated.watcherCount - deprecated.watchersOnline,
    lastWatcherHeartbeatAt: deprecated.lastWatcherHeartbeatAt,
    filePatterns: deprecated.filePatterns,
    activeWatcherId: deprecated.activeWatcherId,
    activeWatcherHostname: watcher
      ? watcher.hostname
      : (mostRecentPastWatcher?.hostname ?? null),
    activeWatcherWatchDirectory: watcher?.watchDirectory ?? null,
    activeWatcherDeregistered:
      watcher === null && mostRecentPastWatcher !== null,
  };
});
