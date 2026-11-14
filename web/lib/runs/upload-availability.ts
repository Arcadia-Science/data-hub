// Whether a run's files can be requested for upload, and what to tell the
// viewer when they can't or when the wait is expected. Decided from the
// instrument badge, so the run page, its Upload buttons and the upload-request
// routes follow one table. No database imports: client components and server
// code both import this file.

import type { InstrumentBadgeState } from "@/lib/instruments/connection";

/**
 * How the line beside an Upload button reads. `info` is the blue of a routine
 * restart, `destructive` the red of an offline watcher, and `muted` the plain
 * grey of a state that needs no alarm.
 */
export type UploadReasonTone = "destructive" | "info" | "muted";

export interface RunUploadAvailability {
  /** Whether Upload requests are accepted. */
  enabled: boolean;
  /**
   * The line shown beside the button, and the button's tooltip and
   * description. Null when nothing needs saying.
   */
  reason: string | null;
  tone: UploadReasonTone | null;
}

export const RESTARTING_UPLOAD_REASON =
  "The instrument PC is restarting. Uploads start once it's back.";
export const CONNECTING_UPLOAD_REASON = "The watcher hasn't checked in yet.";
export const OFFLINE_UPLOAD_REASON =
  "Can't upload while the watcher is offline.";
export const RETIRED_UPLOAD_REASON = "This instrument is retired.";

/**
 * The run page's upload table, by badge state:
 *
 * - Online: Upload enabled, no text.
 * - Restarting: Upload enabled, with a blue line. Requests queue until the
 *   watcher is back.
 * - Connecting: Upload disabled, with a grey line.
 * - Offline: Upload disabled, with a red line.
 * - Retired: Upload disabled, with a grey line.
 *
 * The design's table has no Pending row, because a pending instrument's page
 * shows a "Waiting for confirmation" card in place of its runs. A run of a
 * pending instrument can still be opened by its URL, and it reads like
 * Connecting: not ready to take uploads, with no new copy to write.
 *
 * Requests made while the watcher restarts queue until it is back. Data Hub
 * cancels them if no heartbeat follows within `UPLOAD_REQUEST_REVERT_GRACE_MS`,
 * and that rule is unchanged.
 */
export function getRunUploadAvailability(
  badge: InstrumentBadgeState
): RunUploadAvailability {
  switch (badge) {
    case "online":
      return { enabled: true, reason: null, tone: null };
    case "restarting":
      return { enabled: true, reason: RESTARTING_UPLOAD_REASON, tone: "info" };
    case "connecting":
    case "pending":
      return {
        enabled: false,
        reason: CONNECTING_UPLOAD_REASON,
        tone: "muted",
      };
    case "offline":
      return {
        enabled: false,
        reason: OFFLINE_UPLOAD_REASON,
        tone: "destructive",
      };
    case "retired":
      return { enabled: false, reason: RETIRED_UPLOAD_REASON, tone: "muted" };
    default:
      return badge satisfies never;
  }
}
