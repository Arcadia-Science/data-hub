import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDateLong,
  formatDateRange,
  formatDateTime,
  formatDateTimeShort,
  formatTime,
  todayDateString,
} from "@/lib/date";

// 02:30 UTC on Oct 15 is still the evening of Oct 14 in Los Angeles (UTC-7)
// and already the morning of Oct 15 in Tokyo (UTC+9).
const instant = new Date("2026-10-15T02:30:00Z");

describe("date formatters use the zone they are given", () => {
  it("formats the same instant differently per zone", () => {
    expect(formatDateTime(instant, "America/Los_Angeles")).toBe(
      "Oct 14, 2026 7:30 PM"
    );
    expect(formatDateTime(instant, "Asia/Tokyo")).toBe("Oct 15, 2026 11:30 AM");
    expect(formatDateTime(instant, "UTC")).toBe("Oct 15, 2026 2:30 AM");
  });

  it("applies the zone to every format", () => {
    const zone = "America/Los_Angeles";
    expect(formatTime(instant, zone)).toBe("7:30 PM");
    expect(formatDate(instant, zone)).toBe("Oct 14, 2026");
    expect(formatDateLong(instant, zone)).toBe("14 October 2026");
    expect(formatDateTimeShort(instant, zone)).toBe("Oct 14, 7:30 PM");
  });

  it("uses the zone to decide which calendar day is today", () => {
    expect(todayDateString("America/Los_Angeles", instant)).toBe("2026-10-14");
    expect(todayDateString("Asia/Tokyo", instant)).toBe("2026-10-15");
  });

  it("formats a range in the given zone", () => {
    const from = new Date("2026-10-01T02:00:00Z");
    expect(formatDateRange(from, instant, "America/Los_Angeles")).toBe(
      "Sep 30 – Oct 14, 2026"
    );
    expect(formatDateRange(from, instant, "UTC")).toBe("Oct 1 – Oct 15, 2026");
  });
});
