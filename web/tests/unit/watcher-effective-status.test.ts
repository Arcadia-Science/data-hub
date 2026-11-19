import { describe, expect, it } from "vitest";
import {
  AUTO_UPDATE_STATUS_REASON,
  computeEffectiveStatus,
  type EffectiveStatus,
  FIRST_CHECK_IN_GRACE_MS,
  isRestartStopReason,
  RESTART_STOP_REASONS,
  STALE_THRESHOLD_MS,
  SYSTEM_SHUTDOWN_STATUS_REASON,
  UPLOAD_REQUEST_REVERT_GRACE_MS,
} from "@/lib/api/watcher-status";

// The display status of a watcher from its stored status, its stored reason
// and the age of its last heartbeat, and for a `registered` watcher, when it
// registered and when its instrument was confirmed. The list route's `status` filter builds
// the same rules in SQL (`effectiveStatusCondition`); the integration suite
// checks that the two agree (`tests/integration/watchers.test.ts`).

const NOW = new Date("2026-11-12T15:00:00.000Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

function ago(ms: number | null): Date | null {
  return ms === null ? null : new Date(NOW.getTime() - ms);
}

// `null` age is a watcher with no heartbeat at all. The watcher registered a
// minute ago, on an active instrument that was never pending.
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
      lastHeartbeatAt: ago(ageMs),
      createdAt: new Date(NOW.getTime() - MINUTE),
      instrumentStatus: "active",
      instrumentConfirmedAt: null,
      deletedAt: deregistered ? ago(MINUTE) : null,
    },
    NOW
  );
}

// A `registered` watcher with no heartbeat, by how long ago it registered and
// its instrument was confirmed (`null`: never pending).
function registeredStatusOf(
  registeredMsAgo: number,
  options: {
    confirmedMsAgo?: number | null;
    heartbeatMsAgo?: number | null;
    instrumentStatus?: string | null;
  } = {}
): EffectiveStatus {
  return computeEffectiveStatus(
    {
      status: "registered",
      statusReason: null,
      lastHeartbeatAt: ago(options.heartbeatMsAgo ?? null),
      createdAt: new Date(NOW.getTime() - registeredMsAgo),
      instrumentStatus:
        options.instrumentStatus === undefined
          ? "active"
          : options.instrumentStatus,
      instrumentConfirmedAt: ago(options.confirmedMsAgo ?? null),
      deletedAt: null,
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
  it("uses 5 minutes and 15 minutes as its limits", () => {
    expect(STALE_THRESHOLD_MS).toBe(5 * MINUTE);
    expect(UPLOAD_REQUEST_REVERT_GRACE_MS).toBe(15 * MINUTE);
    expect(FIRST_CHECK_IN_GRACE_MS).toBe(15 * MINUTE);
  });

  describe.each<Row>([
    // registered a minute ago: inside its first 15 minutes, whatever its
    // heartbeat says. `registeredStatusOf` below covers its clock.
    ["registered, no heartbeat", "registered", null, null, "registered"],
    ["registered, heartbeat a day old", "registered", null, DAY, "registered"],

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

  // A registered watcher has 15 minutes to check in, from whichever came last
  // of its registration and its instrument's confirmation.
  describe("registered, with no check-in", () => {
    it.each<{
      name: string;
      registeredMsAgo: number;
      confirmedMsAgo?: number | null;
      expected: EffectiveStatus;
    }>([
      { name: "just registered", registeredMsAgo: 0, expected: "registered" },
      {
        name: "registered 14 minutes ago",
        registeredMsAgo: 14 * MINUTE,
        expected: "registered",
      },
      {
        name: "at the 15-minute limit",
        registeredMsAgo: 15 * MINUTE,
        expected: "registered",
      },
      {
        name: "just past the 15-minute limit",
        registeredMsAgo: 15 * MINUTE + SECOND,
        expected: "stale",
      },
      { name: "registered a day ago", registeredMsAgo: DAY, expected: "stale" },
      {
        name: "registered a day ago, confirmed a minute ago",
        registeredMsAgo: DAY,
        confirmedMsAgo: MINUTE,
        expected: "registered",
      },
      {
        name: "registered a day ago, confirmed at the limit",
        registeredMsAgo: DAY,
        confirmedMsAgo: 15 * MINUTE,
        expected: "registered",
      },
      {
        name: "registered a day ago, confirmed just past the limit",
        registeredMsAgo: DAY,
        confirmedMsAgo: 15 * MINUTE + SECOND,
        expected: "stale",
      },
      // A watcher registered for an instrument confirmed long ago (it lost
      // its previous watcher) counts from its own registration.
      {
        name: "registered a minute ago, confirmed a month ago",
        registeredMsAgo: MINUTE,
        confirmedMsAgo: 30 * DAY,
        expected: "registered",
      },
      {
        name: "registered 20 minutes ago, confirmed a month ago",
        registeredMsAgo: 20 * MINUTE,
        confirmedMsAgo: 30 * DAY,
        expected: "stale",
      },
    ])("$name reads $expected", ({
      registeredMsAgo,
      confirmedMsAgo,
      expected,
    }) => {
      expect(registeredStatusOf(registeredMsAgo, { confirmedMsAgo })).toBe(
        expected
      );
    });

    // The watcher won't start until its instrument is confirmed.
    it("stays registered however long its instrument is pending", () => {
      expect(
        registeredStatusOf(30 * DAY, { instrumentStatus: "pending" })
      ).toBe("registered");
    });

    it("goes stale on a retired instrument like an active one", () => {
      expect(registeredStatusOf(DAY, { instrumentStatus: "inactive" })).toBe(
        "stale"
      );
    });

    it("counts an instrument it can't read as not pending", () => {
      expect(registeredStatusOf(DAY, { instrumentStatus: null })).toBe("stale");
    });

    // Only a client other than the watcher sends a `registered` heartbeat,
    // but one that does keeps the watcher inside its 15 minutes.
    it("counts from a heartbeat newer than its registration", () => {
      expect(registeredStatusOf(DAY, { heartbeatMsAgo: MINUTE })).toBe(
        "registered"
      );
      expect(registeredStatusOf(DAY, { heartbeatMsAgo: 20 * MINUTE })).toBe(
        "stale"
      );
    });
  });

  // A deregistered watcher can't heartbeat, so it reads stopped whatever it
  // last said and however old that was.
  describe.each<
    [name: string, status: string, reason: string | null, ageMs: number | null]
  >([
    ["registered, no heartbeat", "registered", null, null],
    ["registered, a day old", "registered", null, DAY],
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
      createdAt: new Date(),
      instrumentStatus: "active",
      instrumentConfirmedAt: null,
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
