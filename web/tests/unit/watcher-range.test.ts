import { describe, expect, it } from "vitest";
import {
  addDays,
  daysBetween,
  describeRange,
  eachDay,
  instantOrNull,
  isCalendarDay,
  MAX_HEALTH_DAYS,
  pickerFallback,
  rangeDates,
  rangeTitle,
  resolveWatcherRange,
  shortDayLabel,
  startOfDay,
} from "@/lib/watchers/range";

const NONE = { dateFrom: null, dateTo: null, legacySince: null };

describe("resolveWatcherRange: defaults", () => {
  // 20:30 on the 13th in Los Angeles, which is already the 14th in UTC.
  const NOW = new Date("2026-11-14T04:30:00Z");
  const LA = "America/Los_Angeles";

  it("is the last 7 days for a current watcher, ending today in the viewer's zone", () => {
    const range = resolveWatcherRange(NONE, { timeZone: LA, now: NOW });
    expect(range.toDay).toBe("2026-11-13");
    expect(range.fromDay).toBe("2026-11-07");
    expect(range.dayCount).toBe(7);
    expect(range.isDefault).toBe(true);
    expect(range.wasCut).toBe(false);
    // From the first moment of the 7th day back, to the first moment after today.
    expect(range.start.toISOString()).toBe("2026-11-07T08:00:00.000Z");
    expect(range.endExclusive.toISOString()).toBe("2026-11-14T08:00:00.000Z");
  });

  it("uses the zone's own today", () => {
    const range = resolveWatcherRange(NONE, { timeZone: "UTC", now: NOW });
    expect(range.toDay).toBe("2026-11-14");
    expect(range.fromDay).toBe("2026-11-08");
  });

  it("ends a past watcher's default on the day it was deregistered", () => {
    const range = resolveWatcherRange(NONE, {
      timeZone: "UTC",
      now: NOW,
      deregisteredAt: new Date("2026-11-02T20:30:00Z"),
    });
    expect(range.toDay).toBe("2026-11-02");
    expect(range.fromDay).toBe("2026-10-27");
    expect(range.dayCount).toBe(7);
    expect(range.isDefault).toBe(true);
  });

  it("reads the deregistration day in the viewer's zone", () => {
    const range = resolveWatcherRange(NONE, {
      timeZone: "Asia/Tokyo",
      now: NOW,
      deregisteredAt: new Date("2026-11-02T20:30:00Z"),
    });
    expect(range.toDay).toBe("2026-11-03");
  });
});

