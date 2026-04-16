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
