import { describe, expect, it } from "vitest";
import {
  dayWindow,
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

describe("dayWindow", () => {
  const later = new Date("2030-01-01T00:00:00Z");

  it("runs from local midnight to the next local midnight", () => {
    const { start, end } = dayWindow(
      "2026-10-14",
      "America/Los_Angeles",
      later
    );
    expect(start.toISOString()).toBe("2026-10-14T07:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-15T07:00:00.000Z");
  });

  it("starts at a different instant in each zone", () => {
    expect(dayWindow("2026-10-14", "UTC", later).start.toISOString()).toBe(
      "2026-10-14T00:00:00.000Z"
    );
    expect(
      dayWindow("2026-10-14", "Asia/Tokyo", later).start.toISOString()
    ).toBe("2026-10-13T15:00:00.000Z");
  });

  it("covers 25 hours on the day clocks go back", () => {
    const { start, end } = dayWindow(
      "2026-11-01",
      "America/Los_Angeles",
      later
    );
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(25);
  });

  it("ends at now while the day is still in progress", () => {
    const now = new Date("2026-10-14T20:00:00Z");
    expect(dayWindow("2026-10-14", "America/Los_Angeles", now).end).toEqual(
      now
    );
  });
});
