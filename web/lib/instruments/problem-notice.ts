// The notice on an instrument's page that says why new files can't arrive. No
// database imports, so the page and its tests share one definition.
//
// It shows only while the instrument badge reads Offline, and says one thing at
// a time, picked by the connection's reason. Healthy, restarting, connecting,
// pending and retired instruments get none, and manual upload mode isn't a
// problem: it has its own pill in the header.

import {
  calendarDayKey,
  formatDateCompact,
  formatTime,
  startOfYesterdayISO,
} from "@/lib/date";
import {
  type Connection,
  type ConnectionReason,
  type InstrumentLifecycleStatus,
  instrumentBadgeState,
} from "@/lib/instruments/connection";

/** What the notice's actions row can hold. The component picks each one's link. */
export type ProblemNoticeAction =
  /** To the watcher's Settings tab, with the Watch folder field focused. */
  | "change_folder"
  /** To the setup guide. */
  | "connect_watcher"
  /** To the watcher page's Activity tab. */
  | "see_details";

/** A piece of the notice's sentence. `code` is a folder or a computer name. */
export type ProblemNoticeBodyPart = string | { code: string };

export interface ProblemNotice {
  actions: ProblemNoticeAction[];
  body: ProblemNoticeBodyPart[];
  title: string;
}

/** Who deregistered a watcher, and when, for an instrument that has no watcher. */
export interface Deregistration {
  at: Date | null;
  /** A person or a token's name. Null when it wasn't recorded. */
  byName: string | null;
}

export interface ProblemNoticeInput {
  connection: Connection;
  /** The most recent deregistered watcher. Only read for `deregistered`. */
  deregistration?: Deregistration | null;
  isAdmin: boolean;
  /** Defaults to the current time. Pass it to pin the clock in tests. */
  now?: Date;
  status: InstrumentLifecycleStatus;
  /** The viewer's zone, for the times and dates in the sentence. */
  timeZone: string;
  /** The active watcher, or null when the instrument has none. */
  watcher: {
    hostname: string | null;
    lastHeartbeatAt: Date | null;
    watchDirectory: string | null;
  } | null;
}

/**
 * When a watcher last checked in, for "hasn't checked in since {time}": "today
 * at 2:14 PM", "yesterday at 2:14 PM", or "Nov 12 at 2:14 PM", with the year
 * when it isn't this one.
 */
export function formatLastCheckIn(
  date: Date,
  timeZone: string,
  now: Date = new Date()
): string {
  const time = formatTime(date, timeZone);
  const day = calendarDayKey(date, timeZone);
  if (day === calendarDayKey(now, timeZone)) {
    return `today at ${time}`;
  }
  const yesterday = calendarDayKey(
    new Date(startOfYesterdayISO(timeZone, now)),
    timeZone
  );
  if (day === yesterday) {
    return `yesterday at ${time}`;
  }
  return `${formatDateCompact(date, timeZone, now)} at ${time}`;
}

const SEE_DETAILS: ProblemNoticeAction = "see_details";

// Who gets which actions, by reason. Admins can fix a missing folder or set up
// a watcher, and everyone can look at the watcher page. An instrument with no
// active watcher has nothing current to look at, so members get no link there.
const ACTIONS: Record<
  ConnectionReason,
  { admin: ProblemNoticeAction[]; member: ProblemNoticeAction[] }
> = {
  folder_missing: {
    admin: ["change_folder", SEE_DETAILS],
    member: [SEE_DETAILS],
  },
  unresponsive: { admin: [SEE_DETAILS], member: [SEE_DETAILS] },
  stopped: { admin: [SEE_DETAILS], member: [SEE_DETAILS] },
  no_watcher: { admin: ["connect_watcher"], member: [] },
  deregistered: { admin: ["connect_watcher"], member: [] },
};

const NOT_CONNECTED_TITLE = "This instrument isn't connected to a watcher";

function folderMissingBody(folder: string | null): ProblemNoticeBodyPart[] {
  return [
    "The watcher can't find ",
    folder ? { code: folder } : "its watch folder",
    ", so it isn't picking up new files from this instrument.",
  ];
}

function unresponsiveBody(
  lastHeartbeatAt: Date | null,
  timeZone: string,
  now: Date
): ProblemNoticeBodyPart[] {
  const since = lastHeartbeatAt
    ? ` since ${formatLastCheckIn(lastHeartbeatAt, timeZone, now)}`
    : "";
  return [
    `The watcher for this instrument hasn't checked in${since}. New files won't appear here until it's back.`,
  ];
}

function stoppedBody(hostname: string | null): ProblemNoticeBodyPart[] {
  return [
    "The watcher",
    ...(hostname ? [" on ", { code: hostname }] : []),
    " was stopped. New files won't appear until it's started again.",
  ];
}

function deregisteredBody(
  deregistration: Deregistration | null,
  timeZone: string,
  now: Date
): ProblemNoticeBodyPart[] {
  const on = deregistration?.at
    ? ` on ${formatDateCompact(deregistration.at, timeZone, now)}`
    : "";
  const by = deregistration?.byName ? ` by ${deregistration.byName}` : "";
  return [
    `Its watcher was deregistered${on}${by}. New files won't appear until a new watcher is set up.`,
  ];
}

/**
 * The notice for an instrument that can't receive new files, or null when it
 * shouldn't show one. The connection's reason picks it:
 *
 * | Reason         | Title                                        | Admin actions              | Members     |
 * | -------------- | -------------------------------------------- | -------------------------- | ----------- |
 * | folder_missing | New files aren't being picked up             | Change folder, See details | See details |
 * | unresponsive   | The watcher isn't checking in                | See details                | See details |
 * | stopped        | Uploads from this instrument are paused      | See details                | See details |
 * | no_watcher     | This instrument isn't connected to a watcher | Connect a watcher          | none        |
 * | deregistered   | This instrument isn't connected to a watcher | Connect a watcher          | none        |
 *
 * It needs the instrument's own status because Pending and Retired win over
 * the connection: a retired instrument has no watcher and isn't in trouble.
 */
export function instrumentProblemNotice(
  input: ProblemNoticeInput
): ProblemNotice | null {
  const { connection, status, isAdmin, timeZone, watcher } = input;
  if (instrumentBadgeState(status, connection) !== "offline") {
    return null;
  }
  const reason = connection.reason;
  if (reason === null) {
    return null;
  }
  const now = input.now ?? new Date();
  const actions = isAdmin ? ACTIONS[reason].admin : ACTIONS[reason].member;

  switch (reason) {
    case "folder_missing":
      return {
        title: "New files aren't being picked up",
        body: folderMissingBody(watcher?.watchDirectory ?? null),
        actions,
      };
    case "unresponsive":
      return {
        title: "The watcher isn't checking in",
        body: unresponsiveBody(watcher?.lastHeartbeatAt ?? null, timeZone, now),
        actions,
      };
    case "stopped":
      return {
        title: "Uploads from this instrument are paused",
        body: stoppedBody(watcher?.hostname ?? null),
        actions,
      };
    case "no_watcher":
      return {
        title: NOT_CONNECTED_TITLE,
        body: [
          "New files won't appear until a watcher is set up on the instrument PC.",
        ],
        actions,
      };
    case "deregistered":
      return {
        title: NOT_CONNECTED_TITLE,
        body: deregisteredBody(input.deregistration ?? null, timeZone, now),
        actions,
      };
    default:
      return reason satisfies never;
  }
}
