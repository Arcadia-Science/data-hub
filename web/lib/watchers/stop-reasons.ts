// Why a watcher stopped, read from its `watcher_stopped` event. No database
// imports; the SQL that counts the same restarts is in `lib/api/watcher-health.ts`
// and follows the same rules, in the same order.
//
// The watcher's own `watcher_stopped` event has no reason field, and on a
// Windows PC that installs an update through the upgrade worker its message is
// only "Service stopped": the worker stops the service from outside, so the
// message can't say why. The reason exists in the final `stopped` heartbeat
// (`status_reason`: `auto_update` or `system_shutdown`). So the server copies it
// onto the event, as `details.stop_reason`, when both have arrived
// (`lib/api/watcher-stop-reasons.ts`). A stop is a restart, from the first rule
// that fits:
//
// 1. its `details.stop_reason` says so;
// 2. it follows an `update_started` that the watcher sent through the upgrade
//    worker, within `UPDATE_STOP_WINDOW_MS`, with no `update_failed` between,
//    and its message doesn't name another cause (events from before the server
//    stamped the reason);
// 3. its message says so: "restarting for auto-update" or "Windows is shutting
//    down" (what `classify_shutdown` writes in `watcher/src/data_hub_watcher/`
//    when the process itself knows).

import {
  AUTO_UPDATE_STATUS_REASON,
  SYSTEM_SHUTDOWN_STATUS_REASON,
} from "@/lib/api/watcher-status";

/**
 * The text of a `watcher_stopped` message for each stop that is a restart,
 * lowercase. A restart is a stop the watcher is expected to come back from.
 */
export const RESTART_STOP_FRAGMENTS = {
  update: "restarting for auto-update",
  windows: "windows is shutting down",
} as const;

export type RestartReason = keyof typeof RESTART_STOP_FRAGMENTS;

/** The `details` key that holds the reason the server copied from the final heartbeat. */
export const STOP_REASON_KEY = "stop_reason";

/** What the final heartbeat's `status_reason` means for the stop before it. */
export const RESTART_REASON_OF_STATUS_REASON: Record<string, RestartReason> = {
  [AUTO_UPDATE_STATUS_REASON]: "update",
  [SYSTEM_SHUTDOWN_STATUS_REASON]: "windows",
};

/** The `details.stop_reason` that records each restart, as the heartbeat sends it. */
export const STOP_REASON_OF_RESTART: Record<RestartReason, string> = {
  update: AUTO_UPDATE_STATUS_REASON,
  windows: SYSTEM_SHUTDOWN_STATUS_REASON,
};

/**
 * How long after the watcher hands an update to the upgrade worker a stop still
 * counts as that update's. The worker has `UPGRADE_HANDOFF_TIMEOUT_SECONDS`
 * (ten minutes) to stop the service before the watcher gives up on it.
 */
export const UPDATE_STOP_WINDOW_MS = 10 * 60 * 1000;

/**
 * A message that names another cause for a stop. Such a stop is never taken for
 * an update restart because an update began a moment earlier. A JavaScript and a
 * POSIX regular expression both read this one, and it is matched without regard
 * to case.
 */
export const OTHER_STOP_CAUSE_PATTERN =
  "stopped by user|registration was deleted|environment switched|windows is shutting down";

/**
 * The server writes `watcher_stopped` rows of its own when it cancels upload
 * requests (`revertUploadQueueIfWatcherOffline`). They say nothing about the
 * watcher stopping, so they are never restarts.
 */
export const UPLOAD_REQUESTS_CANCELLED_KIND = "upload_requests_cancelled";

function detailsOf(details: unknown): Record<string, unknown> {
  return typeof details === "object" && details !== null
    ? (details as Record<string, unknown>)
    : {};
}

function detailsKind(details: unknown): string | null {
  const { kind } = detailsOf(details);
  return typeof kind === "string" ? kind : null;
}

/** The restart reason copied onto a stop event from its final heartbeat, if any. */
export function stampedRestartReason(details: unknown): RestartReason | null {
  const stamped = detailsOf(details)[STOP_REASON_KEY];
  return typeof stamped === "string"
    ? (RESTART_REASON_OF_STATUS_REASON[stamped] ?? null)
    : null;
}

/** Whether a stop event has had its reason copied onto it. */
export function hasStopReason(details: unknown): boolean {
  return typeof detailsOf(details)[STOP_REASON_KEY] === "string";
}

const OTHER_STOP_CAUSE = new RegExp(OTHER_STOP_CAUSE_PATTERN, "i");

