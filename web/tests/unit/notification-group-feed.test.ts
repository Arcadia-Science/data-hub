import { describe, expect, it } from "vitest";
import type { InstrumentType } from "@/lib/db/schema";
import { buildNotificationFeed } from "@/lib/notifications/group-feed";
import type { NotificationItem } from "@/lib/notifications/types";

const TZ = "America/Los_Angeles";
const NOW = new Date("2026-09-18T17:30:00.000Z"); // Fri Sep 18 10:30 AM PDT

function item(overrides: Partial<NotificationItem>): NotificationItem {
  return {
    id: "n1",
    type: "run_created",
    createdAt: "2026-09-16T18:31:00.000Z",
    readAt: null,
    runId: "run-uuid-1",
    runDisplayId: "run-a",
    runAcquiredAt: "2026-09-16T18:31:00.000Z",
    fileCount: 4,
    filesFailed: 0,
    instrumentId: "spectramax-id5-plate-reader",
    instrumentDisplayName: "SpectraMax iD5 Plate Reader",
    instrumentType: "plate_reader" as InstrumentType,
    commentId: null,
    commentBody: null,
    body: null,
    actor: null,
    ...overrides,
  };
}

describe("buildNotificationFeed", () => {
  it("buckets by viewer-local calendar day, newest day first", () => {
    const feed = buildNotificationFeed(
      [
        item({
          id: "today",
          createdAt: "2026-09-18T18:00:00.000Z",
          runId: "r-today",
          runDisplayId: "today-run",
        }),
        item({
          id: "tue",
          createdAt: "2026-09-16T18:31:00.000Z",
        }),
      ],
      TZ,
      NOW
    );

    expect(feed.map((s) => s.label)).toEqual(["Today", "Wednesday · Sep 16"]);
  });

  it("collapses run_created rows on the same day and instrument", () => {
    const feed = buildNotificationFeed(
      [
        item({ id: "a", runId: "r1", runDisplayId: "run-1" }),
        item({
          id: "b",
          runId: "r2",
          runDisplayId: "run-2",
          createdAt: "2026-09-16T17:00:00.000Z",
        }),
      ],
      TZ,
      NOW
    );

    expect(feed).toHaveLength(1);
    expect(feed[0].entries).toHaveLength(1);
    const group = feed[0].entries[0];
    expect(group.kind).toBe("run_group");
    if (group.kind !== "run_group") {
      return;
    }
    expect(group.runs.map((r) => r.runDisplayId)).toEqual(["run-1", "run-2"]);
    expect(group.latestCreatedAt).toBe("2026-09-16T18:31:00.000Z");
  });

  it("keeps the same instrument on different days as separate groups", () => {
    const feed = buildNotificationFeed(
      [
        item({
          id: "today",
          createdAt: "2026-09-18T18:00:00.000Z",
          runId: "r-today",
          runDisplayId: "today-run",
        }),
        item({ id: "tue", runId: "r-tue", runDisplayId: "tue-run" }),
      ],
      TZ,
      NOW
    );

    expect(feed).toHaveLength(2);
    expect(feed[0].entries[0].kind).toBe("run_group");
    expect(feed[1].entries[0].kind).toBe("run_group");
  });

  it("does not fold comments into a run group", () => {
    const feed = buildNotificationFeed(
      [
        item({
          id: "comment",
          type: "comment_attributed",
          commentId: "c1",
          commentBody: "looks off",
          actor: {
            id: "u1",
            displayName: "Bob",
            initials: "BO",
            avatarUrl: null,
          },
        }),
        item({ id: "run" }),
      ],
      TZ,
      NOW
    );

    expect(feed[0].entries.map((e) => e.kind)).toEqual([
      "comment",
      "run_group",
    ]);
  });
});
