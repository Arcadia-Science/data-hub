import { describe, expect, it } from "vitest";
import { calendarDayKey, formatNotificationDayHeading } from "@/lib/date";

const TZ = "America/Los_Angeles";

describe("calendarDayKey", () => {
  it("returns the Pacific calendar day for a UTC instant", () => {
    // 10 PM PDT on Sep 16 is Sep 17 05:00 UTC — local day is still the 16th.
    expect(calendarDayKey(new Date("2026-09-17T05:00:00.000Z"), TZ)).toBe(
      "2026-09-16"
    );
  });
});

describe("formatNotificationDayHeading", () => {
  const now = new Date("2026-09-18T17:30:00.000Z"); // Fri Sep 18 10:30 AM PDT

  it("labels the current local day as Today", () => {
    expect(formatNotificationDayHeading("2026-09-18", TZ, now)).toBe("Today");
  });

  it("labels the previous local day as Yesterday", () => {
    expect(formatNotificationDayHeading("2026-09-17", TZ, now)).toBe(
      "Yesterday"
    );
  });

  it("uses weekday + month day for older dates", () => {
    expect(formatNotificationDayHeading("2026-09-16", TZ, now)).toBe(
      "Wednesday · Sep 16"
    );
  });
});
