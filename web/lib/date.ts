import { formatInTimeZone } from "date-fns-tz";

/** Returns the IANA timezone of the current runtime (e.g. `"America/New_York"`). */
function getTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
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
