import { describe, expect, it } from "vitest";
import {
  AUTO_UPDATE_STATUS_REASON,
  computeEffectiveStatus,
} from "@/lib/api/watcher-status";
import {
  computeConnection,
  type InstrumentBadgeState,
  type InstrumentLifecycleStatus,
  instrumentBadgeState,
} from "@/lib/instruments/connection";
import { getRunUploadAvailability } from "@/lib/runs/upload-availability";

// The run page's upload table: each badge state says whether Upload works and
// what to tell the viewer. The first six tests are its rows. The rest walk
// from a stored watcher to the table, as the page and the upload-request
// routes read it, and check the instrument states that decide the badge.

describe("getRunUploadAvailability", () => {
  it("Online: Upload is enabled and nothing is said", () => {
    expect(getRunUploadAvailability("online")).toEqual({
      enabled: true,
      reason: null,
      tone: null,
    });
  });

  it("Restarting: Upload is enabled and a blue line says it starts once the PC is back", () => {
    expect(getRunUploadAvailability("restarting")).toEqual({
      enabled: true,
      reason: "The instrument PC is restarting. Uploads start once it's back.",
      tone: "info",
    });
  });

  it("Connecting: Upload is disabled because the watcher hasn't checked in", () => {
    expect(getRunUploadAvailability("connecting")).toEqual({
      enabled: false,
      reason: "The watcher hasn't checked in yet.",
      tone: "muted",
    });
  });

  it("Offline: Upload is disabled and a red line says why", () => {
    expect(getRunUploadAvailability("offline")).toEqual({
      enabled: false,
      reason: "Can't upload while the watcher is offline.",
      tone: "destructive",
    });
  });

  it("Retired: Upload is disabled because the instrument is retired", () => {
    expect(getRunUploadAvailability("retired")).toEqual({
      enabled: false,
      reason: "This instrument is retired.",
      tone: "muted",
    });
  });

  it("Pending: Upload is disabled because an admin hasn't confirmed the instrument", () => {
    expect(getRunUploadAvailability("pending")).toEqual({
      enabled: false,
      reason: "This instrument is waiting for an admin to confirm it.",
      tone: "muted",
    });
  });

  it("only Online and Restarting accept upload requests", () => {
    const accepting = (
      [
        "online",
        "restarting",
        "connecting",
        "offline",
        "retired",
        "pending",
      ] as const satisfies readonly InstrumentBadgeState[]
    ).filter((badge) => getRunUploadAvailability(badge).enabled);
    expect(accepting).toEqual(["online", "restarting"]);
  });
});

describe("the table from a stored watcher", () => {
  const NOW = new Date("2026-11-12T15:00:00.000Z");
  const MINUTE = 60 * 1000;

  function badgeFor(
    instrumentStatus: InstrumentLifecycleStatus,
    watcher: {
      ageMs: number;
      reason?: string | null;
      status: "stopped" | "watching";
    }
  ): InstrumentBadgeState {
    const reason = watcher.reason ?? null;
    const status = computeEffectiveStatus(
      {
        status: watcher.status,
        statusReason: reason,
        lastHeartbeatAt: new Date(NOW.getTime() - watcher.ageMs),
        deletedAt: null,
      },
      NOW
    );
    return instrumentBadgeState(
      instrumentStatus,
      computeConnection({ status, statusReason: reason }, 0)
    );
  }

  it("accepts a request for a watcher stopped for an update 10 minutes ago", () => {
    const badge = badgeFor("active", {
      status: "stopped",
      reason: AUTO_UPDATE_STATUS_REASON,
      ageMs: 10 * MINUTE,
    });
    expect(badge).toBe("restarting");
    expect(getRunUploadAvailability(badge).enabled).toBe(true);
  });

  it("refuses a request for a watcher stopped for an update 20 minutes ago", () => {
    const badge = badgeFor("active", {
      status: "stopped",
      reason: AUTO_UPDATE_STATUS_REASON,
      ageMs: 20 * MINUTE,
    });
    expect(badge).toBe("offline");
    expect(getRunUploadAvailability(badge).enabled).toBe(false);
  });

  it("refuses a request for a watcher someone stopped", () => {
    const badge = badgeFor("active", { status: "stopped", ageMs: MINUTE });
    expect(badge).toBe("offline");
    expect(getRunUploadAvailability(badge).enabled).toBe(false);
  });

  it("refuses a request for a retired instrument whose watcher is still heartbeating", () => {
    const badge = badgeFor("inactive", { status: "watching", ageMs: MINUTE });
    expect(badge).toBe("retired");
    expect(getRunUploadAvailability(badge).enabled).toBe(false);
  });

  it("refuses a request for a pending instrument whose watcher is still heartbeating", () => {
    const badge = badgeFor("pending", { status: "watching", ageMs: MINUTE });
    expect(badge).toBe("pending");
    expect(getRunUploadAvailability(badge).enabled).toBe(false);
  });
});
