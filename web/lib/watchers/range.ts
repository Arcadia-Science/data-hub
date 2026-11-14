// The days that the Activity and Health tabs show, and the words that name
// them. Both tabs read the same two URL parameters, `date_from` and `date_to`,
// that `RunsDateFilter` writes, and turn them into whole calendar days in the
// viewer's time zone. No database imports, so server pages and client
// components share it.

import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { toDateInputValue, todayDateString } from "@/lib/date";

/** How many days a tab shows when the URL names no range. */
export const DEFAULT_RANGE_DAYS = 7;

/**
 * The most days the Health grid draws: one row each, so a longer range keeps
 * its last days. A year of rows would be unreadable.
 */
export const MAX_HEALTH_DAYS = 31;

export interface WatcherRangeParams {
  /** `?date_from=` as `RunsDateFilter` writes it: an ISO instant. */
  dateFrom: string | null;
  /** `?date_to=`: an ISO instant somewhere in the last day. */
  dateTo: string | null;
  /**
   * An old link's `?since=` or `?events_since=`: a `yyyy-MM-dd` day. Those
   * parameters are only read now, never written.
   */
  legacySince: string | null;
}

export interface WatcherRange {
  /** How many days from `fromDay` to `toDay`. */
  dayCount: number;
  /** The first moment after `toDay`, so a query reads `< endExclusive`. */
  endExclusive: Date;
  /** The first day, `yyyy-MM-dd`. */
  fromDay: string;
  /** True when the URL named nothing and the range is the tab's default. */
  isDefault: boolean;
  /** The first moment of `fromDay`. */
  start: Date;
  /** The last day, `yyyy-MM-dd`, inclusive. */
  toDay: string;
  /** True when the range was longer than the tab shows and was cut. */
  wasCut: boolean;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** True for a real `yyyy-MM-dd` calendar day. */
export function isCalendarDay(value: string | null): value is string {
  if (!(value && DAY_PATTERN.test(value))) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** `day` moved by `days`, as `yyyy-MM-dd`. Works on the calendar, not instants. */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Days from `from` to `to`; 0 when they are the same day. */
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() -
      new Date(`${from}T00:00:00Z`).getTime()) /
      MS_PER_DAY
  );
}

/** Every day from `from` to `to`, inclusive, oldest first. */
export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    days.push(day);
  }
  return days;
}

/** The first moment of `day` in `timeZone`. */
export function startOfDay(day: string, timeZone: string): Date {
  return fromZonedTime(`${day}T00:00:00.000`, timeZone);
}

function parseInstant(value: string | null): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `value`, or null when it isn't a moment in time: a hand-edited URL, say. */
export function instantOrNull(value: string | null): string | null {
  return parseInstant(value) ? value : null;
}

/**
 * The first day of a range whose `date_from` is `from`. A preset that starts at
 * local midnight (Today, This week) starts that day. A rolling preset (Last 7
 * days) starts at the time of day it was clicked, seven days back, so its first
 * day is only partly inside it and the range starts the day after: seven days
 * ending today.
 */
function firstDayOf(from: Date, timeZone: string): string {
  const day = toDateInputValue(from, timeZone);
  const atMidnight = formatInTimeZone(from, timeZone, "HH:mm") === "00:00";
  return atMidnight ? day : addDays(day, 1);
}

/**
 * The days a tab shows.
 *
 * - With `date_from` or `date_to`, those days. A missing end is today and a
 *   missing start is a default-length range ending at the end.
 * - With only an old link's day, that day through the default's last day.
 * - With nothing, the last 7 days. A past watcher has sent nothing lately, so
 *   its default ends on the day it was deregistered: its last day of activity.
 *
 * `maxDays` cuts a longer range to its last days.
 */
export function resolveWatcherRange(
  params: WatcherRangeParams,
  options: {
    timeZone: string;
    /** When the watcher was deregistered, for a past watcher. */
    deregisteredAt?: Date | null;
    maxDays?: number;
    now?: Date;
  }
): WatcherRange {
  const { timeZone, maxDays } = options;
  const now = options.now ?? new Date();
  const today = todayDateString(timeZone, now);
  const defaultEnd = options.deregisteredAt
    ? toDateInputValue(options.deregisteredAt, timeZone)
    : today;

  const from = parseInstant(params.dateFrom);
  const to = parseInstant(params.dateTo);
  const legacy = isCalendarDay(params.legacySince) ? params.legacySince : null;

  let fromDay: string;
  let toDay: string;
  let isDefault = false;
  if (from || to) {
    toDay = to ? toDateInputValue(to, timeZone) : today;
    if (toDay > today) {
      toDay = today;
    }
    fromDay = from
      ? firstDayOf(from, timeZone)
      : addDays(toDay, 1 - DEFAULT_RANGE_DAYS);
    if (fromDay > toDay) {
      fromDay = toDay;
    }
  } else if (legacy) {
    toDay = defaultEnd;
    fromDay = legacy > toDay ? toDay : legacy;
  } else {
    isDefault = true;
    toDay = defaultEnd;
    fromDay = addDays(toDay, 1 - DEFAULT_RANGE_DAYS);
  }

  let wasCut = false;
  if (maxDays && daysBetween(fromDay, toDay) + 1 > maxDays) {
    fromDay = addDays(toDay, 1 - maxDays);
    wasCut = true;
  }

  return {
    fromDay,
    toDay,
    dayCount: daysBetween(fromDay, toDay) + 1,
    start: startOfDay(fromDay, timeZone),
    endExclusive: startOfDay(addDays(toDay, 1), timeZone),
    isDefault,
    wasCut,
  };
}

