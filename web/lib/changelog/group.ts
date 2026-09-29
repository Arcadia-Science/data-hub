import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { ChangelogEntry } from "@/lib/changelog/parse";

export interface ChangelogDaySection {
  date: string;
  entries: ChangelogEntry[];
  heading: string;
}

/**
 * Bucket an already newest-first changelog into calendar days. Section order
 * follows the input, so the newest day stays first.
 */
export function groupChangelogByDate(
  entries: readonly ChangelogEntry[],
  timeZone: string
): ChangelogDaySection[] {
  const sections: ChangelogDaySection[] = [];
  const byDate = new Map<string, ChangelogDaySection>();

  for (const entry of entries) {
    let section = byDate.get(entry.date);
    if (!section) {
      section = {
        date: entry.date,
        entries: [],
        heading: formatChangelogDayHeading(entry.date, timeZone),
      };
      byDate.set(entry.date, section);
      sections.push(section);
    }
    section.entries.push(entry);
  }

  return sections;
}

/** Weekday heading in the changelog window (`Monday, September 28, 2026`). */
export function formatChangelogDayHeading(
  dayKey: string,
  timeZone: string
): string {
  // Noon on that local day avoids DST edges that midnight can hit.
  const midday = fromZonedTime(`${dayKey}T12:00:00.000`, timeZone);
  return formatInTimeZone(midday, timeZone, "EEEE, MMMM d, yyyy");
}
