// The one notice at the top of a watcher's Settings tab. No database imports,
// so the page and its tests share one definition.

import { type Actor, actorDisplayName } from "@/lib/api/actor";
import {
  deriveConfigState,
  type InstrumentWatcherConfigState,
} from "@/lib/instruments/connection";

export type ConfigNoticeKind = Extract<
  InstrumentWatcherConfigState,
  "pending" | "rejected" | "edited_on_pc"
>;

/**
 * The notice for the latest settings state, or null when there is nothing to
 * say. `latestStatus` is the status of the current revision (the newest one
 * that wasn't superseded), and `pcEditAwaitingRestart` is true while an edit
 * made on the PC waits for the watcher to restart. Applied shows no notice.
 */
export function configNoticeKind(
  latestStatus: "pending" | "applied" | "rejected" | "superseded" | null,
  pcEditAwaitingRestart: boolean
): ConfigNoticeKind | null {
  const state = deriveConfigState(latestStatus, pcEditAwaitingRestart);
  return state === "pending" || state === "rejected" || state === "edited_on_pc"
    ? state
    : null;
}

/**
 * The watcher's reason for rejecting a change, ready to follow "saved {time}:"
 * and to be followed by a full stop. Empty when it gave none. Trailing full
 * stops and spaces are dropped so the sentence doesn't end in "..".
 */
export function rejectionReasonText(reason: string | null): string {
  return (reason ?? "").trim().replace(/[.\s]+$/, "");
}

/**
 * Who saved a pending change, for "{who} saved a change {time}": "You" when the
 * viewer did, else the person's or token's name. "Someone" when no one was
 * recorded.
 */
export function pendingChangeAuthor(
  savedBy: Actor | null,
  viewerUserId: string
): string {
  if (!savedBy) {
    return "Someone";
  }
  if (savedBy.kind === "user" && savedBy.user.userId === viewerUserId) {
    return "You";
  }
  return actorDisplayName(savedBy);
}
