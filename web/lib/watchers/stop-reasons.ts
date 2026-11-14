// Why a watcher stopped, read from its `watcher_stopped` event. The event has no
// reason field: the watcher says why in the message it sends (`classify_shutdown`
// in `watcher/src/data_hub_watcher/runtime.py`, and `service.py` for a Windows
// shutdown). The Health query matches the same fragments in SQL, so this file is
// the one place that knows them. No database imports.

/**
 * The text of a `watcher_stopped` message for each stop that is a restart,
 * lowercase. A restart is a stop the watcher is expected to come back from.
 */
export const RESTART_STOP_FRAGMENTS = {
  update: "restarting for auto-update",
  windows: "windows is shutting down",
} as const;

export type RestartReason = keyof typeof RESTART_STOP_FRAGMENTS;

/**
 * The server writes `watcher_stopped` rows of its own when it cancels upload
 * requests (`revertUploadQueueIfWatcherOffline`). They say nothing about the
 * watcher stopping, so they are never restarts.
 */
export const UPLOAD_REQUESTS_CANCELLED_KIND = "upload_requests_cancelled";

function detailsKind(details: unknown): string | null {
  if (typeof details === "object" && details !== null && "kind" in details) {
    const { kind } = details as { kind: unknown };
    return typeof kind === "string" ? kind : null;
  }
  return null;
}

/**
 * The restart a `watcher_stopped` event records, or null when it records any
 * other stop (by a person, a deregistration, an environment switch) or is one of
 * the server's own notes.
 */
export function restartReasonOf(event: {
  eventType: string;
  message: string;
  details?: unknown;
}): RestartReason | null {
  if (
    event.eventType !== "watcher_stopped" ||
    detailsKind(event.details) === UPLOAD_REQUESTS_CANCELLED_KIND
  ) {
    return null;
  }
  const message = event.message.toLowerCase();
  for (const [reason, fragment] of Object.entries(RESTART_STOP_FRAGMENTS)) {
    if (message.includes(fragment)) {
      return reason as RestartReason;
    }
  }
  return null;
}
