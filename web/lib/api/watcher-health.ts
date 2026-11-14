import { fromZonedTime } from "date-fns-tz";
import { and, desc, eq, gte, lt, min, or, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { watcherEvents, watcherHeartbeats } from "@/lib/db/schema";
import {
  BLOCK_MINUTES,
  BLOCKS_PER_DAY,
  blockStart,
  classifyBlock,
  type HealthBlock,
  type HealthDay,
  type MissedWindow,
  missedWindow,
  type RestartWindow,
  restartWindow,
  type WatcherHealth,
  windowTouchesBlock,
} from "@/lib/watchers/health";
import { addDays, eachDay, startOfDay } from "@/lib/watchers/range";
import {
  RESTART_STOP_FRAGMENTS,
  type RestartReason,
  restartReasonOf,
  UPLOAD_REQUESTS_CANCELLED_KIND,
} from "@/lib/watchers/stop-reasons";

// A watcher that restarts dozens of times a day, or loses its connection that
// often, is already telling the story with the first of these. The counts under
// the cards come from their own query and are never cut.
const WINDOW_ROW_LIMIT = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
// A stop's heartbeat and its event are sent together, so they land within this
// of each other.
const STOP_MATCH_MS = 2 * 60 * 1000;

/** `timestamp` as the wall-clock time in the viewer's zone. */
function localTime(column: AnyPgColumn, timeZone: string) {
  return sql`${column} AT TIME ZONE ${timeZone}`;
}

function localDay(column: AnyPgColumn, timeZone: string) {
  return sql<string>`to_char(${localTime(column, timeZone)}, 'YYYY-MM-DD')`;
}

// A `watcher_stopped` event that records a restart. The fragments are the ones
// `restartReasonOf` matches, so SQL and TypeScript agree on what a restart is.
function isRestartStop(reason: RestartReason): SQL {
  return sql`${watcherEvents.eventType} = 'watcher_stopped'
    and coalesce(${watcherEvents.details}->>'kind', '') <> ${UPLOAD_REQUESTS_CANCELLED_KIND}
    and ${watcherEvents.message} ilike ${`%${RESTART_STOP_FRAGMENTS[reason]}%`}`;
}

const isMissedHeartbeat = sql`${watcherEvents.eventType} = 'error'
  and ${watcherEvents.details}->>'kind' = 'heartbeat_recovered'`;

// `gap_seconds` comes from the watcher, which could send anything; read it as a
// number only when it is one.
const gapSeconds = sql`case
  when ${watcherEvents.details}->>'gap_seconds' ~ '^[0-9]+(\\.[0-9]+)?$'
  then (${watcherEvents.details}->>'gap_seconds')::numeric
end`;

// An upload's run, from its S3 key (`<instrument>/<run>/<file>`).
const uploadRun = sql`case
  when ${watcherEvents.eventType} = 'file_uploaded'
    and ${watcherEvents.details}->>'s3_key' ~ '^[^/]*/.+/[^/]*$'
  then regexp_replace(${watcherEvents.details}->>'s3_key', '^[^/]*/(.+)/[^/]*$', '\\1')
end`;

export interface WatcherHealthOptions {
  /** When the watcher was deregistered, for a past watcher. */
  deregisteredAt: Date | null;
  /** The first moment after the range's last day. */
  endExclusive: Date;
  /** The range's first day, `yyyy-MM-dd`. */
  fromDay: string;
  now?: Date;
  /** The first moment of the range's first day. */
  start: Date;
  timeZone: string;
  /** The range's last day, `yyyy-MM-dd`, inclusive. */
  toDay: string;
}

/** The first moment of 30-minute block `slot` of `day`, on the viewer's wall clock. */
function wallClockStart(day: string, slot: number, timeZone: string): Date {
  const minutes = slot * BLOCK_MINUTES;
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return fromZonedTime(`${day}T${hh}:${mm}:00.000`, timeZone);
}

/** The 49 edges of a day's 48 blocks. A day with a clock change isn't 24 hours long. */
function blockEdges(day: string, timeZone: string): Date[] {
  const dayStart = startOfDay(day, timeZone);
  const nextDayStart = startOfDay(addDays(day, 1), timeZone);
  if (nextDayStart.getTime() - dayStart.getTime() === DAY_MS) {
    return Array.from({ length: BLOCKS_PER_DAY + 1 }, (_, i) =>
      i === 0 ? dayStart : blockStart(dayStart, i)
    );
  }
  return Array.from({ length: BLOCKS_PER_DAY + 1 }, (_, i) =>
    i === BLOCKS_PER_DAY ? nextDayStart : wallClockStart(day, i, timeZone)
  );
}

/**
 * What the Health tab needs about one watcher over a range of days, worked out
 * in the database so that a month of one-a-minute heartbeats never leaves it:
 *
 * - heartbeats grouped into 30-minute blocks of each day, in the viewer's zone;
 * - files uploaded per day, upload failures, restarts by reason and missed
 *   heartbeats, each counted in one query over the range's events;
 * - the few restarts and recovered gaps themselves, to colour the blocks they
 *   touch.
 *
 * `classifyBlock` colours each block.
 */
export async function getWatcherHealth(
  watcherId: string,
  options: WatcherHealthOptions
): Promise<WatcherHealth> {
  const { start, endExclusive, timeZone } = options;
  const now = options.now ?? new Date();

  const heartbeatsInRange = and(
    eq(watcherHeartbeats.watcherId, watcherId),
    gte(watcherHeartbeats.timestamp, start),
    lt(watcherHeartbeats.timestamp, endExclusive)
  );
  const eventsInRange = and(
    eq(watcherEvents.watcherId, watcherId),
    gte(watcherEvents.timestamp, start),
    lt(watcherEvents.timestamp, endExclusive)
  );
  const localHeartbeat = localTime(watcherHeartbeats.timestamp, timeZone);

  const [
    heartbeatRows,
    [counts],
    fileRows,
    restartRows,
    missedRows,
    [firstHeartbeat],
    [statusBefore],
  ] = await Promise.all([
    // Columns are grouped by position: the expressions carry the time zone as a
    // parameter, and the database doesn't match two parameters as the same.
    db
      .select({
        day: localDay(watcherHeartbeats.timestamp, timeZone),
        slot: sql<number>`(extract(hour from ${localHeartbeat})::int * 2 + extract(minute from ${localHeartbeat})::int / 30)`,
        heartbeats: sql<number>`count(*)::int`,
        lastStatus: sql<string>`(array_agg(${watcherHeartbeats.status} order by ${watcherHeartbeats.timestamp} desc))[1]`,
      })
      .from(watcherHeartbeats)
      .where(heartbeatsInRange)
      .groupBy(sql`1`, sql`2`),
    db
      .select({
        files: sql<number>`count(*) filter (where ${watcherEvents.eventType} = 'file_uploaded')::int`,
        runs: sql<number>`count(distinct ${uploadRun})::int`,
        // A file that can't be read yet is waited for, not failed.
        uploadFailures: sql<number>`count(*) filter (where ${watcherEvents.eventType} = 'upload_failed' and coalesce(${watcherEvents.details}->>'will_retry', '') <> 'true')::int`,
        restartsForUpdate: sql<number>`count(*) filter (where ${isRestartStop("update")})::int`,
        restartsForWindows: sql<number>`count(*) filter (where ${isRestartStop("windows")})::int`,
        missedHeartbeats: sql<number>`count(*) filter (where ${isMissedHeartbeat})::int`,
        longestMissedSeconds: sql<number>`coalesce(max(${gapSeconds}) filter (where ${isMissedHeartbeat}), 0)::float8`,
      })
      .from(watcherEvents)
      .where(eventsInRange),
    db
      .select({
        day: localDay(watcherEvents.timestamp, timeZone),
        files: sql<number>`count(*)::int`,
      })
      .from(watcherEvents)
      .where(and(eventsInRange, eq(watcherEvents.eventType, "file_uploaded")))
      .groupBy(sql`1`),
    db
      .select({
        stoppedAt: watcherEvents.timestamp,
        eventType: watcherEvents.eventType,
        message: watcherEvents.message,
        details: watcherEvents.details,
        // The columns are written out in full: inside a subquery on the same
        // table, a bare "timestamp" would be the subquery's own.
        resumedAt: sql<Date | null>`(
          select min(started.timestamp) from watcher_events as started
          where started.watcher_id = ${sql.raw('"watcher_events"."watcher_id"')}
            and started.event_type = 'watcher_started'
            and started.timestamp > ${sql.raw('"watcher_events"."timestamp"')}
        )`.mapWith((value) => (value ? new Date(value as string) : null)),
      })
      .from(watcherEvents)
      .where(
        and(
          eventsInRange,
          or(isRestartStop("update"), isRestartStop("windows"))
        )
      )
      .orderBy(watcherEvents.timestamp)
      .limit(WINDOW_ROW_LIMIT),
    db
      .select({
        recoveredAt: watcherEvents.timestamp,
        gapSeconds: sql<number>`coalesce(${gapSeconds}, 0)::float8`,
      })
      .from(watcherEvents)
      .where(and(eventsInRange, isMissedHeartbeat))
      .orderBy(watcherEvents.timestamp)
      .limit(WINDOW_ROW_LIMIT),
    db
      .select({ at: min(watcherHeartbeats.timestamp) })
      .from(watcherHeartbeats)
      .where(eq(watcherHeartbeats.watcherId, watcherId)),
    db
      .select({ status: watcherHeartbeats.status })
      .from(watcherHeartbeats)
      .where(
        and(
          eq(watcherHeartbeats.watcherId, watcherId),
          lt(watcherHeartbeats.timestamp, start)
        )
      )
      .orderBy(desc(watcherHeartbeats.timestamp))
      .limit(1),
  ]);

  const restarts: RestartWindow[] = [];
  for (const row of restartRows) {
    const reason = restartReasonOf(row);
    if (reason) {
      restarts.push(restartWindow(row.stoppedAt, reason, row.resumedAt));
    }
  }
  const missed: MissedWindow[] = missedRows.map((row) =>
    missedWindow(row.recoveredAt, row.gapSeconds)
  );

  const heartbeatsByBlock = new Map(
    heartbeatRows.map((row) => [
      `${row.day}|${row.slot}`,
      { heartbeats: row.heartbeats, lastStatus: row.lastStatus },
    ])
  );
  const filesByDay = new Map(fileRows.map((row) => [row.day, row.files]));
  const firstHeartbeatAt = firstHeartbeat?.at ?? null;

  const days: HealthDay[] = [];
  // Whether the watcher's last word before the block was a stop that no restart
  // explains. The silence after such a stop is nothing to worry about.
  let stopped = statusBefore?.status === "stopped";
  for (const day of eachDay(options.fromDay, options.toDay)) {
    const edges = blockEdges(day, timeZone);
    const blocks: HealthBlock[] = [];
    for (let slot = 0; slot < BLOCKS_PER_DAY; slot++) {
      const bounds = { start: edges[slot], end: edges[slot + 1] };
      const seen = heartbeatsByBlock.get(`${day}|${slot}`);
      const heartbeats = seen?.heartbeats ?? 0;
      const touching = { ...bounds, heartbeats };
      const restart = restarts.find((window) =>
        windowTouchesBlock(window, touching)
      );
      const gap = missed.find((window) => windowTouchesBlock(window, touching));

      const classified = classifyBlock({
        ...bounds,
        now,
        heartbeats,
        firstHeartbeatAt,
        deregisteredAt: options.deregisteredAt,
        restarted: restart !== undefined,
        missed: gap !== undefined,
        stoppedBefore: stopped,
      });
      const block: HealthBlock = { ...classified, heartbeats };
      if (classified.state === "restarted" && restart) {
        block.restart = {
          reason: restart.reason,
          stoppedAt: restart.from,
          resumedAt: restart.resumedAt,
        };
      } else if (classified.state === "missed" && gap) {
        block.missed = {
          gapSeconds: gap.gapSeconds,
          recoveredAt: gap.recoveredAt,
        };
      }
      blocks.push(block);

      if (seen) {
        stopped =
          seen.lastStatus === "stopped" &&
          !restarts.some(
            (window) =>
              window.from.getTime() >= bounds.start.getTime() - STOP_MATCH_MS &&
              window.from.getTime() < bounds.end.getTime() + STOP_MATCH_MS
          );
      }
    }
    days.push({ date: day, files: filesByDay.get(day) ?? 0, blocks });
  }

  return {
    days,
    totals: {
      files: counts.files,
      runs: counts.runs,
      uploadFailures: counts.uploadFailures,
      restarts: {
        update: counts.restartsForUpdate,
        windows: counts.restartsForWindows,
      },
      missedHeartbeats: counts.missedHeartbeats,
      longestMissedSeconds: counts.longestMissedSeconds,
      daysWithFiles: days.filter((day) => day.files > 0).map((day) => day.date),
    },
  };
}
