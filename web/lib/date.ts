import {
  startOfDay,
  startOfMonth,
  startOfWeek,
  subDays,
  subWeeks,
} from "date-fns";
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";

/** Cookie name for the viewer's IANA timezone (writable from the browser). */
export const TIMEZONE_COOKIE_NAME = "timezone";

/** One year — timezone rarely changes, and we re-sync on mismatch. */
export const TIMEZONE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Returns the IANA timezone of the current runtime (e.g. `"America/New_York"`). */
function getTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Browser IANA timezone; same as the runtime zone in client components. */
export function getBrowserTimeZone(): string {
  return getTimeZone();
}

/**
 * True when `tz` is a real IANA zone `Intl` accepts. Rejects empty strings and
 * garbage cookie values so we never pass an invalid zone into date-fns-tz.
 */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) {
    return false;
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * UTC ISO string for 00:00:00.000 of the calendar day containing `now` in
 * `timeZone`. Inject `now` in tests to pin the clock.
 */
export function startOfTodayISO(
  timeZone: string,
  now: Date = new Date()
): string {
  const dateStr = formatInTimeZone(now, timeZone, "yyyy-MM-dd");
  return fromZonedTime(`${dateStr}T00:00:00.000`, timeZone).toISOString();
}

/**
 * UTC ISO string for 00:00:00.000 of the calendar day before `now` in
 * `timeZone`.
 */
export function startOfYesterdayISO(
  timeZone: string,
  now: Date = new Date()
): string {
  const zoned = toZonedTime(now, timeZone);
  return fromZonedTime(startOfDay(subDays(zoned, 1)), timeZone).toISOString();
}

/**
 * UTC ISO string for Monday 00:00:00.000 of the calendar week containing `now`
 * in `timeZone` (ISO week, Monday start). Inject `now` in tests to pin the clock.
 */
export function startOfWeekISO(
  timeZone: string,
  now: Date = new Date()
): string {
  const zoned = toZonedTime(now, timeZone);
  const weekStart = startOfWeek(zoned, { weekStartsOn: 1 });
  return fromZonedTime(weekStart, timeZone).toISOString();
}

/**
 * UTC ISO string for Monday 00:00:00.000 of the previous calendar week in
 * `timeZone`.
 */
export function startOfLastWeekISO(
  timeZone: string,
  now: Date = new Date()
): string {
  const zoned = toZonedTime(now, timeZone);
  const thisMonday = startOfWeek(zoned, { weekStartsOn: 1 });
  return fromZonedTime(subWeeks(thisMonday, 1), timeZone).toISOString();
}

/**
 * UTC ISO string for Sunday 00:00:00.000 of the previous calendar week in
 * `timeZone`. Pair with `startOfLastWeekISO` as `date_to` when the API
 * advances the end by one day (yielding this Monday exclusive).
 */
export function startOfLastWeekEndDayISO(
  timeZone: string,
  now: Date = new Date()
): string {
  const zoned = toZonedTime(now, timeZone);
  const thisMonday = startOfWeek(zoned, { weekStartsOn: 1 });
  return fromZonedTime(
    startOfDay(subDays(thisMonday, 1)),
    timeZone
  ).toISOString();
}

/**
 * UTC ISO string for 00:00:00.000 on the 1st of the calendar month containing
 * `now` in `timeZone`.
 */
export function startOfMonthISO(
  timeZone: string,
  now: Date = new Date()
): string {
  const zoned = toZonedTime(now, timeZone);
  return fromZonedTime(startOfMonth(zoned), timeZone).toISOString();
}

/** Formats a date as a 12-hour time string, e.g. `"2:30 PM"`. */
export function formatTime(date: Date): string {
  return formatInTimeZone(date, getTimeZone(), "h:mm a");
}

/** Formats a date as `"MMM d, yyyy"`, e.g. `"Jan 5, 2025"`. */
export function formatDate(date: Date): string {
  return formatInTimeZone(date, getTimeZone(), "MMM d, yyyy");
}

/** Formats a date as `"MMM d, yyyy h:mm a"`, e.g. `"Jan 5, 2025 2:30 PM"`. */
export function formatDateTime(date: Date): string {
  return formatInTimeZone(date, getTimeZone(), "MMM d, yyyy h:mm a");
}

/** Formats a date as `"MMM d, h:mm a"`, e.g. `"Jun 26, 9:13 AM"`. */
export function formatDateTimeShort(date: Date): string {
  return formatInTimeZone(date, getTimeZone(), "MMM d, h:mm a");
}

/** Returns the date as a `"yyyy-MM-dd"` string for HTML date inputs. */
export function toDateInputValue(date: Date): string {
  return formatInTimeZone(date, getTimeZone(), "yyyy-MM-dd");
}

/** Returns today's date as a `"yyyy-MM-dd"` string in the local timezone. */
export function todayDateString(): string {
  return toDateInputValue(new Date());
}

/**
 * Formats a date range as `"MMM d – MMM d, yyyy"` when both ends share a year,
 * otherwise `"MMM d, yyyy – MMM d, yyyy"`.
 */
export function formatDateRange(from: Date, to: Date): string {
  const tz = getTimeZone();
  const fromYear = formatInTimeZone(from, tz, "yyyy");
  const toYear = formatInTimeZone(to, tz, "yyyy");
  if (fromYear === toYear) {
    return `${formatInTimeZone(from, tz, "MMM d")} – ${formatInTimeZone(
      to,
      tz,
      "MMM d, yyyy"
    )}`;
  }
  return `${formatDate(from)} – ${formatDate(to)}`;
}