/**
 * The restart a `watcher_stopped` event records, or null when it records any
 * other stop (by a person, a deregistration, an environment switch) or is one of
 * the server's own notes.
 *
 * `afterUpdateStart` is whether the event follows an update the watcher handed
 * to the upgrade worker (rule 2 above); only a query over the neighbouring
 * events can tell, so the caller passes it.
 */
export function restartReasonOf(event: {
  eventType: string;
  message: string;
  details?: unknown;
  afterUpdateStart?: boolean;
}): RestartReason | null {
  if (
    event.eventType !== "watcher_stopped" ||
    detailsKind(event.details) === UPLOAD_REQUESTS_CANCELLED_KIND
  ) {
    return null;
  }
  const stamped = stampedRestartReason(event.details);
  if (stamped) {
    return stamped;
  }
  if (event.afterUpdateStart && !OTHER_STOP_CAUSE.test(event.message)) {
    return "update";
  }
  const message = event.message.toLowerCase();
  for (const [reason, fragment] of Object.entries(RESTART_STOP_FRAGMENTS)) {
    if (message.includes(fragment)) {
      return reason as RestartReason;
    }
  }
  return null;
}

/**
 * How far apart a stop's event and its final heartbeat can be and still belong
 * together. The watcher sends them within seconds of each other; the rest is
 * for a slow network and a clock that is a little off.
 */
export const STOP_STAMP_WINDOW_MS = 5 * 60 * 1000;

/** The details of a stop event with the restart reason copied onto it. */
export function stampedDetails(
  details: unknown,
  statusReason: string
): Record<string, unknown> {
  return { ...detailsOf(details), [STOP_REASON_KEY]: statusReason };
}

/**
 * Whether the server may copy a reason onto this event: a stop with no reason
 * yet, whose message doesn't name another cause. A stop that says "Stopped by
 * user" is never the one a restart heartbeat is about, even if it is the nearest
 * one.
 */
export function canStampStop(event: {
  eventType: string;
  details?: unknown;
  message?: string;
}): boolean {
  return (
    event.eventType === "watcher_stopped" &&
    !OTHER_STOP_CAUSE.test(event.message ?? "") &&
    detailsKind(event.details) !== UPLOAD_REQUESTS_CANCELLED_KIND &&
    !hasStopReason(event.details) &&
    (event.details === null ||
      event.details === undefined ||
      (typeof event.details === "object" && !Array.isArray(event.details)))
  );
}

/**
 * The events of a batch the watcher is posting, with the restart reason copied
 * onto the batch's last stop when the watcher's final `stopped` heartbeat came
 * first (see `lib/api/watcher-stop-reasons.ts` for the other order). That
 * heartbeat left its reason on the watcher's row, and a stop that is not within
 * `STOP_STAMP_WINDOW_MS` of it, a stop that names another cause, a stop that the
 * batch's own `watcher_started` follows before the heartbeat (a new session, so
 * the heartbeat is not about it), or a watcher that has since sent anything
 * else, gets nothing. A reason already on an event is never replaced.
 *
 * Neither route stamps in one rare order: the events request reads the watcher's
 * row before the heartbeat updates it, and inserts after the heartbeat has
 * looked for the event. The stop then has no reason, and rules 2 and 3 above
 * still classify it.
 */
export function stampNewStopEvents<
  T extends {
    eventType: string;
    details?: unknown;
    message: string;
    timestamp: Date;
  },
>(
  events: T[],
  watcher: {
    status: string;
    statusReason: string | null;
    lastHeartbeatAt: Date | null;
  },
  now: Date
): T[] {
  const { statusReason, lastHeartbeatAt } = watcher;
  if (
    watcher.status !== "stopped" ||
    !statusReason ||
    !(statusReason in RESTART_REASON_OF_STATUS_REASON) ||
    !lastHeartbeatAt ||
    now.getTime() - lastHeartbeatAt.getTime() > STOP_STAMP_WINDOW_MS
  ) {
    return events;
  }
  const startedAt = events
    .filter((event) => event.eventType === "watcher_started")
    .map((event) => event.timestamp.getTime());
  let target = -1;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const stoppedAt = event.timestamp.getTime();
    if (
      canStampStop(event) &&
      !startedAt.some(
        (started) => started > stoppedAt && started <= lastHeartbeatAt.getTime()
      ) &&
      Math.abs(event.timestamp.getTime() - lastHeartbeatAt.getTime()) <=
        STOP_STAMP_WINDOW_MS &&
      (target === -1 || event.timestamp >= events[target].timestamp)
    ) {
      target = i;
    }
  }
  if (target === -1) {
    return events;
  }
  return events.map((event, i) =>
    i === target
      ? { ...event, details: stampedDetails(event.details, statusReason) }
      : event
  );
}
