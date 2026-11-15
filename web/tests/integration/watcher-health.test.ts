import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getWatcherHealth } from "@/lib/api/watcher-health";
import {
  instruments,
  watcherEvents,
  watcherHeartbeats,
  watchers,
} from "@/lib/db/schema";
import { BLOCKS_PER_DAY } from "@/lib/watchers/block-edges";
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
        // A restart for an update through the upgrade worker, 16:00 to 16:10
        // on the 10th.
        inside("2026-03-10T16:00", "2026-03-10T16:10") ||
        // A restart that begins before the 11th, 23:55 to 00:40.
        inside("2026-03-10T23:55", "2026-03-11T00:40") ||
        // Silence nobody explains, 05:35 to 07:00 on the 11th.
        inside("2026-03-11T05:35", "2026-03-11T07:00") ||
        // A power cut that wrote no stop event, 09:20 to 09:45 on the 11th.
        inside("2026-03-11T09:20", "2026-03-11T09:45")
      );
    };
    const stops = new Set([
      at("2026-03-10T14:00").getTime(),
      at("2026-03-10T16:00").getTime(),
      at("2026-03-10T20:00").getTime(),
      at("2026-03-10T23:55").getTime(),
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
      // A restart for an update through the Windows upgrade worker: the
      // watcher hands the update over, and the worker stops the service from
      // outside, so the stop's message says only that the service stopped.
      {
        watcherId,
        eventType: "update_started",
        message: "Dispatching upgrade 1.4.1 -> 1.4.2 via worker",
        details: { via_worker: true },
        timestamp: at("2026-03-10T15:58"),
      },
      {
        watcherId,
        eventType: "watcher_stopped",
        message: "Service stopped",
        timestamp: at("2026-03-10T16:00"),
      },
      {
        watcherId,
        eventType: "watcher_started",
        message: "Service started on HEALTH-PC",
        timestamp: at("2026-03-10T16:10"),
      },
      // A restart that begins at 23:55 on the 10th, for an update, whose final
      // heartbeat's reason is on the event.
      {
        watcherId,
        eventType: "watcher_stopped",
        message: "Service stopped",
        details: { stop_reason: "auto_update" },
        timestamp: at("2026-03-10T23:55"),
      },
      {
        watcherId,
        eventType: "watcher_started",
        message: "Service started on HEALTH-PC",
        timestamp: at("2026-03-11T00:40"),
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
    // The update that stamped its reason, the one that followed an update
    // handed to the upgrade worker, and the one whose message says so: three.
    // A stop by someone and the server's note are not restarts.
    expect(totals.restarts).toEqual({ update: 3, windows: 1 });
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
    // The restart whose stop says only "Service stopped" is gray too: it follows
    // the update handed to the upgrade worker.
    expect(states(tenth, 32, 33)).toEqual(["restarted", "checked_in"]);
    expect(tenth.blocks[32].restart?.reason).toBe("update");
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

    // Quiet nobody explains is unresponsive: the watcher read Unresponsive from
    // 05:40, which is in the 05:30 block, to 07:00.
    expect(states(eleventh, 11, 14)).toEqual([
      "unresponsive",
      "unresponsive",
      "unresponsive",
      "checked_in",
    ]);
    // A power cut with no stop event: heartbeats at 09:20 and 09:45 leave both
    // blocks red, though each holds a heartbeat.
    expect(eleventh.blocks[18].heartbeats).toBeGreaterThan(0);
    expect(eleventh.blocks[19].heartbeats).toBeGreaterThan(0);
    expect(states(eleventh, 17, 20)).toEqual([
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

  it("colours the first quiet block gray when a restart began before the range", async () => {
    const { days } = await getWatcherHealth(watcherId, {
      ...utcRange,
      fromDay: "2026-03-11",
      start: at("2026-03-11T00:00"),
    });
    // The update stopped the watcher at 23:55 on the 10th, which is before the
    // range, and it was back at 00:40. The stop's own heartbeat is before the
    // range too, but the restart explains it: gray, not "stopped".
    expect(days[0].blocks[0].state).toBe("restarted");
    expect(days[0].blocks[0].restart?.stoppedAt).toEqual(
      at("2026-03-10T23:55")
    );
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
  });

  describe("on a day the clocks change", () => {
    // A watcher that checks in every minute across both of Los Angeles's clock
    // changes in 2026. Every block that holds time should hold one heartbeat a
    // minute of it, and the blocks a skipped hour leaves empty hold nothing.
    const zone = "America/Los_Angeles";
    const AFTER = new Date("2027-01-01T00:00:00Z");
    let dstWatcherId: string;

    async function insertMinutely(id: string, from: string, to: string) {
      const rows: (typeof watcherHeartbeats.$inferInsert)[] = [];
      for (
        let time = new Date(from).getTime();
        time < new Date(to).getTime();
        time += MIN
      ) {
        rows.push({
          watcherId: id,
          timestamp: new Date(time),
          status: "watching",
        });
      }
      await getTestDb().insert(watcherHeartbeats).values(rows);
    }

    beforeAll(async () => {
      // Its own instrument: one active watcher per instrument is enforced.
      await getTestDb().insert(instruments).values({
        id: "dst-test-instrument",
        displayName: "DST Test Instrument",
        status: "active",
      });
      const [watcher] = await getTestDb()
        .insert(watchers)
        .values({
          instrumentId: "dst-test-instrument",
          hostname: "DST-PC",
          status: "watching",
          createdAt: at("2026-03-01T00:00"),
        })
        .returning({ id: watchers.id });
      dstWatcherId = watcher.id;
      await insertMinutely(
        dstWatcherId,
        "2026-03-07T18:00:00Z",
        "2026-03-09T12:00:00Z"
      );
      await insertMinutely(
        dstWatcherId,
        "2026-10-31T12:00:00Z",
        "2026-11-02T12:00:00Z"
      );
    });

    function range(day: string) {
      return {
        deregisteredAt: null,
        endExclusive: startOfDay(addDays(day, 1), zone),
        fromDay: day,
        now: AFTER,
        start: startOfDay(day, zone),
        timeZone: zone,
        toDay: day,
      };
    }

    it("spring forward: the two skipped blocks are no data, and every other block is checked in", async () => {
      const { days } = await getWatcherHealth(
        dstWatcherId,
        range("2026-03-08")
      );
      const { blocks } = days[0];
      expect(blocks).toHaveLength(BLOCKS_PER_DAY);
      // 2:00 and 2:30 AM never happened.
      for (const slot of [4, 5]) {
        expect(blocks[slot]).toMatchObject({
          state: "no_data",
          noData: "skipped",
          heartbeats: 0,
          minutes: 0,
        });
      }
      blocks.forEach((block, slot) => {
        if (slot !== 4 && slot !== 5) {
          expect(block.state, `block ${slot}`).toBe("checked_in");
          expect(block.heartbeats, `block ${slot}`).toBe(30);
        }
      });
    });

    it("spring forward: the day holds the 23 hours that happened", async () => {
      const { days } = await getWatcherHealth(
        dstWatcherId,
        range("2026-03-08")
      );
      const heartbeats = days[0].blocks.reduce(
        (sum, block) => sum + block.heartbeats,
        0
      );
      expect(heartbeats).toBe(23 * 60);
    });

    it("fall back: each block of an hour holds its own heartbeats, and the repeated hour joins 1:30 AM", async () => {
      const { days } = await getWatcherHealth(
        dstWatcherId,
        range("2026-11-01")
      );
      const { blocks } = days[0];
      expect(blocks).toHaveLength(BLOCKS_PER_DAY);
      expect(blocks.map((block) => block.state)).toEqual(
        new Array(BLOCKS_PER_DAY).fill("checked_in")
      );
      // 1:30 AM runs from 1:30 PDT to 2:00 PST: an hour and a half.
      expect(blocks[3].heartbeats).toBe(90);
      expect(blocks[3].minutes).toBe(90);
      expect(blocks[2].minutes).toBe(30);
      for (const [slot, block] of blocks.entries()) {
        if (slot !== 3) {
          expect(block.heartbeats, `block ${slot}`).toBe(30);
        }
      }
      expect(blocks.reduce((sum, block) => sum + block.heartbeats, 0)).toBe(
        25 * 60
      );
    });
  });

  describe("an outage that is still going on", () => {
    // Heartbeats every minute from 10:00 to 13:33 on the 10th, then nothing.
    const day = "2026-03-10";
    const lastHeartbeat = at("2026-03-10T13:33");
    let ongoingId: string;
    let stoppedId: string;

    async function watcherWithHeartbeats(
      instrumentId: string,
      lastStatus: string
    ): Promise<string> {
      const db = getTestDb();
      await db.insert(instruments).values({
        id: instrumentId,
        displayName: instrumentId,
        status: "active",
      });
      const [watcher] = await db
        .insert(watchers)
        .values({
          instrumentId,
          hostname: "ONGOING-PC",
          status: "watching",
          createdAt: at("2026-03-09T00:00"),
        })
        .returning({ id: watchers.id });
      const rows: (typeof watcherHeartbeats.$inferInsert)[] = [];
      for (
        let time = at("2026-03-10T10:00").getTime();
        time <= lastHeartbeat.getTime();
        time += MIN
      ) {
        rows.push({
          watcherId: watcher.id,
          timestamp: new Date(time),
          status: time === lastHeartbeat.getTime() ? lastStatus : "watching",
        });
      }
      await db.insert(watcherHeartbeats).values(rows);
      return watcher.id;
    }

    beforeAll(async () => {
      ongoingId = await watcherWithHeartbeats(
        "ongoing-outage-instrument",
        "watching"
      );
      stoppedId = await watcherWithHeartbeats(
        "ongoing-stopped-instrument",
        "stopped"
      );
    });

    const range = (now: string, deregisteredAt: Date | null = null) => ({
      deregisteredAt,
      endExclusive: at("2026-03-11T00:00"),
      fromDay: day,
      now: at(now),
      start: at("2026-03-10T00:00"),
      timeZone: "UTC",
      toDay: day,
    });

    it("turns the block that holds the last heartbeat red, as the badge reads Unresponsive", async () => {
      const { days } = await getWatcherHealth(
        ongoingId,
        range("2026-03-10T13:40")
      );
      const { blocks } = days[0];
      // 13:30 to 14:00 holds four heartbeats and seven quiet minutes, the last
      // two of them past the five the badge allows.
      expect(blocks[27]).toMatchObject({
        state: "unresponsive",
        heartbeats: 4,
      });
      expect(blocks[26].state).toBe("checked_in");
      expect(blocks[28]).toMatchObject({ state: "no_data", noData: "future" });
    });

    it("keeps the block green until the badge would read Unresponsive, and the minute after", async () => {
      for (const now of ["2026-03-10T13:36", "2026-03-10T13:38"]) {
        const { days } = await getWatcherHealth(ongoingId, range(now));
        expect(days[0].blocks[27].state, now).toBe("checked_in");
      }
    });

    it("stays green for a watcher someone stopped", async () => {
      const { days } = await getWatcherHealth(
        stoppedId,
        range("2026-03-10T13:40")
      );
      expect(days[0].blocks[27].state).toBe("checked_in");
    });

    it("stops counting the silence at the deregistration", async () => {
      const { days } = await getWatcherHealth(
        ongoingId,
        range("2026-03-10T13:40", at("2026-03-10T13:35"))
      );
      expect(days[0].blocks[27].state).toBe("checked_in");
    });

    it("stops counting at the end of a range that is over", async () => {
      // Long after, but the range ends at 13:35: the series closes there, two
      // minutes after the last heartbeat, which is still green.
      const { days } = await getWatcherHealth(ongoingId, {
        ...range("2026-03-10T18:00"),
        endExclusive: at("2026-03-10T13:35"),
      });
      expect(days[0].blocks[27].state).toBe("checked_in");
    });
  });

  describe("a watcher left down after a restart from before the range", () => {
    // Its last heartbeat, a minute before the stop on the 1st, said `stopped`.
    // The range is a week later.
    const range = {
      deregisteredAt: null,
      endExclusive: at("2026-03-09T00:00"),
      fromDay: "2026-03-08",
      now: at("2026-03-09T12:00"),
      start: at("2026-03-08T00:00"),
      timeZone: "UTC",
      toDay: "2026-03-08",
    };

    async function downSince(
      instrumentId: string,
      stop: {
        details?: Record<string, unknown>;
        message: string;
        before?: Record<string, unknown>;
      }
    ): Promise<string> {
      const db = getTestDb();
      await db.insert(instruments).values({
        id: instrumentId,
        displayName: instrumentId,
        status: "active",
      });
      const [watcher] = await db
        .insert(watchers)
        .values({
          instrumentId,
          hostname: "DOWN-PC",
          status: "stopped",
          createdAt: at("2026-02-28T00:00"),
        })
        .returning({ id: watchers.id });
      await db.insert(watcherHeartbeats).values([
        {
          watcherId: watcher.id,
          timestamp: at("2026-03-01T09:59"),
          status: "watching",
        },
        {
          watcherId: watcher.id,
          timestamp: at("2026-03-01T10:00"),
          status: "stopped",
        },
      ]);
      if (stop.before) {
        await db.insert(watcherEvents).values({
          watcherId: watcher.id,
          eventType: "update_started",
          message: "Dispatching upgrade via worker",
          details: stop.before,
          timestamp: at("2026-03-01T09:58"),
        });
      }
      await db.insert(watcherEvents).values({
        watcherId: watcher.id,
        eventType: "watcher_stopped",
        message: stop.message,
        details: stop.details ?? null,
        timestamp: at("2026-03-01T10:00"),
      });
      return watcher.id;
    }

    it("is unresponsive after an update's stop, as the badge reads", async () => {
      const id = await downSince("down-after-update", {
        message: "Service stopped",
        details: { stop_reason: "auto_update" },
      });
      const { days } = await getWatcherHealth(id, range);
      for (const block of days[0].blocks) {
        expect(block, `${block.state} ${block.noData}`).toMatchObject({
          state: "unresponsive",
        });
      }
    });

    it("is unresponsive after a stop that followed an update handed to the worker", async () => {
      const id = await downSince("down-after-worker", {
        message: "Service stopped",
        before: { via_worker: true },
      });
      const { days } = await getWatcherHealth(id, range);
      expect(days[0].blocks.map((block) => block.state)).toEqual(
        new Array(BLOCKS_PER_DAY).fill("unresponsive")
      );
    });

    it("is still no data when someone stopped it", async () => {
      const id = await downSince("down-by-someone", {
        message: "Service stopped",
      });
      const { days } = await getWatcherHealth(id, range);
      for (const block of days[0].blocks) {
        expect(block).toMatchObject({ state: "no_data", noData: "stopped" });
      }
    });
  });
});
