// The start of the window that Activity and Health show when the URL names none.
// No database imports, so server pages and client toolbars share it.

import { toDateInputValue, todayDateString } from "@/lib/date";

/**
 * The day (`yyyy-MM-dd`, in the viewer's zone) the event log and the heartbeat
 * chart open on. Today for a current watcher. A past watcher sent nothing
 * today, so it opens on the day it was deregistered, its last day of activity.
 */
export function defaultWatcherSince(
  deletedAt: Date | null,
  timeZone: string,
  now: Date = new Date()
): string {
  return deletedAt
    ? toDateInputValue(deletedAt, timeZone)
    : todayDateString(timeZone, now);
}

/**
 * The viewer's zone is a guess on a first visit, so a query starts a day early
 * to cover their whole local day. The chart clips to the exact day, and the
 * event log orders by timestamp, so a wider window is harmless.
 */
export function tzSafeSince(dateString: string): Date {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date;
}
