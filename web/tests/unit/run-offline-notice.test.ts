import { describe, expect, it } from "vitest";
import type { InstrumentBadgeState } from "@/lib/instruments/connection";
import { formatLastCheckIn } from "@/lib/instruments/problem-notice";
import {
  offlineNoticeCopy,
  shouldShowOfflineNotice,
} from "@/lib/runs/offline-notice";

describe("shouldShowOfflineNotice", () => {
  it("shows for an Offline instrument and a run with waiting files", () => {
    expect(shouldShowOfflineNotice("offline", 2)).toBe(true);
    expect(shouldShowOfflineNotice("offline", 1)).toBe(true);
  });

  it("stays away from a run with no waiting files, even when Offline", () => {
    expect(shouldShowOfflineNotice("offline", 0)).toBe(false);
  });

  it("stays away while the instrument PC restarts, even with waiting files", () => {
    expect(shouldShowOfflineNotice("restarting", 3)).toBe(false);
  });

  it("stays away for every other badge, even with waiting files", () => {
    const others = [
      "online",
      "connecting",
      "pending",
      "retired",
    ] as const satisfies readonly InstrumentBadgeState[];
    for (const badge of others) {
      expect(shouldShowOfflineNotice(badge, 3)).toBe(false);
    }
  });
});

describe("offlineNoticeCopy", () => {
  it("counts the waiting files and says when the watcher last checked in", () => {
    expect(
      offlineNoticeCopy({
        waitingFileCount: 2,
        instrumentName: "Plate Reader A",
        lastCheckIn: "today at 2:14 PM",
      })
    ).toEqual({
      title: "2 files from this run are still on the instrument PC",
      body: "The watcher for Plate Reader A isn't running, so they can't upload until it's back. It last checked in today at 2:14 PM.",
    });
  });

  it("uses the singular for one file", () => {
    expect(
      offlineNoticeCopy({
        waitingFileCount: 1,
        instrumentName: "Plate Reader A",
        lastCheckIn: "today at 2:14 PM",
      })
    ).toEqual({
      title: "1 file from this run is still on the instrument PC",
      body: "The watcher for Plate Reader A isn't running, so it can't upload until it's back. It last checked in today at 2:14 PM.",
    });
  });

  it("drops the last sentence when the watcher never checked in", () => {
    expect(
      offlineNoticeCopy({
        waitingFileCount: 2,
        instrumentName: "Plate Reader A",
        lastCheckIn: null,
      }).body
    ).toBe(
      "The watcher for Plate Reader A isn't running, so they can't upload until it's back."
    );
  });
});

describe("formatLastCheckIn", () => {
  const now = new Date("2026-11-12T20:30:00Z");

  it("says today for a check-in on the viewer's day", () => {
    expect(
      formatLastCheckIn(new Date("2026-11-12T19:14:00Z"), "UTC", now)
    ).toBe("today at 7:14 PM");
  });

  it("says yesterday for a check-in the day before", () => {
    expect(
      formatLastCheckIn(new Date("2026-11-11T19:14:00Z"), "UTC", now)
    ).toBe("yesterday at 7:14 PM");
  });

  it("gives the date for an older check-in in the same year", () => {
    expect(
      formatLastCheckIn(new Date("2026-11-09T19:14:00Z"), "UTC", now)
    ).toBe("Nov 9 at 7:14 PM");
  });

  it("adds the year for a check-in in another year", () => {
    expect(
      formatLastCheckIn(new Date("2025-11-09T19:14:00Z"), "UTC", now)
    ).toBe("Nov 9, 2025 at 7:14 PM");
  });

  it("counts the day in the viewer's time zone", () => {
    // 19:30 UTC on Nov 12 is 04:30 on Nov 13 in Tokyo, so a check-in at 10:00
    // UTC is today for a viewer in UTC and yesterday for one in Tokyo.
    const lateNow = new Date("2026-11-12T19:30:00Z");
    const checkIn = new Date("2026-11-12T10:00:00Z");
    expect(formatLastCheckIn(checkIn, "UTC", lateNow)).toBe(
      "today at 10:00 AM"
    );
    expect(formatLastCheckIn(checkIn, "Asia/Tokyo", lateNow)).toBe(
      "yesterday at 7:00 PM"
    );
  });
});
