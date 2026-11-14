import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { watcherEvents } from "@/lib/db/schema";
import {
  OTHER_STOP_CAUSE_PATTERN,
  STOP_REASON_KEY,
  STOP_STAMP_WINDOW_MS,
  UPLOAD_REQUESTS_CANCELLED_KIND,
} from "@/lib/watchers/stop-reasons";

// The final `stopped` heartbeat of a watcher that is restarting says why
// (`status_reason`); its `watcher_stopped` event, on a Windows PC that installs
// an update through the upgrade worker, only says "Service stopped". This
// copies the reason onto the event, into `details`, so Activity and Health can
// tell a restart from any other stop. The two arrive in either order: this file
// handles the heartbeat after the event, and `stampNewStopEvents` in
// `lib/watchers/stop-reasons.ts` the event after the heartbeat. Neither
// replaces a reason that is already there, and neither adds a column.
//
// One order gets neither: the events request reads the watcher's row before the
// heartbeat updates it, and inserts after the heartbeat has looked for the
// event. The stop is then left without a reason, and the classification's other
// rules (an update handed to the worker, what the message says) still read it.

/**
 * Copies a restart reason from a `stopped` heartbeat onto the watcher's most
 * recent `watcher_stopped` event within `STOP_STAMP_WINDOW_MS` before it, if
 * that event has no reason yet. Returns whether it stamped one.
 */
export async function stampStopReasonOnRecentStop(
  watcherId: string,
  statusReason: string,
  heartbeatAt: Date
): Promise<boolean> {
  const details = watcherEvents.details;
  const stampable = and(
    eq(watcherEvents.watcherId, watcherId),
    eq(watcherEvents.eventType, "watcher_stopped"),
    gte(
      watcherEvents.timestamp,
      new Date(heartbeatAt.getTime() - STOP_STAMP_WINDOW_MS)
    ),
    // The watcher writes its event before the final heartbeat, so a stop after
    // the heartbeat is the next one's. A minute is for a clock a little off.
    lte(watcherEvents.timestamp, new Date(heartbeatAt.getTime() + 60_000)),
    sql`(${details} is null or jsonb_typeof(${details}) = 'object')`,
    sql`coalesce(${details}->>'kind', '') <> ${UPLOAD_REQUESTS_CANCELLED_KIND}`,
    // A stop that names another cause is never this heartbeat's.
    sql`${watcherEvents.message} !~* ${OTHER_STOP_CAUSE_PATTERN}`,
    // Nor is one the watcher started again after, before this heartbeat: the
    // heartbeat belongs to a later session. The columns are written out in full
    // because the subquery refers to the row it filters.
    sql`not exists (
      select 1 from watcher_events as started
      where started.watcher_id = "watcher_events"."watcher_id"
        and started.event_type = 'watcher_started'
        and started.timestamp > "watcher_events"."timestamp"
        and started.timestamp <= ${heartbeatAt.toISOString()}::timestamptz
    )`,
    sql`${details}->>${STOP_REASON_KEY}::text is null`
  );
  const [target] = await db
    .select({ id: watcherEvents.id })
    .from(watcherEvents)
    .where(stampable)
    .orderBy(desc(watcherEvents.timestamp))
    .limit(1);
  if (!target) {
    return false;
  }
  // The conditions are repeated so that two heartbeats can't both write.
  const updated = await db
    .update(watcherEvents)
    .set({
      details: sql`coalesce(${details}, '{}'::jsonb) || jsonb_build_object(${STOP_REASON_KEY}::text, ${statusReason}::text)`,
    })
    .where(and(eq(watcherEvents.id, target.id), stampable))
    .returning({ id: watcherEvents.id });
  return updated.length > 0;
}
