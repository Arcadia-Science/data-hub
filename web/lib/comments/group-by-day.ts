import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { calendarDayKey, formatDayHeading } from "@/lib/date";

export interface CommentDaySection<T> {
  dayKey: string;
  items: T[];
  label: string;
}

/** Weekday heading used by the comments page (`Wednesday, September 2`). */
export function formatCommentDayHeading(
  dayKey: string,
  timeZone: string,
  now: Date = new Date()
): string {
  // Noon on that local day avoids DST start/end edges that midnight can hit.
  const midday = fromZonedTime(`${dayKey}T12:00:00.000`, timeZone);
  const currentYear = calendarDayKey(now, timeZone).slice(0, 4);
  const pattern =
    dayKey.slice(0, 4) === currentYear ? "EEEE, MMMM d" : "EEEE, MMMM d, yyyy";
  return formatInTimeZone(midday, timeZone, pattern);
}

function formatRelativeDayHeading(
  dayKey: string,
  timeZone: string,
  now: Date
): string {
  return formatDayHeading(dayKey, timeZone, now, { yearIfNotCurrent: true });
}

/**
 * Bucket an already newest-first comment list into calendar days in
 * `timeZone`. Section order follows the input, so the newest day stays first
 * and a day that continues onto the next page repeats its heading there.
 */
export function groupCommentsByDay<T extends { created_at: Date | string }>(
  items: T[],
  timeZone: string,
  now: Date = new Date(),
  formatHeading: (
    dayKey: string,
    timeZone: string,
    now: Date
  ) => string = formatRelativeDayHeading
): CommentDaySection<T>[] {
  const sections: CommentDaySection<T>[] = [];
  const byDay = new Map<string, CommentDaySection<T>>();

  for (const item of items) {
    const created =
      typeof item.created_at === "string"
        ? new Date(item.created_at)
        : item.created_at;
    const dayKey = calendarDayKey(created, timeZone);
    let section = byDay.get(dayKey);
    if (!section) {
      section = {
        dayKey,
        label: formatHeading(dayKey, timeZone, now),
        items: [],
      };
      byDay.set(dayKey, section);
      sections.push(section);
    }
    section.items.push(item);
  }

  return sections;
}
