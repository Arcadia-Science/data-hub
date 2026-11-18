import { describe, expect, it } from "vitest";
import {
  CONNECTION_REASONS,
  type ConnectionReason,
  type InstrumentBadgeState,
} from "@/lib/instruments/connection";
import {
  backOnlineMessage,
  CRON_JITTER_MS,
  instrumentConnectionHeading,
  isOfflineAlertPaused,
  OFFLINE_ALERT_AFTER_MS,
  type OfflineAlertState,
  offlineAlertMessage,
  stepOfflineAlert,
} from "@/lib/instruments/offline-alerts";

// The offline-alert job's state per instrument: Quiet (no row), Waiting (a row
// without `alertedAt`) and Alerted. Each test names the row of the table in
// `stepOfflineAlert` it checks.

const NOW = new Date("2026-11-17T15:00:00.000Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const ago = (ms: number) => new Date(NOW.getTime() - ms);

const OFFLINE_BADGES = CONNECTION_REASONS.map((reason) => ({
  badge: "offline" as const,
  reason,
}));
const NOT_OFFLINE: InstrumentBadgeState[] = [
  "online",
  "restarting",
  "connecting",
  "pending",
  "retired",
];

const waiting = (sinceMs: number): OfflineAlertState => ({
  offlineSince: ago(sinceMs),
  alertedAt: null,
});
const alerted = (sinceMs: number): OfflineAlertState => ({
  offlineSince: ago(sinceMs),
  alertedAt: ago(sinceMs - OFFLINE_ALERT_AFTER_MS),
});

describe("stepOfflineAlert from Quiet", () => {
  it.each(
    OFFLINE_BADGES
  )("starts the clock when the badge is Offline ($reason)", (observation) => {
    expect(stepOfflineAlert(null, observation, NOW, false)).toBe("start");
  });

  it.each(NOT_OFFLINE)("does nothing while the badge is %s", (badge) => {
    expect(stepOfflineAlert(null, { badge, reason: null }, NOW, false)).toBe(
      "none"
    );
  });

  it("holds back an unresponsive clock while paused", () => {
    expect(
      stepOfflineAlert(
        null,
        { badge: "offline", reason: "unresponsive" },
        NOW,
        true
      )
    ).toBe("none");
  });

  it.each(
    CONNECTION_REASONS.filter((reason) => reason !== "unresponsive")
  )("still starts a %s clock while paused", (reason) => {
    expect(
      stepOfflineAlert(null, { badge: "offline", reason }, NOW, true)
    ).toBe("start");
  });
});

describe("stepOfflineAlert from Waiting", () => {
  const offline = {
    badge: "offline" as const,
    reason: "folder_missing" as const,
  };

  it("waits while the badge has been Offline for less than 30 minutes", () => {
    expect(stepOfflineAlert(waiting(10 * MINUTE), offline, NOW, false)).toBe(
      "none"
    );
  });

  it("alerts at 30 minutes", () => {
    expect(
      stepOfflineAlert(waiting(OFFLINE_ALERT_AFTER_MS), offline, NOW, false)
    ).toBe("alert");
  });

  it("alerts a run that starts up to a minute early", () => {
    expect(
      stepOfflineAlert(
        waiting(OFFLINE_ALERT_AFTER_MS - CRON_JITTER_MS),
        offline,
        NOW,
        false
      )
    ).toBe("alert");
    expect(
      stepOfflineAlert(
        waiting(OFFLINE_ALERT_AFTER_MS - CRON_JITTER_MS - SECOND),
        offline,
        NOW,
        false
      )
    ).toBe("none");
  });

  it("alerts whichever reason the badge shows now", () => {
    expect(
      stepOfflineAlert(
        waiting(OFFLINE_ALERT_AFTER_MS),
        { badge: "offline", reason: "unresponsive" },
        NOW,
        false
      )
    ).toBe("alert");
  });

  it.each(
    NOT_OFFLINE
  )("clears the clock when the badge turns %s before the alert", (badge) => {
    expect(
      stepOfflineAlert(
        waiting(20 * MINUTE),
        { badge, reason: null },
        NOW,
        false
      )
    ).toBe("clear");
  });

  it("clears an unresponsive clock while paused, even one that's due", () => {
    expect(
      stepOfflineAlert(
        waiting(2 * HOUR),
        { badge: "offline", reason: "unresponsive" },
        NOW,
        true
      )
    ).toBe("clear");
  });

  it("keeps and alerts other reasons while paused", () => {
    expect(
      stepOfflineAlert(
        waiting(OFFLINE_ALERT_AFTER_MS),
        { badge: "offline", reason: "stopped" },
        NOW,
        true
      )
    ).toBe("alert");
  });
});

describe("stepOfflineAlert from Alerted", () => {
  it("sends back online when the badge is Online", () => {
    expect(
      stepOfflineAlert(
        alerted(HOUR),
        { badge: "online", reason: null },
        NOW,
        false
      )
    ).toBe("recover");
  });

  it.each([
    "pending",
    "retired",
  ] as const)("ends silently when the instrument is %s", (badge) => {
    expect(
      stepOfflineAlert(alerted(HOUR), { badge, reason: null }, NOW, false)
    ).toBe("clear");
  });

  it.each([
    "restarting",
    "connecting",
  ] as const)("keeps waiting for Online while the badge is %s", (badge) => {
    expect(
      stepOfflineAlert(alerted(HOUR), { badge, reason: null }, NOW, false)
    ).toBe("none");
  });

  it.each(
    OFFLINE_BADGES
  )("sends no second alert while Offline ($reason)", (observation) => {
    expect(stepOfflineAlert(alerted(HOUR), observation, NOW, false)).toBe(
      "none"
    );
    expect(stepOfflineAlert(alerted(HOUR), observation, NOW, true)).toBe(
      "none"
    );
  });
});

describe("isOfflineAlertPaused", () => {
  const silent = { status: "watching", lastHeartbeatAt: ago(6 * MINUTE) };
  const fresh = { status: "watching", lastHeartbeatAt: ago(MINUTE) };

  it("pauses when every watcher that should check in has gone quiet", () => {
    expect(
      isOfflineAlertPaused(
        [silent, { status: "waiting", lastHeartbeatAt: ago(10 * MINUTE) }],
        NOW
      )
    ).toBe(true);
  });

  it("doesn't pause while any of them still checks in", () => {
    expect(isOfflineAlertPaused([silent, silent, fresh], NOW)).toBe(false);
  });

  it("doesn't pause for one watcher, or none", () => {
    expect(isOfflineAlertPaused([silent], NOW)).toBe(false);
    expect(isOfflineAlertPaused([], NOW)).toBe(false);
  });

  it("ignores watchers that aren't expected to check in", () => {
    expect(
      isOfflineAlertPaused(
        [
          silent,
          { status: "stopped", lastHeartbeatAt: ago(MINUTE) },
          { status: "registered", lastHeartbeatAt: null },
        ],
        NOW
      )
    ).toBe(false);
  });

  it("counts a heartbeat exactly 5 minutes old as checking in", () => {
    const edge = { status: "watching", lastHeartbeatAt: ago(5 * MINUTE) };
    expect(isOfflineAlertPaused([edge, silent], NOW)).toBe(false);
  });

  it("doesn't count a watcher that went quiet long before the others", () => {
    const deadForAWeek = {
      status: "watching",
      lastHeartbeatAt: ago(7 * 24 * HOUR),
    };
    // The last live PC just went down: alone, it must still alert.
    expect(isOfflineAlertPaused([deadForAWeek, silent], NOW)).toBe(false);
    // Two that went quiet together still pause, whatever the dead one does.
    expect(
      isOfflineAlertPaused(
        [
          deadForAWeek,
          silent,
          { status: "watching", lastHeartbeatAt: ago(HOUR) },
        ],
        NOW
      )
    ).toBe(true);
  });

  it("counts watchers that went quiet within an hour of the latest check-in", () => {
    const longAgo = (ms: number) => ({
      status: "watching",
      lastHeartbeatAt: ago(3 * HOUR + ms),
    });
    // A Data Hub fault that has lasted 3 hours still pauses.
    expect(isOfflineAlertPaused([longAgo(0), longAgo(HOUR)], NOW)).toBe(true);
    expect(
      isOfflineAlertPaused([longAgo(0), longAgo(HOUR + SECOND)], NOW)
    ).toBe(false);
  });

  it("ignores a watcher that never checked in", () => {
    expect(
      isOfflineAlertPaused(
        [silent, { status: "watching", lastHeartbeatAt: null }],
        NOW
      )
    ).toBe(false);
  });
});

describe("offline alert wording", () => {
  const base = {
    hostname: "LAB-PC-1",
    lastHeartbeatAt: ago(35 * MINUTE),
    now: NOW,
    watchDirectory: "D:\\Exports",
  };

  it.each<[ConnectionReason, string]>([
    [
      "folder_missing",
      "The watcher can't find D:\\Exports, so it isn't picking up new files from this instrument.",
    ],
    [
      "unresponsive",
      "The watcher hasn't checked in for 35 minutes. New files won't appear until it's back.",
    ],
    [
      "stopped",
      "The watcher on LAB-PC-1 was stopped. New files won't appear until it's started again.",
    ],
    [
      "no_watcher",
      "It isn't connected to a watcher. New files won't appear until a watcher is set up on the instrument PC.",
    ],
    [
      "deregistered",
      "Its watcher was deregistered. New files won't appear until a new watcher is set up.",
    ],
  ])("explains %s", (reason, sentence) => {
    expect(offlineAlertMessage(reason, base)).toBe(sentence);
  });

  it("covers every reason", () => {
    for (const reason of CONNECTION_REASONS) {
      expect(offlineAlertMessage(reason, base)).not.toBe("");
    }
  });

  it("leaves out what it doesn't know", () => {
    const unknown = {
      hostname: null,
      lastHeartbeatAt: null,
      now: NOW,
      watchDirectory: null,
    };
    expect(offlineAlertMessage("folder_missing", unknown)).toBe(
      "The watcher can't find its watch folder, so it isn't picking up new files from this instrument."
    );
    expect(offlineAlertMessage("unresponsive", unknown)).toBe(
      "The watcher isn't checking in. New files won't appear until it's back."
    );
    expect(offlineAlertMessage("stopped", unknown)).toBe(
      "The watcher was stopped. New files won't appear until it's started again."
    );
  });

  it.each([
    [45 * MINUTE, "It was offline for about 45 minutes."],
    [2 * HOUR + 10 * MINUTE, "It was offline for about 2 hours."],
    [26 * HOUR, "It was offline for about 1 day."],
  ])("says how long it was offline (%i ms)", (ms, sentence) => {
    expect(backOnlineMessage(ago(ms), NOW)).toBe(sentence);
  });

  it("names the instrument in the heading", () => {
    expect(
      instrumentConnectionHeading("instrument_offline", "Plate Reader")
    ).toBe("Plate Reader is offline");
    expect(
      instrumentConnectionHeading("instrument_back_online", "Plate Reader")
    ).toBe("Plate Reader is back online");
  });
});
