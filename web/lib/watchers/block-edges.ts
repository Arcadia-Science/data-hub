// Where each of a day's 48 half-hour blocks starts, as real moments in time.
// The grid has one column for every half hour of the viewer's wall clock, but a
// day with a clock change isn't 24 hours long, so a column can't always be 30
// minutes. The read (`getWatcherHealth`) puts every heartbeat into the column
// whose edges hold it, in the database, by these same moments, so a column and
// what it says about itself can't disagree. No database imports.

import { formatInTimeZone } from "date-fns-tz";
import { addDays, startOfDay } from "./range";

export const BLOCK_MINUTES = 30;
export const BLOCKS_PER_DAY = 48;
const BLOCK_MS = BLOCK_MINUTES * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The start of the block at `slot` (0 to 47) of a day that starts at `dayStart`. */
export function blockStart(dayStart: Date, slot: number): Date {
  return new Date(dayStart.getTime() + slot * BLOCK_MS);
}

/** Minutes since midnight on the wall clock in `timeZone` at `instant`. */
function wallMinutes(instant: Date, timeZone: string): number {
  const [hours, minutes] = formatInTimeZone(instant, timeZone, "HH:mm")
    .split(":")
    .map(Number);
  return hours * 60 + minutes;
}

/**
 * The 49 edges of a day's 48 blocks: block `slot` runs from `edges[slot]` up to
 * `edges[slot + 1]`, and the last edge is the next day's first moment.
 *
 * On an ordinary day each block is 30 minutes. On a day with a clock change the
 * block for a wall-clock time starts when that time first happens:
 *
 * - When the clocks go forward, the times that never happen (2:00 and 2:30 AM
 *   in the US) start where the clock jumps, so their blocks are zero-length. A
 *   block that holds no time can hold no heartbeat, and the grid draws it as no
 *   data.
 * - When the clocks go back, the repeated hour belongs to the blocks for its
 *   wall-clock times, so the block for 1:30 AM runs through the second 1 AM
 *   hour, an hour and a half in all.
 */
export function blockEdges(day: string, timeZone: string): Date[] {
  const dayStart = startOfDay(day, timeZone);
  const nextDayStart = startOfDay(addDays(day, 1), timeZone);
  if (nextDayStart.getTime() - dayStart.getTime() === DAY_MS) {
    return Array.from({ length: BLOCKS_PER_DAY + 1 }, (_, slot) =>
      blockStart(dayStart, slot)
    );
  }

  // Every real half hour of the day, with the wall-clock time it shows.
  const steps: { at: Date; wall: number }[] = [];
  for (
    let time = dayStart.getTime();
    time < nextDayStart.getTime();
    time += BLOCK_MS
  ) {
    const at = new Date(time);
    steps.push({ at, wall: wallMinutes(at, timeZone) });
  }

  return Array.from({ length: BLOCKS_PER_DAY + 1 }, (_, slot) => {
    if (slot === BLOCKS_PER_DAY) {
      return nextDayStart;
    }
    const wanted = slot * BLOCK_MINUTES;
    // The first time the clock shows it, or, if it never does, the first time
    // it shows a later one: the moment the clock jumped over it.
    const step =
      steps.find((candidate) => candidate.wall === wanted) ??
      steps.find((candidate) => candidate.wall > wanted);
    return step?.at ?? nextDayStart;
  });
}
