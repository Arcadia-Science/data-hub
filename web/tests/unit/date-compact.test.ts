import { describe, expect, it } from "vitest";
import { formatDateCompact } from "@/lib/date";

// Midday UTC keeps the calendar day the same in every time zone.
describe("formatDateCompact", () => {
  const now = new Date("2026-10-20T12:00:00Z");

  it("leaves out the year for a date in the current year", () => {
    expect(formatDateCompact(new Date("2026-10-07T12:00:00Z"), now)).toBe(
      "Oct 7"
    );
  });

  it("adds the year for a date in another year", () => {
    expect(formatDateCompact(new Date("2025-10-07T12:00:00Z"), now)).toBe(
      "Oct 7, 2025"
    );
  });
});
