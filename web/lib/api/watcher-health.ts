import {
  and,
  desc,
  eq,
  gte,
  inArray,
  lt,
  lte,
  min,
  type SQL,
  sql,
} from "drizzle-orm";
import { STALE_THRESHOLD_MS } from "@/lib/api/watcher-status";
import { db } from "@/lib/db";
import { watcherEvents, watcherHeartbeats } from "@/lib/db/schema";
import { BLOCKS_PER_DAY, blockEdges } from "@/lib/watchers/block-edges";
import {
  classifyBlock,
  type HealthBlock,
  type HealthDay,
  type HeartbeatGap,
  type MissedWindow,
  missedWindow,
  RESTART_GRACE_MS,
  type RestartWindow,
  restartWindow,
  seriesEnd,
  silenceInBlock,
  stopIsRestart,
  unexplainedSilences,
  type WatcherHealth,
  windowTouchesBlock,
} from "@/lib/watchers/health";
import { eachDay } from "@/lib/watchers/range";
import {
  OTHER_STOP_CAUSE_PATTERN,
  RESTART_STOP_FRAGMENTS,
  type RestartReason,
  STOP_REASON_KEY,
  STOP_REASON_OF_RESTART,
  UPDATE_STOP_WINDOW_MS,
  UPLOAD_REQUESTS_CANCELLED_KIND,
} from "@/lib/watchers/stop-reasons";

// A watcher that restarts dozens of times a day, or loses its connection that
// often, is already telling the story with the first of these. The counts under
// the cards come from their own query and are never cut.
const WINDOW_ROW_LIMIT = 1000;

// A stop's heartbeat and its event are sent together, so they land within this
// of each other.
const STOP_MATCH_MS = 2 * 60 * 1000;

const MIN_MS = 60 * 1000;

const STOP_REASON_FIELD = sql.raw(`'${STOP_REASON_KEY}'`);

/** The outer `watcher_events` row, for a subquery that correlates with it. */
const outer = (column: "watcher_id" | "timestamp") =>
  sql.raw(`"watcher_events"."${column}"`);

/**
 * Whether a `watcher_stopped` row follows an update the watcher handed to the
 * upgrade worker (`update_started` with `via_worker`): within
 * `UPDATE_STOP_WINDOW_MS` of it, with no `update_failed` and no start of the
 * watcher in between. That is how a Windows PC that installs an update stops:
 * the worker stops the service from outside, so the stop's own message can't say
 * why. References the outer `watcher_events` row.
 */
export const afterUpdateStart = sql`exists (
  select 1 from watcher_events as started
  where started.watcher_id = ${outer("watcher_id")}
    and started.event_type = 'update_started'
    and started.details->>'via_worker' = 'true'
    and started.timestamp <= ${outer("timestamp")}
    and started.timestamp > ${outer("timestamp")}
      - ${sql.raw(String(UPDATE_STOP_WINDOW_MS / 1000))} * interval '1 second'
    and not exists (
      select 1 from watcher_events as between_events
      where between_events.watcher_id = started.watcher_id
        and between_events.event_type in ('update_failed', 'watcher_started')
        and between_events.timestamp >= started.timestamp
        and between_events.timestamp < ${outer("timestamp")}
    )
)`;

/**
 * The restart a `watcher_stopped` row records, `'update'` or `'windows'`, or
 * null for any other row. The same rules, in the same order, as `restartReasonOf`
 * in `lib/watchers/stop-reasons.ts`:
 *
 * 1. the reason the server copied from the final heartbeat;
 * 2. a stop that follows an update handed to the upgrade worker, unless its
 *    message names another cause;
 * 3. what its message says.
 */