/**
 * What the range picker shows when the URL names no range. `{ from: null, to:
 * null }` is "Last 7 days", which is right for a current watcher's default. A
 * past watcher's default, and the days an old link asked for, are other days, so
 * the picker is given them as a custom range.
 */
export function pickerFallback(
  range: Pick<WatcherRange, "isDefault" | "start" | "toDay">,
  timeZone: string,
  isPast: boolean
): { from: string | null; to: string | null } {
  if (range.isDefault && !isPast) {
    return { from: null, to: null };
  }
  return {
    from: range.start.toISOString(),
    to: startOfDay(range.toDay, timeZone).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/**
 * Whether days written together need their year: when any is not in `now`'s
 * year. They are all written with it or all without, so "Dec 29, 2025 to Jan
 * 2, 2026" never reads "Dec 29, 2025 to Jan 2".
 */
function needsYear(days: string[], now: Date, timeZone: string): boolean {
  const thisYear = todayDateString(timeZone, now).slice(0, 4);
  return days.some((day) => day.slice(0, 4) !== thisYear);
}

/**
 * "Nov 7", or "Nov 7, 2025" when the day isn't in `now`'s year. Pass `withYear`
 * when the caller has decided for a group of days.
 */
export function formatDay(
  day: string,
  now: Date,
  timeZone: string,
  withYear: boolean = needsYear([day], now, timeZone)
): string {
  const noon = new Date(`${day}T12:00:00Z`);
  return formatInTimeZone(noon, "UTC", withYear ? "MMM d, yyyy" : "MMM d");
}

type RangeDays = Pick<WatcherRange, "fromDay" | "toDay" | "dayCount">;

/** The first and last day of a range, written alike. */
function rangeEnds(
  range: RangeDays,
  timeZone: string,
  now: Date
): { from: string; to: string } {
  const withYear = needsYear([range.fromDay, range.toDay], now, timeZone);
  return {
    from: formatDay(range.fromDay, now, timeZone, withYear),
    to: formatDay(range.toDay, now, timeZone, withYear),
  };
}

/**
 * Where a range sits in a sentence: "in the last 7 days", "today", "on Nov 10",
 * "from Nov 4 to Nov 10". "None in the last 7 days"; "34 events on Nov 10".
 */
export function describeRange(
  range: RangeDays,
  timeZone: string,
  now: Date = new Date()
): string {
  const today = todayDateString(timeZone, now);
  if (range.toDay === today && range.dayCount === 1) {
    return "today";
  }
  if (range.toDay === today) {
    return `in the last ${range.dayCount} days`;
  }
  const { from, to } = rangeEnds(range, timeZone, now);
  return range.dayCount === 1 ? `on ${to}` : `from ${from} to ${to}`;
}

/** A range as a heading: "Last 7 days", "Today", "Nov 10", "Nov 4 to Nov 10". */
export function rangeTitle(
  range: RangeDays,
  timeZone: string,
  now: Date = new Date()
): string {
  const today = todayDateString(timeZone, now);
  if (range.toDay === today && range.dayCount === 1) {
    return "Today";
  }
  if (range.toDay === today) {
    return `Last ${range.dayCount} days`;
  }
  return rangeDates(range, timeZone, now);
}

/** The days a range covers: "Nov 10", "Nov 7 to Nov 13". */
export function rangeDates(
  range: RangeDays,
  timeZone: string,
  now: Date = new Date()
): string {
  const { from, to } = rangeEnds(range, timeZone, now);
  return range.dayCount === 1 ? to : `${from} to ${to}`;
}

/** A day for a row or a bar label: "Sat 7". */
export function shortDayLabel(day: string): string {
  return formatInTimeZone(new Date(`${day}T12:00:00Z`), "UTC", "EEE d");
}

/** A day for a tooltip: "Sat, Nov 7". */
export function longDayLabel(day: string): string {
  return formatInTimeZone(new Date(`${day}T12:00:00Z`), "UTC", "EEE, MMM d");
}
