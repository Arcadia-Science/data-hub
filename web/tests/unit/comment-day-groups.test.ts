import { describe, expect, it } from "vitest";
import {
  formatCommentDayHeading,
  groupCommentsByDay,
} from "@/lib/comments/group-by-day";
import { commentsPath } from "@/lib/comments/href";
import { commentCountLabel } from "@/lib/comments/present";

const TZ = "America/Los_Angeles";

describe("groupCommentsByDay", () => {
  const now = new Date("2026-09-18T17:30:00.000Z");

  it("keeps newest-first order and splits on the local day boundary", () => {
    const sections = groupCommentsByDay(
      [
        // Fri Sep 18, 10:30 AM PDT
        { id: "today", created_at: "2026-09-18T17:30:00.000Z" },
        // Thu Sep 17, 5:30 PM PDT — still yesterday, not Friday UTC
        { id: "yesterday-evening", created_at: "2026-09-18T00:30:00.000Z" },
        // Wed Sep 16, 2025
        { id: "last-year", created_at: "2025-09-16T19:00:00.000Z" },
      ],
      TZ,
      now
    );

    expect(sections.map((section) => section.label)).toEqual([
      "Today",
      "Yesterday",
      "Tuesday · Sep 16, 2025",
    ]);
    expect(sections[0]?.items.map((item) => item.id)).toEqual(["today"]);
    expect(sections[1]?.dayKey).toBe("2026-09-17");
  });

  it("can label days as a weekday and calendar date", () => {
    const sections = groupCommentsByDay(
      [{ id: "sample", created_at: "2026-09-02T19:00:00.000Z" }],
      TZ,
      now,
      formatCommentDayHeading
    );
    expect(sections[0]?.label).toBe("Wednesday, September 2");
    expect(formatCommentDayHeading("2025-09-16", TZ, now)).toBe(
      "Tuesday, September 16, 2025"
    );
  });
});

describe("commentCountLabel", () => {
  it("pluralizes the day count", () => {
    expect(commentCountLabel(1)).toBe("1 comment");
    expect(commentCountLabel(7)).toBe("7 comments");
  });
});

describe("commentsPath", () => {
  it("omits default page and empty instrument filters", () => {
    expect(commentsPath({})).toBe("/comments");
    expect(
      commentsPath({
        instrument_id: ["azure-cielo", "hina"],
        page: 2,
        ran_by: "user-1",
      })
    ).toBe("/comments?ran_by=user-1&instrument_id=azure-cielo,hina&page=2");
  });
});
