import { describe, expect, it } from "vitest";
import { groupCommentsByDay } from "@/lib/comments/group-by-day";

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
});
