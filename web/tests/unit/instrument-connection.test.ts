import { describe, expect, it } from "vitest";
import {
  AUTO_UPDATE_STATUS_REASON,
  computeEffectiveStatus,
  SYSTEM_SHUTDOWN_STATUS_REASON,
} from "@/lib/api/watcher-status";
import {
  type Connection,
  computeConnection,
  deriveConfigState,
  type InstrumentBadgeState,
  type InstrumentLifecycleStatus,
  instrumentBadgeState,
  toLegacyWatcherStatus,
} from "@/lib/instruments/connection";

// The instrument badge is derived from the instrument's status and its one
// active watcher: `computeEffectiveStatus` turns the stored status, reason and
// heartbeat age into the watcher's status, `computeConnection` turns that into
// the connection, and `instrumentBadgeState` lets Pending and Retired win.
// These tests walk the whole chain, so each row of the badge table is checked
// from stored watcher columns, as the server reads them.

const NOW = new Date("2026-11-12T15:00:00.000Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

interface StoredWatcher {
  /** `null` is a watcher that never sent a heartbeat. */
  ageMs: number | null;
  reason?: string | null;
  status: "registered" | "watching" | "stopped" | "waiting";
}

function evaluate(
  instrumentStatus: InstrumentLifecycleStatus,
  watcher: StoredWatcher | null,
  pastWatcherCount = 0
): { badge: InstrumentBadgeState; connection: Connection } {
  const connection = computeConnection(
    watcher
      ? {
          status: computeEffectiveStatus(
            {
              status: watcher.status,
              statusReason: watcher.reason ?? null,
              lastHeartbeatAt:
                watcher.ageMs === null
                  ? null
                  : new Date(NOW.getTime() - watcher.ageMs),
              deletedAt: null,
            },
            NOW
          ),
          statusReason: watcher.reason ?? null,
        }
      : null,
    pastWatcherCount
  );
  return {
    connection,
    badge: instrumentBadgeState(instrumentStatus, connection),
  };
}

describe("instrument badge table", () => {
  // One case per row, first match wins. Rows 3 and 7 have several cases,
  // because each reason behind Offline is its own case.
  const rows: {
    badge: InstrumentBadgeState;
    instrumentStatus: InstrumentLifecycleStatus;
    name: string;
    past?: number;
    reason: Connection["reason"];
    row: number;
    watcher: StoredWatcher | null;
  }[] = [
    {
      row: 1,
      name: "pending instrument with no watcher",
      instrumentStatus: "pending",
      watcher: null,
      badge: "pending",
      reason: "no_watcher",
    },
    {
      row: 1,
      name: "pending instrument with a registered watcher is Pending, not Connecting",
      instrumentStatus: "pending",
      watcher: { status: "registered", ageMs: null },
      badge: "pending",
      reason: null,
    },
    {
      row: 1,
      name: "pending instrument with a watching watcher is Pending, not Online",
      instrumentStatus: "pending",
      watcher: { status: "watching", ageMs: 10 * SECOND },
      badge: "pending",
      reason: null,
    },
    {
      row: 2,
      name: "retired instrument with no watcher is Retired, not Offline",
      instrumentStatus: "inactive",
      watcher: null,
      past: 1,
      badge: "retired",
      reason: "deregistered",
    },
    {
      row: 2,
      name: "retired instrument whose watcher still reports is Retired",
      instrumentStatus: "inactive",
      watcher: { status: "watching", ageMs: 10 * SECOND },
      badge: "retired",
      reason: null,
    },
    {
      row: 3,
      name: "active instrument that never had a watcher",
      instrumentStatus: "active",
      watcher: null,
      badge: "offline",
      reason: "no_watcher",
    },
    {
      row: 3,
      name: "active instrument whose only watcher was deregistered",
      instrumentStatus: "active",
      watcher: null,
      past: 1,
      badge: "offline",
      reason: "deregistered",
    },
    {
      row: 3,
      name: "active instrument whose watchers were all deregistered",
      instrumentStatus: "active",
      watcher: null,
      past: 3,
      badge: "offline",
      reason: "deregistered",
    },
    {
      row: 4,
      name: "registered watcher with no heartbeat yet",
      instrumentStatus: "active",
      watcher: { status: "registered", ageMs: null },
      badge: "connecting",
      reason: null,
    },
    {
      row: 4,
      name: "registered watcher is Connecting however long ago it registered",
      instrumentStatus: "active",
      watcher: { status: "registered", ageMs: null },
      past: 2,
      badge: "connecting",
      reason: null,
    },
    {
      row: 5,
      name: "stopped for a Windows restart a minute ago",
      instrumentStatus: "active",
      watcher: {
        status: "stopped",
        reason: SYSTEM_SHUTDOWN_STATUS_REASON,
        ageMs: MINUTE,
      },
      badge: "restarting",
      reason: null,
    },
    {
      row: 5,
      name: "stopped for an automatic update 10 minutes ago",
      instrumentStatus: "active",
      watcher: {
        status: "stopped",
        reason: AUTO_UPDATE_STATUS_REASON,
        ageMs: 10 * MINUTE,
      },
      badge: "restarting",
      reason: null,
    },
    {
      row: 5,
      name: "stopped for an automatic update exactly 15 minutes ago",
      instrumentStatus: "active",
      watcher: {
        status: "stopped",
        reason: AUTO_UPDATE_STATUS_REASON,
        ageMs: 15 * MINUTE,
      },
      badge: "restarting",
      reason: null,
    },
    {
      row: 6,
      name: "watching with a heartbeat 10 seconds ago",
      instrumentStatus: "active",
      watcher: { status: "watching", ageMs: 10 * SECOND },
      badge: "online",
      reason: null,
    },
    {
      row: 6,
      name: "watching with a heartbeat exactly 5 minutes ago",
      instrumentStatus: "active",
      watcher: { status: "watching", ageMs: 5 * MINUTE },
      badge: "online",
      reason: null,
    },
    {
      row: 7,
      name: "watching, but no heartbeat for 6 minutes (Unresponsive)",
      instrumentStatus: "active",
      watcher: { status: "watching", ageMs: 6 * MINUTE },
      badge: "offline",
      reason: "unresponsive",
    },
    {
      row: 7,
      name: "stopped for an automatic update 16 minutes ago (Unresponsive)",
      instrumentStatus: "active",
      watcher: {
        status: "stopped",
        reason: AUTO_UPDATE_STATUS_REASON,
        ageMs: 16 * MINUTE,
      },
      badge: "offline",
      reason: "unresponsive",
    },
    {
      row: 7,
      name: "stopped for a Windows restart 20 minutes ago (Unresponsive)",
      instrumentStatus: "active",
      watcher: {
        status: "stopped",
        reason: SYSTEM_SHUTDOWN_STATUS_REASON,
        ageMs: 20 * MINUTE,
      },
      badge: "offline",
      reason: "unresponsive",
    },
    {
      row: 7,
      name: "stopped by someone, a minute ago",
      instrumentStatus: "active",
      watcher: { status: "stopped", reason: null, ageMs: MINUTE },
      badge: "offline",
      reason: "stopped",
    },
    {
      row: 7,
      name: "stopped by someone 3 days ago stays Stopped, never Unresponsive",
      instrumentStatus: "active",
      watcher: { status: "stopped", reason: null, ageMs: 3 * DAY },
      badge: "offline",
      reason: "stopped",
    },
    {
      row: 7,
      name: "stopped with a reason that is not a restart",
      instrumentStatus: "active",
      watcher: { status: "stopped", reason: "operator", ageMs: 30 * MINUTE },
      badge: "offline",
      reason: "stopped",
    },
    {
      row: 7,
      name: "waiting for its folder, with a recent heartbeat",
      instrumentStatus: "active",
      watcher: { status: "waiting", reason: "D:\\Exports", ageMs: MINUTE },
      badge: "offline",
      reason: "folder_missing",
    },
    {
      row: 7,
      name: "waiting for its folder, but silent for 10 minutes (Unresponsive)",
      instrumentStatus: "active",
      watcher: { status: "waiting", reason: "D:\\Exports", ageMs: 10 * MINUTE },
      badge: "offline",
      reason: "unresponsive",
    },
  ];

  it.each(rows)("row $row: $name", ({
    instrumentStatus,
    watcher,
    past,
    badge,
    reason,
  }) => {
    const result = evaluate(instrumentStatus, watcher, past);
    expect(result.badge).toBe(badge);
    expect(result.connection.reason).toBe(reason);
  });

  it("covers all seven rows", () => {
    expect(new Set(rows.map((r) => r.row))).toEqual(
      new Set([1, 2, 3, 4, 5, 6, 7])
    );
  });

  it("gives a reason only when the connection is offline", () => {
    for (const { instrumentStatus, watcher, past } of rows) {
      const { connection } = evaluate(instrumentStatus, watcher, past);
      expect(connection.reason === null).toBe(connection.state !== "offline");
    }
  });
});

describe("computeConnection", () => {
  it("is Online only for a watching watcher", () => {
    expect(
      computeConnection({ status: "watching", statusReason: null }, 0)
    ).toEqual({ state: "online", reason: null });
  });

  it("is Connecting for a registered watcher", () => {
    expect(
      computeConnection({ status: "registered", statusReason: null }, 0)
    ).toEqual({ state: "connecting", reason: null });
  });

  it("is Restarting for a stop with either restart reason", () => {
    for (const statusReason of [
      SYSTEM_SHUTDOWN_STATUS_REASON,
      AUTO_UPDATE_STATUS_REASON,
    ]) {
      expect(computeConnection({ status: "stopped", statusReason }, 0)).toEqual(
        { state: "restarting", reason: null }
      );
    }
  });

  it("is offline with a reason for every other status", () => {
    expect(
      computeConnection({ status: "waiting", statusReason: "D:\\Exports" }, 0)
    ).toEqual({ state: "offline", reason: "folder_missing" });
    expect(
      computeConnection({ status: "stale", statusReason: null }, 0)
    ).toEqual({ state: "offline", reason: "unresponsive" });
    expect(
      computeConnection({ status: "stopped", statusReason: null }, 0)
    ).toEqual({ state: "offline", reason: "stopped" });
  });

  it("keeps the restart reason of a stale watcher out of Restarting", () => {
    // A restart that ran past its 15 minutes reads `stale` and keeps the
    // stored reason.
    expect(
      computeConnection(
        { status: "stale", statusReason: AUTO_UPDATE_STATUS_REASON },
        0
      )
    ).toEqual({ state: "offline", reason: "unresponsive" });
  });

  it("tells no watcher from a deregistered one by the past count", () => {
    expect(computeConnection(null, 0)).toEqual({
      state: "offline",
      reason: "no_watcher",
    });
    expect(computeConnection(null, 1)).toEqual({
      state: "offline",
      reason: "deregistered",
    });
  });

  it("ignores the past count when a watcher is active", () => {
    expect(
      computeConnection({ status: "watching", statusReason: null }, 4)
    ).toEqual({ state: "online", reason: null });
  });
});

describe("toLegacyWatcherStatus", () => {
  it("maps back to the names screens used before one watcher per instrument", () => {
    expect(toLegacyWatcherStatus({ state: "online", reason: null })).toBe(
      "online"
    );
    expect(
      toLegacyWatcherStatus({ state: "offline", reason: "no_watcher" })
    ).toBe("no_watcher");
    expect(
      toLegacyWatcherStatus({ state: "offline", reason: "deregistered" })
    ).toBe("deregistered");
    for (const reason of [
      "folder_missing",
      "unresponsive",
      "stopped",
    ] as const) {
      expect(toLegacyWatcherStatus({ state: "offline", reason })).toBe(
        "offline"
      );
    }
  });

  it("reads Restarting and Connecting as offline, as they were", () => {
    expect(toLegacyWatcherStatus({ state: "restarting", reason: null })).toBe(
      "offline"
    );
    expect(toLegacyWatcherStatus({ state: "connecting", reason: null })).toBe(
      "offline"
    );
  });
});

describe("deriveConfigState", () => {
  it("is none when the watcher has no current revision", () => {
    expect(deriveConfigState(null, false)).toBe("none");
  });

  it("follows the first match of pending, rejected, edited on PC, applied", () => {
    expect(deriveConfigState("pending", false)).toBe("pending");
    expect(deriveConfigState("pending", true)).toBe("pending");
    expect(deriveConfigState("rejected", false)).toBe("rejected");
    expect(deriveConfigState("rejected", true)).toBe("rejected");
    expect(deriveConfigState("applied", true)).toBe("edited_on_pc");
    expect(deriveConfigState("applied", false)).toBe("applied");
  });

  it("is none for a superseded current revision", () => {
    expect(deriveConfigState("superseded", false)).toBe("none");
  });
});
