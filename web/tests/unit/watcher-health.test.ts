import { describe, expect, it } from "vitest";
import { UPLOAD_REQUEST_REVERT_GRACE_MS } from "@/lib/api/watcher-status";
import {
  type BlockFacts,
  blockTimeLabel,
  classifyBlock,
  failuresNote,
  filesNote,
  type HealthTotals,
  type HeartbeatGap,
  missedNote,
  missedWindow,
  RESTART_GRACE_MS,
  restartsNote,
  restartWindow,
  SILENCE_TOLERANCE_MS,
  seriesEnd,
  silenceInBlock,
  stopIsRestart,
  unexplainedSilences,
  windowTouchesBlock,
} from "@/lib/watchers/health";
import {
  canStampStop,
  restartReasonOf,
  stampNewStopEvents,
} from "@/lib/watchers/stop-reasons";

const at = (hhmm: string, day = "2026-11-10") => new Date(`${day}T${hhmm}:00Z`);

// 10:00 to 10:30 on the 10th, three days after the watcher's first check-in and
// well before "now".
const BASE: BlockFacts = {
  start: at("10:00"),
  end: at("10:30"),
  now: at("12:00", "2026-11-13"),
  heartbeats: 30,
  firstHeartbeatAt: at("00:00", "2026-11-07"),
  deregisteredAt: null,
  restarted: false,
  missed: false,
  stoppedBefore: false,
};

describe("classifyBlock", () => {
  it("green: the watcher sent a heartbeat", () => {
    expect(classifyBlock(BASE)).toEqual({ state: "checked_in" });
  });

  it("gray: the watcher stopped for an update or a Windows restart", () => {
    expect(classifyBlock({ ...BASE, restarted: true })).toEqual({
      state: "restarted",
    });
  });

  it("gray beats green: a restart block that holds heartbeats is still a restart", () => {
    expect(
      classifyBlock({ ...BASE, restarted: true, heartbeats: 28 }).state
    ).toBe("restarted");
  });

  it("amber: a gap that recovered", () => {
    expect(classifyBlock({ ...BASE, missed: true })).toEqual({
      state: "missed",
    });
    expect(classifyBlock({ ...BASE, missed: true, heartbeats: 0 }).state).toBe(
      "missed"
    );
  });

  it("a restart beats a missed heartbeat", () => {
    expect(
      classifyBlock({ ...BASE, restarted: true, missed: true, heartbeats: 0 })
        .state
    ).toBe("restarted");
  });

  it("red: it should have checked in and didn't", () => {
    expect(classifyBlock({ ...BASE, heartbeats: 0 })).toEqual({
      state: "unresponsive",
    });
  });

  it("light gray: it hasn't happened yet", () => {
    expect(
      classifyBlock({
        ...BASE,
        now: at("10:10"),
        start: at("10:30"),
        end: at("11:00"),
        heartbeats: 0,
      })
    ).toEqual({ state: "no_data", noData: "future" });
  });

  it("light gray: the watcher hadn't checked in yet", () => {
    expect(
      classifyBlock({
        ...BASE,
        heartbeats: 0,
        firstHeartbeatAt: at("14:00"),
      })
    ).toEqual({ state: "no_data", noData: "before_first_check_in" });
  });

  it("light gray for a watcher that never checked in", () => {
    expect(
      classifyBlock({ ...BASE, heartbeats: 0, firstHeartbeatAt: null })
    ).toEqual({ state: "no_data", noData: "before_first_check_in" });
  });

  it("light gray: after the watcher was deregistered", () => {
    expect(
      classifyBlock({ ...BASE, heartbeats: 0, deregisteredAt: at("09:00") })
    ).toEqual({ state: "no_data", noData: "after_deregistered" });
  });

  it("the block a deregistration falls in still counts", () => {
    expect(classifyBlock({ ...BASE, deregisteredAt: at("10:15") }).state).toBe(
      "checked_in"
    );
  });

  it("light gray: a stopped watcher says nothing, which isn't a fault", () => {
    expect(
      classifyBlock({ ...BASE, heartbeats: 0, stoppedBefore: true })
    ).toEqual({ state: "no_data", noData: "stopped" });
  });

  it("red: a block with heartbeats that went quiet for a while nothing explains", () => {
    expect(classifyBlock({ ...BASE, heartbeats: 1, silent: true })).toEqual({
      state: "unresponsive",
    });
  });

  it("a restart or a missed heartbeat still beats a quiet block", () => {
    expect(
      classifyBlock({ ...BASE, heartbeats: 1, silent: true, restarted: true })
        .state
    ).toBe("restarted");
    expect(
      classifyBlock({ ...BASE, heartbeats: 1, silent: true, missed: true })
        .state
    ).toBe("missed");
  });

  it("a heartbeat in the block is a check-in, even after a stop", () => {
    expect(
      classifyBlock({ ...BASE, heartbeats: 1, stoppedBefore: true }).state
    ).toBe("checked_in");
  });

  it("is too soon to call a block that is still going, quiet for under 5 minutes", () => {
    expect(classifyBlock({ ...BASE, heartbeats: 0, now: at("10:04") })).toEqual(
      { state: "no_data", noData: "too_soon" }
    );
  });

  it("calls a block that is still going unresponsive once it has been quiet for 5 minutes", () => {
    expect(
      classifyBlock({ ...BASE, heartbeats: 0, now: at("10:05") }).state
    ).toBe("unresponsive");
  });

  it("is too soon in the block a watcher's first check-in falls in, when it is quiet for under 5 minutes", () => {
    expect(
      classifyBlock({
        ...BASE,
        heartbeats: 0,
        firstHeartbeatAt: at("10:27"),
      })
    ).toEqual({ state: "no_data", noData: "too_soon" });
  });

  it("is too soon in the block a deregistration falls in, when it was quiet for under 5 minutes", () => {
    expect(
      classifyBlock({ ...BASE, heartbeats: 0, deregisteredAt: at("10:03") })
    ).toEqual({ state: "no_data", noData: "too_soon" });
  });

  it("a block a clock change skipped is no data, and says so", () => {
    expect(
      classifyBlock({
        ...BASE,
        start: at("10:30"),
        end: at("10:00"),
        heartbeats: 0,
      })
    ).toEqual({ state: "no_data", noData: "skipped" });
  });
});

