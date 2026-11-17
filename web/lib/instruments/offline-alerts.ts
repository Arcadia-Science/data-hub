// When to tell an instrument's subscribers that it went offline, and that it's
// back. No database imports, so the job and its tests share one definition.
//
// The instrument badge is derived on every read and never stored, and an
// instrument can turn Offline with no write at all (its watcher just stops
// checking in). So the offline-alert job keeps its own state per instrument in
// `instrument_offline_alerts` and moves it every run:
//
// - Quiet: no row.
// - Waiting: a row without `alertedAt`. The job saw the badge Offline at
//   `offlineSince` and is waiting out `OFFLINE_ALERT_AFTER_MS`.
// - Alerted: a row with `alertedAt`. Subscribers were told, and are told again
//   when the badge is Online.

import { formatDistanceStrict } from "date-fns";
import { STALE_THRESHOLD_MS } from "@/lib/api/watcher-status";
import type {
  ConnectionReason,
  InstrumentBadgeState,
} from "@/lib/instruments/connection";

/** How long the badge stays Offline, from the job's first sighting, before subscribers hear. */
export const OFFLINE_ALERT_AFTER_MS = 30 * 60 * 1000;

/**
 * Cron runs start a few seconds late or early, so a clock that started on one
 * run can fall just short of 30 minutes on the run 30 minutes later. Without
 * this allowance that alert would wait for the run after.
 */
export const CRON_JITTER_MS = 60 * 1000;

/**
 * The pause needs at least this many watchers that should be checking in, so
 * one PC going down on its own never pauses the job.
 */
export const PAUSE_MIN_EXPECTED_WATCHERS = 2;

export interface OfflineAlertState {
  /** Set once subscribers were told. */
  alertedAt: Date | null;
  /** When the job first saw the badge Offline. */
  offlineSince: Date;
}

export interface OfflineAlertObservation {
  badge: InstrumentBadgeState;
  /** The connection's reason. Null unless the badge is Offline. */
  reason: ConnectionReason | null;
}

/**
 * What the job does to an instrument's row this run. Each one is a single
 * guarded statement:
 *
 * - `none`: leave the row as it is.
 * - `start`: insert a row with `offlineSince` now (Quiet to Waiting).
 * - `alert`: set `alertedAt` and send the offline alert (Waiting to Alerted).
 * - `recover`: delete the row and send "back online" (Alerted to Quiet).
 * - `clear`: delete the row and send nothing (to Quiet).
 */
export type OfflineAlertTransition =
  | "none"
  | "start"
  | "alert"
  | "recover"
  | "clear";

/**
 * The step for one instrument. The first matching row wins:
 *
 * | State   | Badge this run                                   | Transition |
 * | ------- | ------------------------------------------------ | ---------- |
 * | Quiet   | Offline, unless paused and the reason is unresponsive | start |
 * | Quiet   | anything else                                    | none       |
 * | Waiting | Offline and unresponsive while paused            | clear      |
 * | Waiting | Offline for 30 minutes (less `CRON_JITTER_MS`)   | alert      |
 * | Waiting | Offline for less                                 | none       |
 * | Waiting | anything else                                    | clear      |
 * | Alerted | Online                                           | recover    |
 * | Alerted | Pending or Retired                               | clear      |
 * | Alerted | Offline (any reason), Restarting or Connecting   | none       |
 *
 * After an alert the outage lasts until the badge is Online: Restarting or
 * Connecting can still fall back to Offline, and a reason change is the same
 * outage, so neither sends anything. Retiring ends it silently.
 *
 * The pause (see `isOfflineAlertPaused`) only holds back `unresponsive`, the one
 * reason that comes from heartbeats not arriving. The other reasons come from
 * a heartbeat that did arrive, or from an admin, so a fault on Data Hub's side
 * can't produce them.
 */
