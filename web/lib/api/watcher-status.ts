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
// install an update and start again. A watcher that sends it is expected back
// like one that stopped for a restart. Watcher 1.4.2 and later send it.
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