describe("restartWindow and missedWindow", () => {
  it("a restart runs from the stop to the next start", () => {
    const window = restartWindow(at("09:58"), "update", at("10:02"));
    expect(window.from).toEqual(at("09:58"));
    expect(window.to).toEqual(at("10:02"));
    expect(window.resumedAt).toEqual(at("10:02"));
  });

  it("a watcher that never came back is expected back within the grace period", () => {
    const window = restartWindow(at("09:58"), "windows", null);
    expect(window.to.getTime() - window.from.getTime()).toBe(RESTART_GRACE_MS);
  });

  it("a restart that took longer than the grace period ends with it", () => {
    const window = restartWindow(at("09:58"), "update", at("13:00"));
    expect(window.to.getTime() - window.from.getTime()).toBe(RESTART_GRACE_MS);
    expect(window.resumedAt).toEqual(at("13:00"));
  });

  it("a missed heartbeat runs from the first failure to the recovery", () => {
    const window = missedWindow(at("10:04"), 240);
    expect(window.from).toEqual(at("10:00"));
    expect(window.to).toEqual(at("10:04"));
    expect(window.gapSeconds).toBe(240);
  });
});

describe("windowTouchesBlock", () => {
  const block = (heartbeats: number) => ({
    start: at("10:00"),
    end: at("10:30"),
    heartbeats,
  });

  it("the block that holds the window's start always belongs to it", () => {
    expect(
      windowTouchesBlock({ from: at("10:28"), to: at("10:33") }, block(30))
    ).toBe(true);
  });

  it("the next block, with heartbeats, does not: a short restart colours one block", () => {
    const next = { start: at("10:30"), end: at("11:00"), heartbeats: 29 };
    expect(
      windowTouchesBlock({ from: at("10:28"), to: at("10:33") }, next)
    ).toBe(false);
  });

  it("the next block does when it heard nothing", () => {
    const next = { start: at("10:30"), end: at("11:00"), heartbeats: 0 };
    expect(
      windowTouchesBlock({ from: at("10:28"), to: at("10:33") }, next)
    ).toBe(true);
  });

  it("a long window colours every quiet block it covers", () => {
    const window = { from: at("09:50"), to: at("11:20") };
    const blocks = [
      { start: at("09:30"), end: at("10:00"), heartbeats: 20 },
      { start: at("10:00"), end: at("10:30"), heartbeats: 0 },
      { start: at("10:30"), end: at("11:00"), heartbeats: 0 },
      { start: at("11:00"), end: at("11:30"), heartbeats: 6 },
    ];
    expect(blocks.map((b) => windowTouchesBlock(window, b))).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it("a window before the block does not touch it", () => {
    expect(
      windowTouchesBlock({ from: at("08:00"), to: at("08:10") }, block(0))
    ).toBe(false);
  });

  it("a window that ends where the block starts does not touch it", () => {
    expect(
      windowTouchesBlock({ from: at("09:50"), to: at("10:00") }, block(0))
    ).toBe(false);
  });
});

describe("blockTimeLabel", () => {
  it("writes a block's start as a wall-clock time", () => {
    expect(blockTimeLabel(0)).toBe("12:00 AM");
    expect(blockTimeLabel(1)).toBe("12:30 AM");
    expect(blockTimeLabel(19)).toBe("9:30 AM");
    expect(blockTimeLabel(24)).toBe("12:00 PM");
    expect(blockTimeLabel(47)).toBe("11:30 PM");
    expect(blockTimeLabel(48)).toBe("12:00 AM");
  });
});

describe("count card sentences", () => {
  const words = {
    range: { fromDay: "2026-11-07", toDay: "2026-11-13", dayCount: 7 },
    timeZone: "UTC",
    now: new Date("2026-11-13T22:00:00Z"),
  };
  const totals = (patch: Partial<HealthTotals> = {}): HealthTotals => ({
    files: 0,
    runs: 0,
    uploadFailures: 0,
    restarts: { update: 0, windows: 0 },
    missedHeartbeats: 0,
    longestMissedSeconds: 0,
    daysWithFiles: [],
    ...patch,
  });

  describe("Files uploaded", () => {
    it("says none when there are none", () => {
      expect(filesNote(totals(), words)).toBe("None in the last 7 days");
    });

    it("counts the runs and names two days of one month", () => {
      expect(
        filesNote(
          totals({
            files: 7,
            runs: 7,
            daysWithFiles: ["2026-11-10", "2026-11-11"],
          }),
          words
        )
      ).toBe("From 7 runs on Nov 10 and 11");
    });

    it("names one day, and a single run", () => {
      expect(
        filesNote(
          totals({ files: 3, runs: 1, daysWithFiles: ["2026-11-10"] }),
          words
        )
      ).toBe("From 1 run on Nov 10");
    });

    it("names two days of different months in full", () => {
      expect(
        filesNote(
          totals({
            files: 2,
            runs: 2,
            daysWithFiles: ["2026-10-31", "2026-11-01"],
          }),
          words
        )
      ).toBe("From 2 runs on Oct 31 and Nov 1");
    });

    it("counts the days when there are more than two", () => {
      expect(
        filesNote(
          totals({
            files: 9,
            runs: 5,
            daysWithFiles: [
              "2026-11-08",
              "2026-11-09",
              "2026-11-12",
              "2026-11-13",
            ],
          }),
          words
        )
      ).toBe("From 5 runs over 4 days");
    });

    it("says over, not on, for a count of days with no runs", () => {
      expect(
        filesNote(
          totals({
            files: 9,
            runs: 0,
            daysWithFiles: ["2026-11-08", "2026-11-09", "2026-11-12"],
          }),
          words
        )
      ).toBe("Over 3 days");
    });

    it("leaves the runs out when none can be read from the events", () => {
      expect(
        filesNote(
          totals({ files: 2, runs: 0, daysWithFiles: ["2026-11-10"] }),
          words
        )
      ).toBe("On Nov 10");
    });

    it("follows the range", () => {
      expect(
        filesNote(totals(), {
          ...words,
          range: { fromDay: "2026-11-10", toDay: "2026-11-10", dayCount: 1 },
        })
      ).toBe("None on Nov 10");
    });
  });

  describe("Upload failures", () => {
    it("says none when there are none", () => {
      expect(failuresNote(0, words)).toBe("None in the last 7 days");
    });

    it("has nothing to add when there are some: the card links to them", () => {
      expect(failuresNote(2, words)).toBeNull();
    });
  });

  describe("Restarts", () => {
    it("says none when there are none", () => {
      expect(restartsNote({ update: 0, windows: 0 }, words)).toBe(
        "None in the last 7 days"
      );
    });

    it("all for automatic updates", () => {
      expect(restartsNote({ update: 3, windows: 0 }, words)).toBe(
        "All for automatic updates"
      );
    });

    it("one for an automatic update", () => {
      expect(restartsNote({ update: 1, windows: 0 }, words)).toBe(
        "For an automatic update"
      );
    });

    it("all for Windows restarts", () => {
      expect(restartsNote({ update: 0, windows: 2 }, words)).toBe(
        "All for Windows restarts"
      );
      expect(restartsNote({ update: 0, windows: 1 }, words)).toBe(
        "For a Windows restart"
      );
    });

    it("splits a mix by reason", () => {
      expect(restartsNote({ update: 2, windows: 1 }, words)).toBe(
        "2 for automatic updates, 1 for a Windows restart"
      );
    });
  });

  describe("Missed heartbeats", () => {
    it("says none when there are none", () => {
      expect(missedNote(totals(), words)).toBe("None in the last 7 days");
    });

    it("each recovered within a minute", () => {
      expect(
        missedNote(
          totals({ missedHeartbeats: 2, longestMissedSeconds: 45 }),
          words
        )
      ).toBe("Each recovered within a minute");
    });

    it("one recovered", () => {
      expect(
        missedNote(
          totals({ missedHeartbeats: 1, longestMissedSeconds: 240 }),
          words
        )
      ).toBe("Recovered within 4 minutes");
    });

    it("names the longest gap", () => {
      expect(
        missedNote(
          totals({ missedHeartbeats: 3, longestMissedSeconds: 7200 }),
          words
        )
      ).toBe("Each recovered within 2 hours");
      expect(
        missedNote(
          totals({ missedHeartbeats: 2, longestMissedSeconds: 3600 }),
          words
        )
      ).toBe("Each recovered within an hour");
    });
  });
});

describe("restartReasonOf", () => {
  const stopped = (
    message: string,
    details: unknown = null,
    afterUpdateStart = false
  ) => ({
    eventType: "watcher_stopped",
    message,
    details,
    afterUpdateStart,
  });

  describe("from the reason the server copied from the final heartbeat", () => {
    it("reads an update stop whose own message says only that the service stopped", () => {
      // The uv-tool install on Windows: the upgrade worker stops the service
      // from outside, so the watcher can't write the reason into its message.
      expect(
        restartReasonOf(
          stopped("Service stopped", { stop_reason: "auto_update" })
        )
      ).toBe("update");
    });

    it("reads a Windows shutdown", () => {
      expect(
        restartReasonOf(
          stopped("Service stopped", { stop_reason: "system_shutdown" })
        )
      ).toBe("windows");
    });

    it("wins over a message that says something else", () => {
      expect(
        restartReasonOf(
          stopped("Service stopped: Windows is shutting down", {
            stop_reason: "auto_update",
          })
        )
      ).toBe("update");
    });

    it("ignores a reason it doesn't know", () => {
      expect(
        restartReasonOf(stopped("Service stopped", { stop_reason: "other" }))
      ).toBeNull();
    });

    it("ignores one on the server's own note about cancelled uploads", () => {
      expect(
        restartReasonOf(
          stopped("Cancelled uploads", {
            kind: "upload_requests_cancelled",
            stop_reason: "auto_update",
          })
        )
      ).toBeNull();
    });
  });

  describe("from an update the watcher handed to the upgrade worker", () => {
    it("reads a plain stop that follows one", () => {
      expect(restartReasonOf(stopped("Service stopped", null, true))).toBe(
        "update"
      );
    });

    it("is not a restart with no update before it", () => {
      expect(restartReasonOf(stopped("Service stopped"))).toBeNull();
    });

    it("leaves a stop that names another cause alone", () => {
      expect(
        restartReasonOf(stopped("Watcher stopped by user", null, true))
      ).toBeNull();
      expect(
        restartReasonOf(
          stopped(
            "Service stopped: its registration was deleted on Data Hub",
            null,
            true
          )
        )
      ).toBeNull();
      expect(
        restartReasonOf(
          stopped("Service stopped: Windows is shutting down", null, true)
        )
      ).toBe("windows");
    });
  });

  describe("from the message, for events with neither", () => {
    it("reads an update restart", () => {
      expect(
        restartReasonOf(stopped("Service restarting for auto-update"))
      ).toBe("update");
      expect(
        restartReasonOf(stopped("Watcher restarting for auto-update"))
      ).toBe("update");
    });

    it("reads a Windows shutdown or restart", () => {
      expect(
        restartReasonOf(stopped("Service stopped: Windows is shutting down"))
      ).toBe("windows");
    });
  });

  it("is null for every other stop", () => {
    expect(restartReasonOf(stopped("Watcher stopped by user"))).toBeNull();
    expect(
      restartReasonOf(
        stopped("Service stopped: its registration was deleted on Data Hub")
      )
    ).toBeNull();
  });

  it("is null for the server's own note about cancelled uploads", () => {
    expect(
      restartReasonOf(
        stopped(
          "Restarting for auto-update: reverted 1 pending upload request(s)",
          { kind: "upload_requests_cancelled" },
          true
        )
      )
    ).toBeNull();
  });

  it("is null for any other type of event", () => {
    expect(
      restartReasonOf({
        eventType: "watcher_started",
        message: "Service restarting for auto-update",
        details: { stop_reason: "auto_update" },
        afterUpdateStart: true,
      })
    ).toBeNull();
  });
});

describe("stampNewStopEvents", () => {
  const NOW = at("12:00");
  const heartbeatAt = at("11:59");
  const stop = (time: string, details: unknown = null) => ({
    eventType: "watcher_stopped",
    message: "Service stopped",
    details,
    timestamp: at(time),
  });
  const restartingWatcher = {
    status: "stopped",
    statusReason: "auto_update",
    lastHeartbeatAt: heartbeatAt,
  };

  it("copies the reason of a final heartbeat that arrived first onto the stop", () => {
    const [event] = stampNewStopEvents([stop("11:59")], restartingWatcher, NOW);
    expect(event.details).toEqual({ stop_reason: "auto_update" });
    expect(restartReasonOf(event)).toBe("update");
  });

  it("keeps the event's other details", () => {
    const [event] = stampNewStopEvents(
      [stop("11:59", { note: "x" })],
      { ...restartingWatcher, statusReason: "system_shutdown" },
      NOW
    );
    expect(event.details).toEqual({
      note: "x",
      stop_reason: "system_shutdown",
    });
  });

  it("never replaces a reason that is already there", () => {
    const events = [stop("11:59", { stop_reason: "system_shutdown" })];
    expect(stampNewStopEvents(events, restartingWatcher, NOW)).toEqual(events);
  });

  it("stamps only the last stop of a batch", () => {
    const stamped = stampNewStopEvents(
      [stop("11:57"), stop("11:59"), stop("11:58")],
      restartingWatcher,
      NOW
    );
    expect(stamped.map((event) => event.details)).toEqual([
      null,
      { stop_reason: "auto_update" },
      null,
    ]);
  });

  it("leaves a stop that is not near the heartbeat", () => {
    const events = [stop("10:00")];
    expect(stampNewStopEvents(events, restartingWatcher, NOW)).toEqual(events);
  });

  it("leaves everything when the watcher isn't stopped for a restart, or went quiet long ago", () => {
    const events = [stop("11:59")];
    for (const watcher of [
      { ...restartingWatcher, status: "watching" },
      { ...restartingWatcher, statusReason: null },
      { ...restartingWatcher, statusReason: "other" },
      { ...restartingWatcher, lastHeartbeatAt: null },
      { ...restartingWatcher, lastHeartbeatAt: at("09:00") },
    ]) {
      expect(stampNewStopEvents(events, watcher, NOW)).toEqual(events);
    }
  });

  it("leaves other events and the server's own notes alone", () => {
    const events = [
      { ...stop("11:59"), eventType: "watcher_started" },
      stop("11:59", { kind: "upload_requests_cancelled" }),
      stop("11:59", ["not", "an", "object"]),
    ];
    expect(stampNewStopEvents(events, restartingWatcher, NOW)).toEqual(events);
  });

  it("leaves a stop whose message names another cause", () => {
    for (const message of [
      "Stopped by user (Ctrl+C)",
      "Service stopped: registration was deleted",
      "Environment switched",
      "Service stopped: Windows is shutting down",
    ]) {
      const events = [{ ...stop("11:59"), message }];
      expect(stampNewStopEvents(events, restartingWatcher, NOW)).toEqual(
        events
      );
    }
  });

  it("leaves a stop that the watcher started again after, before the heartbeat", () => {
    // Stopped at 11:56 (someone's stop), started at 11:57, and this heartbeat
    // at 11:59 belongs to the new session.
    const events = [
      stop("11:56"),
      { ...stop("11:57"), eventType: "watcher_started" },
    ];
    expect(stampNewStopEvents(events, restartingWatcher, NOW)).toEqual(events);
    // A start before the stop doesn't matter.
    const [, , stamped] = stampNewStopEvents(
      [
        { ...stop("11:55"), eventType: "watcher_started" },
        stop("11:56"),
        stop("11:58"),
      ],
      restartingWatcher,
      NOW
    );
    expect(stamped.details).toEqual({ stop_reason: "auto_update" });
  });

  it("knows which stops it may stamp", () => {
    expect(canStampStop(stop("11:59"))).toBe(true);
    expect(canStampStop({ ...stop("11:59"), message: "Stopped by user" })).toBe(
      false
    );
    expect(canStampStop(stop("11:59", { stop_reason: "auto_update" }))).toBe(
      false
    );
  });
});

describe("unexplainedSilences", () => {
  const gap = (
    from: string,
    to: string,
    previousStatus = "watching"
  ): HeartbeatGap => ({
    from: at(from),
    to: at(to),
    previousStatus,
  });
  const silences = (
    gaps: HeartbeatGap[],
    restarts: ReturnType<typeof restartWindow>[] = [],
    missed: ReturnType<typeof missedWindow>[] = []
  ) =>
    unexplainedSilences(gaps, restarts, missed, 2 * 60 * 1000).map(
      (silence) => [
        silence.from.toISOString().slice(11, 16),
        silence.to.toISOString().slice(11, 16),
      ]
    );

  it("reads the quiet from the stale threshold after the last heartbeat to the next", () => {
    // 10:20 to 10:45 with no stop: unresponsive from 10:25.
    expect(silences([gap("10:20", "10:45")])).toEqual([["10:25", "10:45"]]);
  });

  it("is nothing for heartbeats exactly the threshold apart", () => {
    expect(silences([gap("10:00", "10:05")])).toEqual([]);
  });

  it("is nothing when someone stopped the watcher", () => {
    expect(silences([gap("20:00", "22:00", "stopped")])).toEqual([]);
  });

  it("is nothing inside a restart, but what follows the grace period is quiet", () => {
    // The window runs 14:00 to 14:15, and the watcher is back at 14:40.
    expect(
      silences(
        [gap("14:00", "14:40", "stopped")],
        [restartWindow(at("14:00"), "update", null)]
      )
    ).toEqual([["14:15", "14:40"]]);
    expect(
      silences(
        [gap("14:00", "14:10", "stopped")],
        [restartWindow(at("14:00"), "update", at("14:10"))]
      )
    ).toEqual([]);
  });

  it("is nothing where the watcher reported the gap itself", () => {
    // The watcher says it was out of contact for 55 minutes, until 11:00.
    expect(
      silences([gap("10:05", "11:00")], [], [missedWindow(at("11:00"), 3300)])
    ).toEqual([]);
  });

  it("keeps the part of a gap that a missed heartbeat doesn't cover", () => {
    // Out of contact for 10 minutes before 11:00, but silent from 10:05.
    expect(
      silences([gap("10:05", "11:00")], [], [missedWindow(at("11:00"), 600)])
    ).toEqual([["10:10", "10:49"]]);
  });

  it("drops a stretch shorter than the tolerance", () => {
    expect(SILENCE_TOLERANCE_MS).toBe(60 * 1000);
    expect(
      unexplainedSilences(
        [
          {
            from: at("10:00"),
            to: new Date(at("10:05").getTime() + 30_000),
            previousStatus: "watching",
          },
        ],
        [],
        [],
        2 * 60 * 1000
      )
    ).toEqual([]);
  });

  it("reads an outage that is still going on, from the last heartbeat to where the series closes", () => {
    // The last heartbeat was at 13:33 and it is 13:40: quiet from 13:38.
    const now = at("13:40");
    const closing = gap("13:33", "13:40");
    expect(closing.to).toEqual(seriesEnd(now, at("14:00", "2026-11-10"), null));
    expect(silences([closing])).toEqual([["13:38", "13:40"]]);
    // Under the five minutes the badge needs, or the minute of tolerance, it
    // is only a heartbeat that hasn't come yet.
    expect(silences([gap("13:33", "13:37")])).toEqual([]);
    expect(
      unexplainedSilences(
        [
          {
            from: at("13:33"),
            to: new Date(at("13:38").getTime() + 30_000),
            previousStatus: "watching",
          },
        ],
        [],
        [],
        2 * 60 * 1000
      )
    ).toEqual([]);
  });

  it("an outage that is still going on, after a stop that a restart explains, is quiet once the grace period ends", () => {
    expect(
      silences(
        [gap("14:00", "14:40", "stopped")],
        [restartWindow(at("14:00"), "update", null)]
      )
    ).toEqual([["14:15", "14:40"]]);
    // Where someone stopped it, there is nothing to say.
    expect(silences([gap("14:00", "14:40", "stopped")])).toEqual([]);
  });

  it("knows whether a stop is the one a restart records", () => {
    const restarts = [restartWindow(at("14:00"), "update", null)];
    expect(stopIsRestart(restarts, at("14:01"), 2 * 60 * 1000)).toBe(true);
    expect(stopIsRestart(restarts, at("14:30"), 2 * 60 * 1000)).toBe(false);
  });
});

describe("seriesEnd", () => {
  const now = at("13:40");

  it("is now for a watcher that is still going, in a range that has not ended", () => {
    expect(seriesEnd(now, at("00:00", "2026-11-11"), null)).toEqual(now);
  });

  it("is the end of a range that is over", () => {
    expect(seriesEnd(now, at("12:00"), null)).toEqual(at("12:00"));
  });

  it("is the deregistration, when it came first", () => {
    expect(seriesEnd(now, at("00:00", "2026-11-11"), at("11:00"))).toEqual(
      at("11:00")
    );
    expect(seriesEnd(now, at("00:00", "2026-11-11"), at("13:50"))).toEqual(now);
  });
});

describe("silenceInBlock", () => {
  const silence = [{ from: at("10:25"), to: at("10:45") }];

  it("is true for every block the silence reaches by a minute or more", () => {
    expect(
      silenceInBlock(silence, { start: at("10:00"), end: at("10:30") })
    ).toBe(true);
    expect(
      silenceInBlock(silence, { start: at("10:30"), end: at("11:00") })
    ).toBe(true);
  });

  it("is false for blocks it doesn't reach, or reaches for seconds", () => {
    expect(
      silenceInBlock(silence, { start: at("09:30"), end: at("10:00") })
    ).toBe(false);
    expect(
      silenceInBlock(silence, { start: at("10:45"), end: at("11:15") })
    ).toBe(false);
    expect(
      silenceInBlock(
        [{ from: at("10:25"), to: new Date(at("10:30").getTime() + 20_000) }],
        { start: at("10:30"), end: at("11:00") }
      )
    ).toBe(false);
  });
});

describe("RESTART_GRACE_MS", () => {
  it("is the wait after which the badge reads Unresponsive", () => {
    expect(RESTART_GRACE_MS).toBe(UPLOAD_REQUEST_REVERT_GRACE_MS);
  });
});
