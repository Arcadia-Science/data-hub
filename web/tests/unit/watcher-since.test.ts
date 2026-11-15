import { describe, expect, it } from "vitest";
import { defaultWatcherSince, tzSafeSince } from "@/lib/watchers/since";

describe("defaultWatcherSince", () => {
  const NOW = new Date("2026-11-14T03:00:00Z");

  it("is today in the viewer's zone for a current watcher", () => {
    // 03:00 UTC is still the 13th in Los Angeles.
    expect(defaultWatcherSince(null, "America/Los_Angeles", NOW)).toBe(
      "2026-11-13"
    );
    expect(defaultWatcherSince(null, "UTC", NOW)).toBe("2026-11-14");
  });

  it("is the day a past watcher was deregistered", () => {
    const deletedAt = new Date("2026-11-02T20:30:00Z");
    expect(defaultWatcherSince(deletedAt, "UTC", NOW)).toBe("2026-11-02");
    expect(defaultWatcherSince(deletedAt, "Asia/Tokyo", NOW)).toBe(
      "2026-11-03"
    );
  });
});

describe("tzSafeSince", () => {
  it("starts a day early, to cover the viewer's whole local day", () => {
    expect(tzSafeSince("2026-11-14").toISOString()).toBe(
      "2026-11-13T00:00:00.000Z"
    );
    expect(tzSafeSince("2026-03-01").toISOString()).toBe(
      "2026-02-28T00:00:00.000Z"
    );
  });
});