const restartReason = sql<RestartReason | null>`case
  when ${watcherEvents.eventType} <> 'watcher_stopped'
    or coalesce(${watcherEvents.details}->>'kind', '') = ${UPLOAD_REQUESTS_CANCELLED_KIND}
    then null
  when ${watcherEvents.details}->>${STOP_REASON_FIELD} = ${STOP_REASON_OF_RESTART.update}
    then 'update'
  when ${watcherEvents.details}->>${STOP_REASON_FIELD} = ${STOP_REASON_OF_RESTART.windows}
    then 'windows'
  when ${watcherEvents.message} !~* ${OTHER_STOP_CAUSE_PATTERN}
    and ${afterUpdateStart}
    then 'update'
  when ${watcherEvents.message} ilike ${`%${RESTART_STOP_FRAGMENTS.update}%`}
    then 'update'
  when ${watcherEvents.message} ilike ${`%${RESTART_STOP_FRAGMENTS.windows}%`}
    then 'windows'
end`;

/**
 * The `watcher_stopped` events that record a restart among those `where`
 * selects, oldest first, each with the watcher's next start.
 */
function restartStops(where: SQL | undefined) {
  return db
    .select({
      stoppedAt: watcherEvents.timestamp,
      reason: restartReason,
      // The columns are written out in full: inside a subquery on the same
      // table, a bare "timestamp" would be the subquery's own.
      resumedAt: sql<Date | null>`(
        select min(started.timestamp) from watcher_events as started
        where started.watcher_id = ${outer("watcher_id")}
          and started.event_type = 'watcher_started'
          and started.timestamp > ${outer("timestamp")}
      )`.mapWith((value) => (value ? new Date(value as string) : null)),
    })
    .from(watcherEvents)
    .where(and(where, sql`${restartReason} is not null`))
    .orderBy(watcherEvents.timestamp)
    .limit(WINDOW_ROW_LIMIT);
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

/**
 * Which of these `watcher_stopped` events follow an update the watcher handed
 * to the upgrade worker, for Activity to tell an update restart from any other
 * stop (see `afterUpdateStart`).
 */
export async function getStopsAfterUpdateStart(
  watcherId: string,
  eventIds: number[]
): Promise<Set<number>> {
  if (eventIds.length === 0) {
    return new Set();
  }
  const rows = await db
    .select({ id: watcherEvents.id })
    .from(watcherEvents)
    .where(
      and(
        eq(watcherEvents.watcherId, watcherId),
        eq(watcherEvents.eventType, "watcher_stopped"),
        inArray(watcherEvents.id, eventIds),
        afterUpdateStart
      )
    );
  return new Set(rows.map((row) => row.id));
}

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

/**
 * What the Health tab needs about one watcher over a range of days, worked out
 * in the database so that a month of one-a-minute heartbeats never leaves it:
 *
 * - heartbeats grouped into 30-minute blocks of each day, by the blocks' own
 *   edges (`blockEdges`), which are real moments, so a day with a clock change
 *   groups the same way the grid draws it;
 * - the gaps of five minutes or more between heartbeats;
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
  const closeAt = seriesEnd(now, endExclusive, options.deregisteredAt);

  const dayList = eachDay(options.fromDay, options.toDay);
  const edgesByDay = dayList.map((day) => blockEdges(day, timeZone));
  // The start of every block in the range, oldest first, for the database to
  // sort a timestamp into its block (`width_bucket` counts the starts at or
  // before it). Blocks that share a start, such as the two that a skipped hour
  // leaves empty, give the one after them every heartbeat.
  const blockStarts = edgesByDay.flatMap((edges) =>
    edges.slice(0, BLOCKS_PER_DAY)
  );
  const blockStartsArray = sql`${`{${blockStarts.map((edge) => edge.toISOString()).join(",")}}`}::timestamptz[]`;

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

  const [
    heartbeatRows,
    gapResult,
    [counts],
    fileRows,
    restartRows,
    missedRows,
    [firstHeartbeat],
    [heartbeatBefore],
  ] = await Promise.all([
    // Grouped by position: the expression carries the block starts as a
    // parameter, and the database doesn't match two parameters as the same.
    db
      .select({
        block: sql<number>`width_bucket(${watcherHeartbeats.timestamp}, ${blockStartsArray})`,
        heartbeats: sql<number>`count(*)::int`,
        lastStatus: sql<string>`(array_agg(${watcherHeartbeats.status} order by ${watcherHeartbeats.timestamp} desc))[1]`,
        lastAtMs: sql<number>`(extract(epoch from max(${watcherHeartbeats.timestamp})) * 1000)::float8`,
      })
      .from(watcherHeartbeats)
      .where(heartbeatsInRange)
      .groupBy(sql`1`),
    // Consecutive heartbeats at least the stale threshold apart. The series
    // starts at the last heartbeat before the range and ends at the first
    // after it, so a gap over the range's edge is seen from the inside. When
    // nothing follows the last heartbeat, the series is closed at `closeAt`
    // (the earliest of now, the range's end and the deregistration), so an
    // outage that is still going on is a gap too.
    db.execute<{ from_ms: number; previous_status: string; to_ms: number }>(sql`
      with series as (
        (select "timestamp" as at, status from watcher_heartbeats
          where watcher_id = ${watcherId} and "timestamp" < ${start.toISOString()}::timestamptz
          order by "timestamp" desc limit 1)
        union all
        (select "timestamp", status from watcher_heartbeats
          where watcher_id = ${watcherId}
            and "timestamp" >= ${start.toISOString()}::timestamptz
            and "timestamp" < ${endExclusive.toISOString()}::timestamptz)
        union all
        (select "timestamp", status from watcher_heartbeats
          where watcher_id = ${watcherId} and "timestamp" >= ${endExclusive.toISOString()}::timestamptz
          order by "timestamp" asc limit 1)
        union all
        (select ${closeAt.toISOString()}::timestamptz, null::text
          where not exists (
            select 1 from watcher_heartbeats
            where watcher_id = ${watcherId} and "timestamp" >= ${closeAt.toISOString()}::timestamptz
          ))
      ), paired as (
        select lag(at) over (order by at) as "from",
          lag(status) over (order by at) as previous_status,
          at as "to"
        from series
      )
      select (extract(epoch from "from") * 1000)::float8 as from_ms,
        previous_status,
        (extract(epoch from "to") * 1000)::float8 as to_ms
      from paired
      where "from" is not null
        and "to" - "from" >= ${STALE_THRESHOLD_MS / 1000}::float8 * interval '1 second'
      order by "to"
      limit ${WINDOW_ROW_LIMIT}
    `),
    db
      .select({
        files: sql<number>`count(*) filter (where ${watcherEvents.eventType} = 'file_uploaded')::int`,
        runs: sql<number>`count(distinct ${uploadRun})::int`,
        // A file that can't be read yet is waited for, not failed.
        uploadFailures: sql<number>`count(*) filter (where ${watcherEvents.eventType} = 'upload_failed' and coalesce(${watcherEvents.details}->>'will_retry', '') <> 'true')::int`,
        restartsForUpdate: sql<number>`count(*) filter (where ${restartReason} = 'update')::int`,
        restartsForWindows: sql<number>`count(*) filter (where ${restartReason} = 'windows')::int`,
        missedHeartbeats: sql<number>`count(*) filter (where ${isMissedHeartbeat})::int`,
        longestMissedSeconds: sql<number>`coalesce(max(${gapSeconds}) filter (where ${isMissedHeartbeat}), 0)::float8`,
      })
      .from(watcherEvents)
      .where(eventsInRange),
    db
      .select({
        // The block's index over 48 is its day's.
        day: sql<number>`(width_bucket(${watcherEvents.timestamp}, ${blockStartsArray}) - 1) / ${BLOCKS_PER_DAY}`,
        files: sql<number>`count(*)::int`,
      })
      .from(watcherEvents)
      .where(and(eventsInRange, eq(watcherEvents.eventType, "file_uploaded")))
      .groupBy(sql`1`),
    // Restarts from a grace period before the range too: one that began just
    // before it still explains the quiet at its start. The counts above are
    // the range's alone.
    restartStops(
      and(
        eq(watcherEvents.watcherId, watcherId),
        gte(
          watcherEvents.timestamp,
          new Date(start.getTime() - RESTART_GRACE_MS)
        ),
        lt(watcherEvents.timestamp, endExclusive)
      )
    ),
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
      .select({
        status: watcherHeartbeats.status,
        at: watcherHeartbeats.timestamp,
      })
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
    if (row.reason) {
      restarts.push(restartWindow(row.stoppedAt, row.reason, row.resumedAt));
    }
  }
  // The watcher's last word before the range may be a stop for a restart from
  // long before it: the watcher was left down after an update, and the range
  // opens in the middle of that. The grace period before the range doesn't reach
  // it, so find the stop's event on its own, by its time alone.
  if (
    heartbeatBefore?.status === "stopped" &&
    !stopIsRestart(restarts, heartbeatBefore.at, STOP_MATCH_MS)
  ) {
    const [earlier] = await restartStops(
      and(
        eq(watcherEvents.watcherId, watcherId),
        gte(
          watcherEvents.timestamp,
          new Date(heartbeatBefore.at.getTime() - STOP_MATCH_MS)
        ),
        lte(
          watcherEvents.timestamp,
          new Date(heartbeatBefore.at.getTime() + STOP_MATCH_MS)
        )
      )
    );
    if (earlier?.reason) {
      restarts.push(
        restartWindow(earlier.stoppedAt, earlier.reason, earlier.resumedAt)
      );
    }
  }
  const missed: MissedWindow[] = missedRows.map((row) =>
    missedWindow(row.recoveredAt, row.gapSeconds)
  );
  const gaps: HeartbeatGap[] = gapResult.rows.map((row) => ({
    from: new Date(row.from_ms),
    previousStatus: row.previous_status,
    to: new Date(row.to_ms),
  }));
  const silences = unexplainedSilences(gaps, restarts, missed, STOP_MATCH_MS);

  // A block's index over the whole range: a day's 48 blocks follow the day
  // before's.
  const heartbeatsByBlock = new Map(
    heartbeatRows.map((row) => [
      row.block - 1,
      {
        heartbeats: row.heartbeats,
        lastStatus: row.lastStatus,
        lastAt: new Date(row.lastAtMs),
      },
    ])
  );
  const filesByDay = new Map(fileRows.map((row) => [row.day, row.files]));
  const firstHeartbeatAt = firstHeartbeat?.at ?? null;

  const days: HealthDay[] = [];
  // Whether the watcher's last word before the block was a stop that no restart
  // explains. The silence after such a stop is nothing to worry about. At the
  // range's start that is the last heartbeat before it, a stop that a restart
  // from before the range may well explain.
  let stopped =
    heartbeatBefore?.status === "stopped" &&
    !stopIsRestart(restarts, heartbeatBefore.at, STOP_MATCH_MS);
  dayList.forEach((day, dayIndex) => {
    const edges = edgesByDay[dayIndex];
    const blocks: HealthBlock[] = [];
    for (let slot = 0; slot < BLOCKS_PER_DAY; slot++) {
      const bounds = { start: edges[slot], end: edges[slot + 1] };
      const seen = heartbeatsByBlock.get(dayIndex * BLOCKS_PER_DAY + slot);
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
        silent: heartbeats > 0 && silenceInBlock(silences, bounds),
        stoppedBefore: stopped,
      });
      const block: HealthBlock = {
        ...classified,
        heartbeats,
        minutes: Math.round(
          (bounds.end.getTime() - bounds.start.getTime()) / MIN_MS
        ),
      };
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
          !stopIsRestart(restarts, seen.lastAt, STOP_MATCH_MS);
      }
    }
    days.push({ date: day, files: filesByDay.get(dayIndex) ?? 0, blocks });
  });

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
