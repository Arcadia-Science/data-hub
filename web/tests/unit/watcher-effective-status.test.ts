import { describe, expect, it } from "vitest";
import {
  AUTO_UPDATE_STATUS_REASON,
  isRestartStopReason,
  RESTART_STOP_REASONS,
  SYSTEM_SHUTDOWN_STATUS_REASON,
  UPLOAD_REQUEST_REVERT_GRACE_MS,
} from "@/lib/api/watcher-status";
import {
  computeEffectiveStatus,
  type EffectiveStatus,
  STALE_THRESHOLD_MS,
} from "@/lib/api/watchers";

// The display status of a watcher from its stored status, its stored reason
// and the age of its last heartbeat. The list route's `status` filter builds
// the same rules in SQL (`effectiveStatusCondition`); the integration suite
// checks that the two agree (`tests/integration/watchers.test.ts`).

const NOW = new Date("2026-11-12T15:00:00.000Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

// `null` age is a watcher with no heartbeat at all.
function statusOf(
  status: string,
  statusReason: string | null,
  ageMs: number | null,
  deregistered = false
): EffectiveStatus {
  return computeEffectiveStatus(
    {
      status,
      statusReason,
      lastHeartbeatAt: ageMs === null ? null : new Date(NOW.getTime() - ageMs),
      deletedAt: deregistered ? new Date(NOW.getTime() - MINUTE) : null,
    },
    NOW
  );
}

type Row = [
  name: string,
  status: string,
  statusReason: string | null,
  ageMs: number | null,
  expected: EffectiveStatus,
];

describe("computeEffectiveStatus", () => {
  it("uses 5 minutes and 15 minutes as its two limits", () => {
    expect(STALE_THRESHOLD_MS).toBe(5 * MINUTE);
    expect(UPLOAD_REQUEST_REVERT_GRACE_MS).toBe(15 * MINUTE);
  });

  describe.each<Row>([
    // registered: no heartbeat yet, so never stale.
    ["registered, no heartbeat", "registered", null, null, "registered"],
    ["registered, a day old", "registered", null, DAY, "registered"],

    // watching and waiting: stale after 5 minutes, or with no heartbeat.
    ["watching, fresh", "watching", null, MINUTE, "watching"],
    ["watching, at the limit", "watching", null, 5 * MINUTE, "watching"],
    ["watching, just past it", "watching", null, 5 * MINUTE + SECOND, "stale"],
    ["watching, no heartbeat", "watching", null, null, "stale"],
    [
      "waiting, fresh",
      "waiting",
      "watch_directory not found",
      MINUTE,
      "waiting",
    ],
    [
      "waiting, six minutes",
      "waiting",
      "watch_directory not found",
      6 * MINUTE,
      "stale",
    ],
    ["waiting, no heartbeat", "waiting", null, null, "stale"],
    // A reason that only makes sense for a stop changes nothing here.
    [
      "watching, with a restart reason",
      "watching",
      SYSTEM_SHUTDOWN_STATUS_REASON,
      6 * MINUTE,
      "stale",
    ],

    // stopped, plain: stays stopped however old.
    ["stopped, fresh", "stopped", null, MINUTE, "stopped"],
    ["stopped, six minutes", "stopped", null, 6 * MINUTE, "stopped"],
    ["stopped, sixteen minutes", "stopped", null, 16 * MINUTE, "stopped"],
    ["stopped, three days", "stopped", null, 3 * DAY, "stopped"],
    ["stopped, no heartbeat", "stopped", null, null, "stopped"],
    // The route never stores any other reason on a stop, but a row with one
    // is still a plain stop.
    ["stopped, unknown reason", "stopped", "shutdown", 3 * DAY, "stopped"],
  ])("%s", (_name, status, reason, ageMs, expected) => {
    it(`reads ${expected}`, () => {
      expect(statusOf(status, reason, ageMs)).toBe(expected);
    });
  });

  describe.each(RESTART_STOP_REASONS)("stopped for %s", (reason) => {
    it.each<{
      name: string;
      ageMs: number | null;
      expected: EffectiveStatus;
    }>([
      { name: "fresh", ageMs: MINUTE, expected: "stopped" },
      {
        name: "six minutes, past the 5-minute limit",
        ageMs: 6 * MINUTE,
        expected: "stopped",
      },
      {
        name: "at the 15-minute limit",
        ageMs: 15 * MINUTE,
        expected: "stopped",
      },
      {
        name: "just past the 15-minute limit",
        ageMs: 15 * MINUTE + SECOND,
        expected: "stale",
      },
      { name: "three days", ageMs: 3 * DAY, expected: "stale" },
      { name: "no heartbeat", ageMs: null, expected: "stale" },
    ])("$name reads $expected", ({ ageMs, expected }) => {
      expect(statusOf("stopped", reason, ageMs)).toBe(expected);
    });
  });

  // A deregistered watcher can't heartbeat, so it reads stopped whatever it
  // last said and however old that was.
  describe.each<
    [name: string, status: string, reason: string | null, ageMs: number | null]
  >([
    ["registered, no heartbeat", "registered", null, null],
    ["watching, fresh", "watching", null, MINUTE],
    ["watching, a day old", "watching", null, DAY],
    ["watching, no heartbeat", "watching", null, null],
    [
      "waiting, six minutes",
      "waiting",
      "watch_directory not found",
      6 * MINUTE,
    ],
    ["stopped", "stopped", null, DAY],
    ["stopped for a restart, a day old", "stopped", "system_shutdown", DAY],
    ["stopped for a restart, no heartbeat", "stopped", "auto_update", null],
  ])("deregistered, %s", (_name, status, reason, ageMs) => {
    it("reads stopped", () => {
      expect(statusOf(status, reason, ageMs, true)).toBe("stopped");
    });
  });

  it("reads the clock when no time is passed", () => {
    const status = computeEffectiveStatus({
      status: "watching",
      statusReason: null,
      lastHeartbeatAt: new Date(),
      deletedAt: null,
    });
    expect(status).toBe("watching");
  });
});

describe("restart stop reasons", () => {
  it("are the two stops after which the watcher is expected back", () => {
    expect([...RESTART_STOP_REASONS]).toEqual([
      SYSTEM_SHUTDOWN_STATUS_REASON,
      AUTO_UPDATE_STATUS_REASON,
    ]);
    expect(SYSTEM_SHUTDOWN_STATUS_REASON).toBe("system_shutdown");
    expect(AUTO_UPDATE_STATUS_REASON).toBe("auto_update");
  });

  it("are recognised by isRestartStopReason and nothing else is", () => {
    expect(isRestartStopReason("system_shutdown")).toBe(true);
    expect(isRestartStopReason("auto_update")).toBe(true);
    expect(isRestartStopReason("shutdown")).toBe(false);
    expect(isRestartStopReason("System_Shutdown")).toBe(false);
    expect(isRestartStopReason("watch_directory not found")).toBe(false);
    expect(isRestartStopReason("")).toBe(false);
    expect(isRestartStopReason(null)).toBe(false);
    expect(isRestartStopReason(undefined)).toBe(false);
  });
});
