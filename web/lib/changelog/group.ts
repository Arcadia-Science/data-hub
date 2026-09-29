import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { ChangelogEntry } from "@/lib/changelog/parse";
import { formatCommentDayHeading } from "@/lib/comments/group-by-day";
import { calendarDayKey } from "@/lib/date";

export interface ChangelogDaySection {
  date: string;
  entries: ChangelogEntry[];
  heading: string;
  jumpLabel: string;
}

/**
 * Bucket an already newest-first changelog into calendar days. Section order
 * follows the input, so the newest day stays first.
 */
export function groupChangelogByDate(
  entries: readonly ChangelogEntry[],
  timeZone: string,
  now: Date = new Date()
): ChangelogDaySection[] {
  const sections: ChangelogDaySection[] = [];
  const byDate = new Map<string, ChangelogDaySection>();

  for (const entry of entries) {
    let section = byDate.get(entry.date);
    if (!section) {
      section = {
        date: entry.date,
        entries: [],
        heading: formatCommentDayHeading(entry.date, timeZone, now),
        jumpLabel: formatChangelogJumpLabel(entry.date, timeZone, now),
      };
      byDate.set(entry.date, section);
      sections.push(section);
    }
    section.entries.push(entry);
  }

  return sections;
}

/** Short label for the jump list (`September 28`, with the year when it differs). */
export function formatChangelogJumpLabel(
  dayKey: string,
  timeZone: string,
  now: Date = new Date()
): string {
  const midday = fromZonedTime(`${dayKey}T12:00:00.000`, timeZone);
  const currentYear = calendarDayKey(now, timeZone).slice(0, 4);
  const pattern =
    dayKey.slice(0, 4) === currentYear ? "MMMM d" : "MMMM d, yyyy";
  return formatInTimeZone(midday, timeZone, pattern);
}