describe("resolveWatcherRange: a range in the URL", () => {
  const NOW = new Date("2026-11-13T22:00:00Z");
  const TZ = "UTC";

  it("a calendar preset that starts at midnight starts that day", () => {
    const range = resolveWatcherRange(
      { dateFrom: "2026-11-09T00:00:00.000Z", dateTo: null, legacySince: null },
      { timeZone: TZ, now: NOW }
    );
    expect(range.fromDay).toBe("2026-11-09");
    expect(range.toDay).toBe("2026-11-13");
    expect(range.isDefault).toBe(false);
  });

  it("a rolling preset (Last 7 days) is 7 days ending today", () => {
    // Clicked at 22:00: seven days back is 22:00 on the 6th.
    const range = resolveWatcherRange(
      { dateFrom: "2026-11-06T22:00:00.000Z", dateTo: null, legacySince: null },
      { timeZone: TZ, now: NOW }
    );
    expect(range.fromDay).toBe("2026-11-07");
    expect(range.toDay).toBe("2026-11-13");
    expect(range.dayCount).toBe(7);
  });

  it("Last 2 weeks and Last 4 weeks are 14 and 28 days", () => {
    const twoWeeks = resolveWatcherRange(
      { dateFrom: "2026-10-30T22:00:00.000Z", dateTo: null, legacySince: null },
      { timeZone: TZ, now: NOW }
    );
    expect(twoWeeks.dayCount).toBe(14);
    const fourWeeks = resolveWatcherRange(
      { dateFrom: "2026-10-16T22:00:00.000Z", dateTo: null, legacySince: null },
      { timeZone: TZ, now: NOW }
    );
    expect(fourWeeks.dayCount).toBe(28);
  });

  it("Yesterday is one day: its `to` is the start of that day", () => {
    const range = resolveWatcherRange(
      {
        dateFrom: "2026-11-12T00:00:00.000Z",
        dateTo: "2026-11-12T00:00:00.000Z",
        legacySince: null,
      },
      { timeZone: TZ, now: NOW }
    );
    expect(range.fromDay).toBe("2026-11-12");
    expect(range.toDay).toBe("2026-11-12");
    expect(range.dayCount).toBe(1);
  });

  it("a custom range ends on the day its `to` falls in, at 23:59:59.999", () => {
    const range = resolveWatcherRange(
      {
        dateFrom: "2026-11-03T00:00:00.000Z",
        dateTo: "2026-11-05T23:59:59.999Z",
        legacySince: null,
      },
      { timeZone: TZ, now: NOW }
    );
    expect(range.fromDay).toBe("2026-11-03");
    expect(range.toDay).toBe("2026-11-05");
    expect(range.dayCount).toBe(3);
    expect(range.endExclusive.toISOString()).toBe("2026-11-06T00:00:00.000Z");
  });

  it("works in the viewer's zone, where midnight isn't midnight UTC", () => {
    const range = resolveWatcherRange(
      {
        dateFrom: "2026-11-03T08:00:00.000Z",
        dateTo: "2026-11-06T07:59:59.999Z",
        legacySince: null,
      },
      { timeZone: "America/Los_Angeles", now: NOW }
    );
    expect(range.fromDay).toBe("2026-11-03");
    expect(range.toDay).toBe("2026-11-05");
  });

  it("only an end is a default-length range ending there", () => {
    const range = resolveWatcherRange(
      { dateFrom: null, dateTo: "2026-11-05T23:59:59.999Z", legacySince: null },
      { timeZone: TZ, now: NOW }
    );
    expect(range.toDay).toBe("2026-11-05");
    expect(range.fromDay).toBe("2026-10-30");
  });

  it("an end in the future is today", () => {
    const range = resolveWatcherRange(
      {
        dateFrom: "2026-11-10T00:00:00.000Z",
        dateTo: "2026-12-31T23:59:59.999Z",
        legacySince: null,
      },
      { timeZone: TZ, now: NOW }
    );
    expect(range.toDay).toBe("2026-11-13");
  });

  it("a start after the end is the end's day", () => {
    const range = resolveWatcherRange(
      {
        dateFrom: "2026-11-12T00:00:00.000Z",
        dateTo: "2026-11-05T23:59:59.999Z",
        legacySince: null,
      },
      { timeZone: TZ, now: NOW }
    );
    expect(range.fromDay).toBe("2026-11-05");
    expect(range.toDay).toBe("2026-11-05");
  });

  it("ignores values that aren't dates", () => {
    const range = resolveWatcherRange(
      { dateFrom: "yesterday", dateTo: "soon", legacySince: "later" },
      { timeZone: TZ, now: NOW }
    );
    expect(range.isDefault).toBe(true);
    expect(range.dayCount).toBe(7);
  });

  it("a past watcher with a range in the URL shows that range", () => {
    const range = resolveWatcherRange(
      {
        dateFrom: "2026-10-20T00:00:00.000Z",
        dateTo: "2026-10-21T23:59:59.999Z",
        legacySince: null,
      },
      {
        timeZone: TZ,
        now: NOW,
        deregisteredAt: new Date("2026-11-02T00:00:00Z"),
      }
    );
    expect(range.fromDay).toBe("2026-10-20");
    expect(range.toDay).toBe("2026-10-21");
  });
});

describe("resolveWatcherRange: old links", () => {
  const NOW = new Date("2026-11-13T22:00:00Z");

  it("?since=<day> shows that day through today", () => {
    const range = resolveWatcherRange(
      { dateFrom: null, dateTo: null, legacySince: "2026-11-10" },
      { timeZone: "UTC", now: NOW }
    );
    expect(range.fromDay).toBe("2026-11-10");
    expect(range.toDay).toBe("2026-11-13");
    expect(range.isDefault).toBe(false);
  });

  it("ends at a past watcher's deregistration", () => {
    const range = resolveWatcherRange(
      { dateFrom: null, dateTo: null, legacySince: "2026-10-30" },
      {
        timeZone: "UTC",
        now: NOW,
        deregisteredAt: new Date("2026-11-02T10:00:00Z"),
      }
    );
    expect(range.fromDay).toBe("2026-10-30");
    expect(range.toDay).toBe("2026-11-02");
  });

  it("a day after the end is the end's day", () => {
    const range = resolveWatcherRange(
      { dateFrom: null, dateTo: null, legacySince: "2026-12-01" },
      { timeZone: "UTC", now: NOW }
    );
    expect(range.fromDay).toBe("2026-11-13");
    expect(range.toDay).toBe("2026-11-13");
  });

  it("a range in the URL wins over an old day", () => {
    const range = resolveWatcherRange(
      {
        dateFrom: "2026-11-05T00:00:00.000Z",
        dateTo: null,
        legacySince: "2026-11-10",
      },
      { timeZone: "UTC", now: NOW }
    );
    expect(range.fromDay).toBe("2026-11-05");
  });
});

describe("resolveWatcherRange: maxDays", () => {
  const NOW = new Date("2026-11-13T22:00:00Z");

  it("keeps the last days of a longer range and says it cut it", () => {
    const range = resolveWatcherRange(
      {
        dateFrom: "2026-01-01T00:00:00.000Z",
        dateTo: "2026-11-05T23:59:59.999Z",
        legacySince: null,
      },
      { timeZone: "UTC", now: NOW, maxDays: MAX_HEALTH_DAYS }
    );
    expect(range.toDay).toBe("2026-11-05");
    expect(range.fromDay).toBe("2026-10-06");
    expect(range.dayCount).toBe(MAX_HEALTH_DAYS);
    expect(range.wasCut).toBe(true);
  });

  it("leaves a range that fits", () => {
    const range = resolveWatcherRange(NONE, {
      timeZone: "UTC",
      now: NOW,
      maxDays: MAX_HEALTH_DAYS,
    });
    expect(range.wasCut).toBe(false);
    expect(range.dayCount).toBe(7);
  });
});

