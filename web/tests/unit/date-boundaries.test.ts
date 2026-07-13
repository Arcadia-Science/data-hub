import { describe, expect, it } from "vitest";
import {
  isValidTimeZone,
  startOfLastWeekEndDayISO,
  startOfLastWeekISO,
  startOfMonthISO,
  startOfTodayISO,
  startOfWeekISO,
  startOfYesterdayISO,
} from "@/lib/date";

describe("isValidTimeZone", () => {
  it("accepts common IANA zones", () => {
    expect(isValidTimeZone("America/Los_Angeles")).toBe(true);
    expect(isValidTimeZone("Asia/Tokyo")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });

  it("rejects empty and garbage values", () => {
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("Not/A_Zone")).toBe(false);
    expect(isValidTimeZone("America/Los_Angeles; DROP TABLE")).toBe(false);
  });
});

describe("startOfTodayISO", () => {
  it("returns local midnight as UTC for America/Los_Angeles", () => {
    // Wednesday afternoon Pacific (UTC-7 in July).
    const now = new Date("2026-07-08T21:30:00.000Z"); // 2:30 PM PDT
    expect(startOfTodayISO("America/Los_Angeles", now)).toBe(
      "2026-07-08T07:00:00.000Z"
    );
  });

  it("returns local midnight as UTC for Asia/Tokyo", () => {
    // Thursday morning UTC is already Thursday afternoon in Tokyo (UTC+9).
    const now = new Date("2026-07-08T20:00:00.000Z"); // Jul 9 05:00 JST
    expect(startOfTodayISO("Asia/Tokyo", now)).toBe("2026-07-08T15:00:00.000Z");
  });

  it("crosses the UTC date line for a late Pacific evening", () => {
    // 10 PM PDT on Jul 8 is Jul 9 05:00 UTC — local day is still Jul 8.
    const now = new Date("2026-07-09T05:00:00.000Z");
    expect(startOfTodayISO("America/Los_Angeles", now)).toBe(
      "2026-07-08T07:00:00.000Z"
    );
  });
});

describe("startOfWeekISO", () => {
  it("returns Monday midnight for a mid-week Pacific afternoon", () => {
    // Wednesday Jul 8 2026 → week starts Monday Jul 6 00:00 PDT.
    const now = new Date("2026-07-08T21:30:00.000Z");
    expect(startOfWeekISO("America/Los_Angeles", now)).toBe(
      "2026-07-06T07:00:00.000Z"
    );
  });

  it("keeps Sunday in the week that started the prior Monday", () => {
    // Sunday Jul 12 2026 15:00 PDT → still the week of Monday Jul 6.
    const now = new Date("2026-07-12T22:00:00.000Z");
    expect(startOfWeekISO("America/Los_Angeles", now)).toBe(
      "2026-07-06T07:00:00.000Z"
    );
  });

  it("rolls to the new week at Monday midnight Tokyo", () => {
    // Monday Jul 13 2026 00:30 JST = Sunday Jul 12 15:30 UTC.
    const justAfterMonday = new Date("2026-07-12T15:30:00.000Z");
    expect(startOfWeekISO("Asia/Tokyo", justAfterMonday)).toBe(
      "2026-07-12T15:00:00.000Z"
    );

    // Sunday Jul 12 2026 23:30 JST = still the prior week (Mon Jul 6).
    const stillSunday = new Date("2026-07-12T14:30:00.000Z");
    expect(startOfWeekISO("Asia/Tokyo", stillSunday)).toBe(
      "2026-07-05T15:00:00.000Z"
    );
  });
});

describe("startOfYesterdayISO", () => {
  it("returns the prior local midnight in America/Los_Angeles", () => {
    const now = new Date("2026-07-08T21:30:00.000Z"); // Wed Jul 8 afternoon PDT
    expect(startOfYesterdayISO("America/Los_Angeles", now)).toBe(
      "2026-07-07T07:00:00.000Z"
    );
  });
});

describe("startOfLastWeekISO", () => {
  it("returns the prior Monday and Sunday for a mid-week Pacific day", () => {
    // Wed Jul 8 → this week Mon Jul 6; last week Mon Jun 29 – Sun Jul 5.
    const now = new Date("2026-07-08T21:30:00.000Z");
    expect(startOfLastWeekISO("America/Los_Angeles", now)).toBe(
      "2026-06-29T07:00:00.000Z"
    );
    expect(startOfLastWeekEndDayISO("America/Los_Angeles", now)).toBe(
      "2026-07-05T07:00:00.000Z"
    );
  });
});

describe("startOfMonthISO", () => {
  it("returns the 1st at local midnight", () => {
    const now = new Date("2026-07-08T21:30:00.000Z");
    expect(startOfMonthISO("America/Los_Angeles", now)).toBe(
      "2026-07-01T07:00:00.000Z"
    );
  });
});
