import { describe, expect, it } from "vitest";
import { calendarDayKey, formatDayHeading } from "@/lib/date";

const TZ = "America/Los_Angeles";

describe("calendarDayKey", () => {
  it("returns the Pacific calendar day for a UTC instant", () => {
    // 10 PM PDT on Sep 16 is Sep 17 05:00 UTC — local day is still the 16th.
    expect(calendarDayKey(new Date("2026-09-17T05:00:00.000Z"), TZ)).toBe(
      "2026-09-16"
    );
  });
});

describe("formatDayHeading", () => {
  const now = new Date("2026-09-18T17:30:00.000Z"); // Fri Sep 18 10:30 AM PDT

  it("labels the current local day as Today", () => {
    expect(formatDayHeading("2026-09-18", TZ, now)).toBe("Today");
  });

  it("labels the previous local day as Yesterday", () => {
    expect(formatDayHeading("2026-09-17", TZ, now)).toBe("Yesterday");
  });

  it("uses weekday + month day for older dates", () => {
    expect(formatDayHeading("2026-09-16", TZ, now)).toBe("Wednesday · Sep 16");
  });

  it("adds the year for dates outside the current year when asked", () => {
    expect(
      formatDayHeading("2025-09-16", TZ, now, {
        yearIfNotCurrent: true,
      })
    ).toBe("Tuesday · Sep 16, 2025");
    expect(formatDayHeading("2025-09-16", TZ, now)).toBe("Tuesday · Sep 16");
  });
});
