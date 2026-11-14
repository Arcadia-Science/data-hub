import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getWatcherHealth } from "@/lib/api/watcher-health";
import {
  instruments,
  watcherEvents,
  watcherHeartbeats,
  watchers,
} from "@/lib/db/schema";
import { BLOCKS_PER_DAY } from "@/lib/watchers/health";
import { addDays, startOfDay } from "@/lib/watchers/range";
import { closeTestDb, getTestDb, resetDb } from "@/tests/integration/helpers";

// The Health tab's read, against a real database: the SQL that groups
// heartbeats into 30-minute blocks in the viewer's zone and counts the range's
// events, and the colours the blocks get from what it returns. The rules for a
// colour are in tests/unit/watcher-health.test.ts; this checks the query feeds
// them the right facts.

const MIN = 60 * 1000;
const at = (iso: string) => new Date(`${iso}:00Z`);

// "Now" is noon on the 11th, so the afternoon of the 11th has not happened.
const NOW = at("2026-03-11T12:00");

describe("getWatcherHealth", () => {
  let watcherId: string;

  beforeAll(async () => {
    await resetDb();
    const db = getTestDb();
    await db.insert(instruments).values({
      id: "health-test-instrument",
      displayName: "Health Test Instrument",
      status: "active",
    });
    const [watcher] = await db
      .insert(watchers)
      .values({
        instrumentId: "health-test-instrument",
        hostname: "HEALTH-PC",
        status: "watching",
        createdAt: at("2026-03-09T00:00"),
      })
      .returning({ id: watchers.id });
    watcherId = watcher.id;

    // A heartbeat every five minutes from midnight on the 10th to 11:55 on the
    // 11th, except where a story below says the watcher was quiet.
    const quiet = (time: number): boolean => {
      const inside = (from: string, to: string) =>
        time > at(from).getTime() && time < at(to).getTime();
      return (
        // A gap that recovered, from 10:05 to 11:00 on the 10th.
        inside("2026-03-10T10:05", "2026-03-10T11:00") ||
        // A restart for an update, 14:00 to 14:10 on the 10th.
        inside("2026-03-10T14:00", "2026-03-10T14:10") ||
        // Someone stopped the watcher at 20:00 until 22:00 on the 10th.
        inside("2026-03-10T20:00", "2026-03-10T22:00") ||
        // Silence nobody explains, 05:35 to 07:00 on the 11th.
        inside("2026-03-11T05:35", "2026-03-11T07:00")
      );
    };
    const stops = new Set([
      at("2026-03-10T14:00").getTime(),
      at("2026-03-10T20:00").getTime(),
    ]);
    const heartbeats: (typeof watcherHeartbeats.$inferInsert)[] = [];
    for (
      let time = at("2026-03-10T00:00").getTime();
      time < NOW.getTime();
      time += 5 * MIN
    ) {
      if (!quiet(time)) {
        heartbeats.push({
          watcherId,
          timestamp: new Date(time),
          status: stops.has(time) ? "stopped" : "watching",
        });
      }
    }
    await db.insert(watcherHeartbeats).values(heartbeats);

    const upload = (when: string, run: string, file: string) => ({
      watcherId,
      eventType: "file_uploaded" as const,
      message: `Uploaded ${file}`,
      details: {
        s3_key: `health-test-instrument/${run}/${file}`,
        size_bytes: 1024,
      },
      timestamp: at(when),
    });
    await db.insert(watcherEvents).values([
      // Three files in two runs on the 10th, one more at 03:00 UTC on the 11th:
      // the evening of the 10th in Los Angeles.
      upload("2026-03-10T09:00", "run-a", "a-1.csv"),
      upload("2026-03-10T12:00", "run-a", "a-2.csv"),
      upload("2026-03-10T18:00", "run-b", "b-1.csv"),
      upload("2026-03-11T03:00", "run-c", "c-1.csv"),
      // One failure, and one file that can't be read yet, which isn't a failure.
      {
        watcherId,
        eventType: "upload_failed",
        message: "Upload failed: a-3.csv",
        details: { error: "timed out" },
        timestamp: at("2026-03-10T13:00"),
      },
      {
        watcherId,
        eventType: "upload_failed",
        message: "Can't read a-4.csv yet (locked).",
        details: { will_retry: true },
        timestamp: at("2026-03-10T13:05"),
      },
      // A gap of 55 minutes that recovered at 11:00.
      {
        watcherId,
        eventType: "error",
        message: "Heartbeat recovered after 11 consecutive failure(s)",
        details: {
          kind: "heartbeat_recovered",
          consecutive_failures: 11,
          gap_seconds: 3300,
        },
        timestamp: at("2026-03-10T11:00"),
      },
      // Another kind of error, which is not a missed heartbeat.
      {
        watcherId,
        eventType: "error",
        message: "Could not push config to API",
        details: { kind: "config_sync_failed" },
        timestamp: at("2026-03-10T11:05"),
      },
      // A restart for an update, and the start that ends it.
      {
        watcherId,
        eventType: "watcher_stopped",
        message: "Service restarting for auto-update",
        timestamp: at("2026-03-10T14:00"),
      },
      {
        watcherId,
        eventType: "watcher_started",
        message: "Service started on HEALTH-PC",
        timestamp: at("2026-03-10T14:10"),
      },
      // A stop by someone, which is not a restart.
      {
        watcherId,
        eventType: "watcher_stopped",
        message: "Service stopped",
        timestamp: at("2026-03-10T20:00"),
      },
      {
        watcherId,
        eventType: "watcher_started",
        message: "Service started on HEALTH-PC",
        timestamp: at("2026-03-10T22:00"),
      },
      // The server's note about cancelled uploads, which isn't a stop at all,
      // even though its message says the word.
      {
        watcherId,
        eventType: "watcher_stopped",
        message: "Cancelled uploads while restarting for auto-update",
        details: { kind: "upload_requests_cancelled", cancelled_count: 1 },
        timestamp: at("2026-03-10T15:00"),
      },
      // A Windows restart on the 11th.
      {
        watcherId,
        eventType: "watcher_stopped",
        message: "Service stopped: Windows is shutting down",
        timestamp: at("2026-03-11T08:00"),
      },
      {
        watcherId,
        eventType: "watcher_started",
        message: "Service started on HEALTH-PC",
        timestamp: at("2026-03-11T08:09"),
      },
    ]);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const utcRange = {
    fromDay: "2026-03-10",
    toDay: "2026-03-11",
    start: at("2026-03-10T00:00"),
    endExclusive: at("2026-03-12T00:00"),
    timeZone: "UTC",
    deregisteredAt: null,
    now: NOW,
  };

  it("counts the range's files, runs, failures, restarts and missed heartbeats", async () => {
    const { totals } = await getWatcherHealth(watcherId, utcRange);
    expect(totals.files).toBe(4);
    expect(totals.runs).toBe(3);
    expect(totals.daysWithFiles).toEqual(["2026-03-10", "2026-03-11"]);
    // The file that can't be read yet is waited for, not failed.
    expect(totals.uploadFailures).toBe(1);
    // A stop by someone and the server's note are not restarts.
    expect(totals.restarts).toEqual({ update: 1, windows: 1 });
    // The other kind of error is not a missed heartbeat.
    expect(totals.missedHeartbeats).toBe(1);
    expect(totals.longestMissedSeconds).toBe(3300);
  });

  it("counts only what is in the range", async () => {
    const { totals } = await getWatcherHealth(watcherId, {
      ...utcRange,
      fromDay: "2026-03-11",
      start: at("2026-03-11T00:00"),
    });
    expect(totals.files).toBe(1);
    expect(totals.runs).toBe(1);
    expect(totals.uploadFailures).toBe(0);
    expect(totals.restarts).toEqual({ update: 0, windows: 1 });
    expect(totals.missedHeartbeats).toBe(0);
    expect(totals.longestMissedSeconds).toBe(0);
  });

  it("returns a row per day with 48 blocks and the day's files", async () => {
    const { days } = await getWatcherHealth(watcherId, utcRange);
    expect(days.map((day) => day.date)).toEqual(["2026-03-10", "2026-03-11"]);
    expect(days.map((day) => day.files)).toEqual([3, 1]);
    for (const day of days) {
      expect(day.blocks).toHaveLength(BLOCKS_PER_DAY);
    }
  });

  it("colours the blocks from what the watcher sent", async () => {
    const { days } = await getWatcherHealth(watcherId, utcRange);
    const [tenth, eleventh] = days;
    const states = (day: typeof tenth, from: number, to: number) =>
      day.blocks.slice(from, to + 1).map((block) => block.state);

    // 10:00 holds the start of the gap and 10:30 heard nothing: missed. 11:00 is
    // back.
    expect(states(tenth, 20, 22)).toEqual(["missed", "missed", "checked_in"]);
    expect(tenth.blocks[20].missed).toEqual({
      gapSeconds: 3300,
      recoveredAt: at("2026-03-10T11:00"),
    });
    // The restart holds one block, 14:00, and the next has heartbeats again.
    expect(states(tenth, 28, 29)).toEqual(["restarted", "checked_in"]);
    expect(tenth.blocks[28].restart).toEqual({
      reason: "update",
      stoppedAt: at("2026-03-10T14:00"),
      resumedAt: at("2026-03-10T14:10"),
    });
    // A stop by someone: the quiet after it is no data, and 22:00 is back.
    expect(states(tenth, 41, 44)).toEqual([
      "no_data",
      "no_data",
      "no_data",
      "checked_in",
    ]);
    expect(tenth.blocks[41].noData).toBe("stopped");

    // Quiet nobody explains is unresponsive, from 06:00 to 07:00.
    expect(states(eleventh, 11, 14)).toEqual([
      "checked_in",
      "unresponsive",
      "unresponsive",
      "checked_in",
    ]);
    // The Windows restart at 08:00.
    expect(eleventh.blocks[16].state).toBe("restarted");
    expect(eleventh.blocks[16].restart?.reason).toBe("windows");
    // Noon hasn't happened yet.
    expect(eleventh.blocks[24]).toMatchObject({
      state: "no_data",
      noData: "future",
    });
    expect(eleventh.blocks[47].noData).toBe("future");
  });

  it("counts the heartbeats in a block", async () => {
    const { days } = await getWatcherHealth(watcherId, utcRange);
    // Six heartbeats in 30 minutes, five minutes apart.
    expect(days[0].blocks[0].heartbeats).toBe(6);
  });

  it("is no data before the watcher's first check-in", async () => {
    const { days } = await getWatcherHealth(watcherId, {
      ...utcRange,
      fromDay: "2026-03-08",
      toDay: "2026-03-09",
      start: at("2026-03-08T00:00"),
      endExclusive: at("2026-03-10T00:00"),
    });
    for (const day of days) {
      for (const block of day.blocks) {
        expect(block).toMatchObject({
          state: "no_data",
          noData: "before_first_check_in",
        });
      }
    }
  });

  it("is no data after the watcher was deregistered", async () => {
    const { days } = await getWatcherHealth(watcherId, {
      ...utcRange,
      deregisteredAt: at("2026-03-10T12:00"),
    });
    expect(days[0].blocks[23].state).toBe("checked_in");
    expect(days[0].blocks[24]).toMatchObject({
      state: "no_data",
      noData: "after_deregistered",
    });
    expect(days[1].blocks[0].noData).toBe("after_deregistered");
  });

  describe("in the viewer's time zone", () => {
    // Los Angeles is on daylight time from March 8: seven hours behind UTC.
    const zone = "America/Los_Angeles";
    const day = "2026-03-10";
    const losAngeles = {
      ...utcRange,
      timeZone: zone,
      fromDay: day,
      toDay: day,
      start: startOfDay(day, zone),
      endExclusive: startOfDay(addDays(day, 1), zone),
    };

    it("groups a day's files by the viewer's day", async () => {
      const { days, totals } = await getWatcherHealth(watcherId, losAngeles);
      // The three uploads of the 10th UTC, and the 03:00 UTC one on the 11th,
      // which is 20:00 on the 10th in Los Angeles.
      expect(days[0].files).toBe(4);
      expect(totals.files).toBe(4);
    });

    it("puts a block where the viewer's clock puts it", async () => {
      const { days } = await getWatcherHealth(watcherId, losAngeles);
      // 14:00 UTC is 07:00 in Los Angeles: block 14.
      expect(days[0].blocks[14].state).toBe("restarted");
      expect(days[0].blocks[14].restart?.stoppedAt).toEqual(
        at("2026-03-10T14:00")
      );
    });

    it("handles a day that is 23 hours long", async () => {
      // 2026-03-08: clocks go forward at 02:00.
      const springForward = "2026-03-08";
      const { days } = await getWatcherHealth(watcherId, {
        ...losAngeles,
        fromDay: springForward,
        toDay: springForward,
        start: startOfDay(springForward, zone),
        endExclusive: startOfDay(addDays(springForward, 1), zone),
      });
      expect(days[0].blocks).toHaveLength(BLOCKS_PER_DAY);
      expect(days[0].blocks.every((block) => block.state === "no_data")).toBe(
        true
      );
    });
  });
});