describe("pickerFallback", () => {
  const NOW = new Date("2026-11-13T22:00:00Z");

  it("is empty for a current watcher's default, which the picker labels Last 7 days", () => {
    const range = resolveWatcherRange(NONE, { timeZone: "UTC", now: NOW });
    expect(pickerFallback(range, "UTC", false)).toEqual({
      from: null,
      to: null,
    });
  });

  it("is the days themselves for a past watcher's default", () => {
    const range = resolveWatcherRange(NONE, {
      timeZone: "UTC",
      now: NOW,
      deregisteredAt: new Date("2026-11-02T10:00:00Z"),
    });
    expect(pickerFallback(range, "UTC", true)).toEqual({
      from: "2026-10-27T00:00:00.000Z",
      to: "2026-11-02T00:00:00.000Z",
    });
  });

  it("is the days themselves for an old link's day", () => {
    const range = resolveWatcherRange(
      { dateFrom: null, dateTo: null, legacySince: "2026-11-10" },
      { timeZone: "UTC", now: NOW }
    );
    expect(pickerFallback(range, "UTC", false)).toEqual({
      from: "2026-11-10T00:00:00.000Z",
      to: "2026-11-13T00:00:00.000Z",
    });
  });
});

describe("words", () => {
  const NOW = new Date("2026-11-13T22:00:00Z");
  const range = (fromDay: string, toDay: string) => ({
    fromDay,
    toDay,
    dayCount: daysBetween(fromDay, toDay) + 1,
  });

  it("describeRange fits a sentence", () => {
    expect(describeRange(range("2026-11-07", "2026-11-13"), "UTC", NOW)).toBe(
      "in the last 7 days"
    );
    expect(describeRange(range("2026-11-13", "2026-11-13"), "UTC", NOW)).toBe(
      "today"
    );
    expect(describeRange(range("2026-11-10", "2026-11-10"), "UTC", NOW)).toBe(
      "on Nov 10"
    );
    expect(describeRange(range("2026-10-27", "2026-11-02"), "UTC", NOW)).toBe(
      "from Oct 27 to Nov 2"
    );
  });

  it("describeRange names the year of a day in another year", () => {
    expect(describeRange(range("2025-12-29", "2026-01-02"), "UTC", NOW)).toBe(
      "from Dec 29, 2025 to Jan 2, 2026"
    );
  });

  it("rangeTitle and rangeDates head a section", () => {
    expect(rangeTitle(range("2026-11-07", "2026-11-13"), "UTC", NOW)).toBe(
      "Last 7 days"
    );
    expect(rangeTitle(range("2026-11-13", "2026-11-13"), "UTC", NOW)).toBe(
      "Today"
    );
    expect(rangeTitle(range("2026-10-27", "2026-11-02"), "UTC", NOW)).toBe(
      "Oct 27 to Nov 2"
    );
    expect(rangeDates(range("2026-11-07", "2026-11-13"), "UTC", NOW)).toBe(
      "Nov 7 to Nov 13"
    );
    expect(rangeDates(range("2026-11-10", "2026-11-10"), "UTC", NOW)).toBe(
      "Nov 10"
    );
  });

  it("labels a day for a row, a bar and a tooltip", () => {
    expect(shortDayLabel("2026-11-07")).toBe("Sat 7");
  });
});

describe("calendar helpers", () => {
  it("recognises a real day", () => {
    expect(isCalendarDay("2026-11-07")).toBe(true);
    expect(isCalendarDay("2026-02-30")).toBe(false);
    expect(isCalendarDay("11/07/2026")).toBe(false);
    expect(isCalendarDay(null)).toBe(false);
  });

  it("moves across a month and a year", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("counts days and lists them", () => {
    expect(daysBetween("2026-11-07", "2026-11-13")).toBe(6);
    expect(eachDay("2026-11-30", "2026-12-02")).toEqual([
      "2026-11-30",
      "2026-12-01",
      "2026-12-02",
    ]);
  });

  it("starts a day at the zone's midnight, across a clock change", () => {
    // 2026-11-01: US clocks go back, so the day is 25 hours long.
    expect(startOfDay("2026-11-01", "America/Los_Angeles").toISOString()).toBe(
      "2026-11-01T07:00:00.000Z"
    );
    expect(startOfDay("2026-11-02", "America/Los_Angeles").toISOString()).toBe(
      "2026-11-02T08:00:00.000Z"
    );
  });
});

describe("instantOrNull", () => {
  it("keeps a moment in time and drops anything else", () => {
    expect(instantOrNull("2026-11-10T08:00:00.000Z")).toBe(
      "2026-11-10T08:00:00.000Z"
    );
    expect(instantOrNull("garbage")).toBeNull();
    expect(instantOrNull("")).toBeNull();
    expect(instantOrNull(null)).toBeNull();
  });
});
