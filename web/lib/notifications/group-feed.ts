import { calendarDayKey, formatNotificationDayHeading } from "@/lib/date";
import type { InstrumentType } from "@/lib/db/schema";
import type { NotificationItem } from "@/lib/notifications/types";

// Turns the flat, newest-first notification feed into per-calendar-day
// sections with `run_created` rows collapsed by instrument. Date keys use
// the viewer's timezone so a late-evening Pacific run doesn't land on the
// next UTC day.

export const RUN_GROUP_VISIBLE_LIMIT = 5;

type AnchoredNotificationItem = NotificationItem & {
  runId: string;
  runDisplayId: string;
  instrumentId: string;
  instrumentDisplayName: string;
  instrumentType: InstrumentType;
};

export function isAnchored(n: NotificationItem): n is AnchoredNotificationItem {
  return (
    n.runId !== null &&
    n.runDisplayId !== null &&
    n.instrumentId !== null &&
    n.instrumentDisplayName !== null &&
    n.instrumentType !== null
  );
}

export interface CommentEntry {
  id: string;
  kind: "comment";
  notification: AnchoredNotificationItem;
}

export interface GenericEntry {
  id: string;
  kind: "generic";
  notification: NotificationItem;
}

export interface RunGroupEntry {
  id: string;
  instrumentDisplayName: string;
  instrumentId: string;
  instrumentType: InstrumentType;
  kind: "run_group";
  latestCreatedAt: string;
  runs: AnchoredNotificationItem[];
}

export type FeedEntry = CommentEntry | GenericEntry | RunGroupEntry;

export interface DaySection {
  dayKey: string;
  entries: FeedEntry[];
  label: string;
}

export function buildNotificationFeed(
  items: NotificationItem[],
  timeZone: string,
  now: Date = new Date()
): DaySection[] {
  const sections: DaySection[] = [];
  const sectionByDay = new Map<string, DaySection>();
  const groupIndex = new Map<string, RunGroupEntry>();

  for (const n of items) {
    const dayKey = calendarDayKey(new Date(n.createdAt), timeZone);
    let section = sectionByDay.get(dayKey);
    if (!section) {
      section = {
        dayKey,
        label: formatNotificationDayHeading(dayKey, timeZone, now),
        entries: [],
      };
      sectionByDay.set(dayKey, section);
      sections.push(section);
    }

    if (n.type === "generic") {
      section.entries.push({ kind: "generic", id: n.id, notification: n });
      continue;
    }
    if (!isAnchored(n)) {
      continue;
    }
    if (n.type === "run_created") {
      const key = `${dayKey}:${n.instrumentId}`;
      const existing = groupIndex.get(key);
      if (existing) {
        existing.runs.push(n);
      } else {
        const group: RunGroupEntry = {
          kind: "run_group",
          id: `group:${key}`,
          instrumentId: n.instrumentId,
          instrumentType: n.instrumentType,
          instrumentDisplayName: n.instrumentDisplayName,
          runs: [n],
          latestCreatedAt: n.createdAt,
        };
        groupIndex.set(key, group);
        section.entries.push(group);
      }
    } else {
      section.entries.push({
        kind: "comment",
        id: n.id,
        notification: n,
      });
    }
  }

  return sections;
}
