// The notice above a run's Files section when the instrument's watcher is
// offline and files from the run are still waiting on the instrument PC. No
// database imports: the run page's client components import this file.

import {
  calendarDayKey,
  formatDateCompact,
  formatTime,
  startOfYesterdayISO,
} from "@/lib/date";
import type { InstrumentBadgeState } from "@/lib/instruments/connection";

/**
 * Whether the run page shows the notice. Only an Offline badge does, and only
 * when the run has files waiting: detected, or upload requested and not yet
 * picked up. A run with no waiting files has nothing stuck on the PC, so it
 * never shows the notice, whatever the badge. Restarting is expected to pass
 * on its own, so it gets a line beside the Upload buttons instead.
 */
export function shouldShowOfflineNotice(
  badge: InstrumentBadgeState,
  waitingFileCount: number
): boolean {
  return badge === "offline" && waitingFileCount > 0;
}

/**
 * When the watcher last checked in, as a phrase that follows "checked in":
 * "today at 2:14 PM", "yesterday at 2:14 PM", or "Nov 9 at 2:14 PM" (with the
 * year when it isn't this one). The day is the viewer's, so pass their time
 * zone.
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

export interface OfflineNoticeCopy {
  body: string;
  title: string;
}

/**
 * The notice's words. `lastCheckIn` is the phrase from `formatLastCheckIn`,
 * or null when the watcher never sent a heartbeat, which drops the last
 * sentence.
 */
export function offlineNoticeCopy(input: {
  instrumentName: string;
  lastCheckIn: string | null;
  waitingFileCount: number;
}): OfflineNoticeCopy {
  const one = input.waitingFileCount === 1;
  const title = one
    ? "1 file from this run is still on the instrument PC"
    : `${input.waitingFileCount} files from this run are still on the instrument PC`;
  const cause = `The watcher for ${input.instrumentName} isn't running, so ${
    one ? "it" : "they"
  } can't upload until it's back.`;
  return {
    title,
    body:
      input.lastCheckIn === null
        ? cause
        : `${cause} It last checked in ${input.lastCheckIn}.`,
  };
}
