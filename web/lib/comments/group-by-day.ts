import { calendarDayKey, formatNotificationDayHeading } from "@/lib/date";

export interface CommentDaySection<T> {
  dayKey: string;
  items: T[];
  label: string;
}

/**
 * Bucket an already newest-first comment list into calendar days in
 * `timeZone`. Section order follows the input, so the newest day stays first
 * and a day that continues onto the next page repeats its heading there.
 */
export function groupCommentsByDay<T extends { created_at: Date | string }>(
  items: T[],
  timeZone: string,
  now: Date = new Date()
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
        label: formatNotificationDayHeading(dayKey, timeZone, now, {
          yearIfNotCurrent: true,
        }),
        items: [],
      };
      byDay.set(dayKey, section);
      sections.push(section);
    }
    section.items.push(item);
  }

  return sections;
}
