// Watcher status rules that need no database. Server code and client
// components both import them from this file, so it must not import `@/lib/db`
// or anything that does.

// The `status_reason` on the `stopped` heartbeat of a watcher that stopped
// because Windows is shutting down or restarting. Such a PC is expected back, so
// the heartbeat route keeps its instrument's upload requests queued for the
// watcher to drain after the restart. Must match the watcher's
// `SYSTEM_SHUTDOWN_STATUS_REASON`.
export const SYSTEM_SHUTDOWN_STATUS_REASON = "system_shutdown";

// The `status_reason` on the `stopped` heartbeat of a watcher that stops to
// install an automatic update and start again. A watcher that sends it is
// expected back like one that stopped for a restart. Watcher 1.4.2 and later
// send it.
export const AUTO_UPDATE_STATUS_REASON = "auto_update";

// The reasons of a stop after which the watcher is expected back. A watcher
// that stopped for one of these keeps it as its `status_reason`, keeps its
// instrument's upload requests queued, and reads Unresponsive if no heartbeat
// follows within `UPLOAD_REQUEST_REVERT_GRACE_MS`.
export const RESTART_STOP_REASONS = [
  SYSTEM_SHUTDOWN_STATUS_REASON,
  AUTO_UPDATE_STATUS_REASON,
] as const;

export type RestartStopReason = (typeof RESTART_STOP_REASONS)[number];

export function isRestartStopReason(
  reason: string | null | undefined
): reason is RestartStopReason {
  return RESTART_STOP_REASONS.some((restartReason) => restartReason === reason);
}

// Sweep window, wider than the 5-minute online threshold so a brief heartbeat
// blip doesn't churn the queue. The graceful-stop path skips it: an explicit
// stop is intentional and reverts immediately. The exception is a stop for a
// restart (see `RESTART_STOP_REASONS`), which waits for this window like a
// watcher that died: the sweep cancels its requests if the watcher doesn't
// come back. The same window decides when such a watcher reads Unresponsive.
export const UPLOAD_REQUEST_REVERT_GRACE_MS = 15 * 60 * 1000;

// A `watching` or `waiting` watcher reads `stale` once its last heartbeat is
// older than this, even though the database still says `watching`. The SQL
// mirror, `effectiveStatusCondition` in `lib/api/watchers.ts`, uses it too.
export const STALE_THRESHOLD_MS = 5 * 60 * 1000;

export interface WatcherLike {
  /** Set when the watcher was deregistered. */
  deletedAt: Date | null;
  lastHeartbeatAt: Date | null;
  status: string;
  /** Why the watcher is `waiting`, or why it `stopped` for a restart. */
  statusReason: string | null;
}

export const EFFECTIVE_STATUSES = [
  "registered",
  "watching",
  "waiting",
  "stopped",
  "stale",
] as const;

export type EffectiveStatus = (typeof EFFECTIVE_STATUSES)[number];

/**
 * Derives the display status from stored status, stop reason, and heartbeat
 * recency. "stale" is never stored in the DB: it's a virtual status computed
 * here, and `effectiveStatusCondition` in `lib/api/watchers.ts` must agree with it.
 *
 * - Deregistered: always `stopped`. It can no longer send heartbeats, so
 *   staleness is moot, whatever it reported last.
 * - `registered`: no heartbeat yet, so it is exempt from staleness checks.
 * - `watching` and `waiting`: `stale` once the last heartbeat is more than
 *   `STALE_THRESHOLD_MS` old, or missing.
 * - `stopped` for a restart (see `RESTART_STOP_REASONS`): the watcher is
 *   expected back, so it reads `stale` once the last heartbeat is more than
 *   `UPLOAD_REQUEST_REVERT_GRACE_MS` old, or missing.
 * - Any other `stopped`: always `stopped`. The watcher said it was stopping,
 *   so it can't send another heartbeat and its silence is not a fault.
 */
export function computeEffectiveStatus(
  watcher: WatcherLike,
  now: Date = new Date()
): EffectiveStatus {
  if (watcher.deletedAt) {
    return "stopped";
  }

  if (watcher.status === "registered") {
    return "registered";
  }

  const age = watcher.lastHeartbeatAt
    ? now.getTime() - watcher.lastHeartbeatAt.getTime()
    : Number.POSITIVE_INFINITY;

  if (watcher.status === "stopped") {
    const expectedBack = isRestartStopReason(watcher.statusReason);
    return expectedBack && age > UPLOAD_REQUEST_REVERT_GRACE_MS
      ? "stale"
      : "stopped";
  }

  return age > STALE_THRESHOLD_MS
    ? "stale"
    : (watcher.status as EffectiveStatus);
}