export function stepOfflineAlert(
  state: OfflineAlertState | null,
  observation: OfflineAlertObservation,
  now: Date,
  paused: boolean
): OfflineAlertTransition {
  const offline = observation.badge === "offline";
  const heldBack = paused && observation.reason === "unresponsive";

  if (state === null) {
    return offline && !heldBack ? "start" : "none";
  }

  if (state.alertedAt === null) {
    if (!offline || heldBack) {
      return "clear";
    }
    const waited = now.getTime() - state.offlineSince.getTime();
    return waited >= OFFLINE_ALERT_AFTER_MS - CRON_JITTER_MS ? "alert" : "none";
  }

  switch (observation.badge) {
    case "online":
      return "recover";
    case "pending":
    case "retired":
      return "clear";
    case "offline":
    case "restarting":
    case "connecting":
      return "none";
    default:
      return observation.badge satisfies never;
  }
}

/** What the pause needs of each active (not deregistered) watcher. */
export interface PauseWatcher {
  lastHeartbeatAt: Date | null;
  /** The stored status, not the effective one. */
  status: string;
}

/**
 * Whether this run should hold back `unresponsive` alerts. True when at least
 * `PAUSE_MIN_EXPECTED_WATCHERS` active watchers should be checking in (stored
 * status `watching` or `waiting`) and none has within `STALE_THRESHOLD_MS`.
 * Every PC going quiet at once points to Data Hub not receiving heartbeats,
 * such as a broken heartbeat route, more than to the PCs.
 */
export function isOfflineAlertPaused(
  watchers: readonly PauseWatcher[],
  now: Date
): boolean {
  const expected = watchers.filter(
    (watcher) => watcher.status === "watching" || watcher.status === "waiting"
  );
  if (expected.length < PAUSE_MIN_EXPECTED_WATCHERS) {
    return false;
  }
  return expected.every(
    (watcher) =>
      watcher.lastHeartbeatAt === null ||
      now.getTime() - watcher.lastHeartbeatAt.getTime() > STALE_THRESHOLD_MS
  );
}

/** A length of time in words: "35 minutes", "2 hours", "1 day". */
export function formatOutageDuration(from: Date, to: Date): string {
  return formatDistanceStrict(from, to, { roundingMethod: "round" });
}

export type InstrumentConnectionNotificationKind =
  | "instrument_offline"
  | "instrument_back_online";

/** The notification's heading, in the bell and in Slack. */
export function instrumentConnectionHeading(
  kind: InstrumentConnectionNotificationKind,
  instrumentDisplayName: string
): string {
  return kind === "instrument_offline"
    ? `${instrumentDisplayName} is offline`
    : `${instrumentDisplayName} is back online`;
}

export interface OfflineAlertMessageInput {
  hostname: string | null;
  lastHeartbeatAt: Date | null;
  now: Date;
  watchDirectory: string | null;
}

/**
 * The sentence under "{Instrument} is offline". It follows the instrument
 * page's notice (`instrumentProblemNotice`), but it is written once on the
 * server for readers in any time zone, so it gives lengths of time instead of
 * clock times.
 */
export function offlineAlertMessage(
  reason: ConnectionReason,
  input: OfflineAlertMessageInput
): string {
  switch (reason) {
    case "folder_missing":
      return `The watcher can't find ${input.watchDirectory ?? "its watch folder"}, so it isn't picking up new files from this instrument.`;
    case "unresponsive":
      return input.lastHeartbeatAt
        ? `The watcher hasn't checked in for ${formatOutageDuration(input.lastHeartbeatAt, input.now)}. New files won't appear until it's back.`
        : "The watcher isn't checking in. New files won't appear until it's back.";
    case "stopped":
      return input.hostname
        ? `The watcher on ${input.hostname} was stopped. New files won't appear until it's started again.`
        : "The watcher was stopped. New files won't appear until it's started again.";
    case "no_watcher":
      return "It isn't connected to a watcher. New files won't appear until a watcher is set up on the instrument PC.";
    case "deregistered":
      return "Its watcher was deregistered. New files won't appear until a new watcher is set up.";
    default:
      return reason satisfies never;
  }
}

/** The sentence under "{Instrument} is back online". */
export function backOnlineMessage(offlineSince: Date, now: Date): string {
  return `It was offline for about ${formatOutageDuration(offlineSince, now)}.`;
}
