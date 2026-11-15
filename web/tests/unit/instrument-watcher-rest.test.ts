import { describe, expect, it } from "vitest";
import {
  canReadWatcherHostDetails,
  instrumentWatcherToRest,
} from "@/lib/api/instrument-watchers";
import type { InstrumentWatcher } from "@/lib/instruments/connection";

// `instruments:read` returns an instrument's watcher, but where that watcher
// runs was `watchers:read` data first. These tests pin which fields a caller
// gets for each set of scopes.

const WATCHER: InstrumentWatcher = {
  id: "watcher-0001",
  hostname: "LAB-PC-01",
  osInfo: "Windows 11",
  version: "1.2.3",
  status: "watching",
  statusReason: null,
  lastHeartbeatAt: new Date("2026-11-14T12:00:00Z"),
  watchDirectory: "D:\\Exports",
  filePatterns: ["*.csv"],
  uploadMode: "auto",
  configState: "none",
  sharedComputerWith: [
    { instrumentId: "other-instrument", displayName: "Other Instrument" },
  ],
};

const HOST_FIELDS = [
  "hostname",
  "os_info",
  "version",
  "watch_directory",
  "shared_computer_with",
];

const STATE_FIELDS = [
  "id",
  "status",
  "status_reason",
  "last_heartbeat_at",
  "file_patterns",
  "upload_mode",
  "config_state",
];

describe("canReadWatcherHostDetails", () => {
  it.each([
    [["instruments:read"], false],
    [["instruments:read", "runs:read"], false],
    [["instruments:read", "watchers:report", "watchers:admin"], false],
    // A legacy coarse scope never implied `watchers:read`.
    [["instruments:read", "watchers:write"], false],
    [[], false],
    [["instruments:read", "watchers:read"], true],
    [["watchers:read"], true],
    // Browser sessions and legacy wildcard tokens hold every scope.
    [["*"], true],
  ])("scopes %j -> %s", (scopes, expected) => {
    expect(canReadWatcherHostDetails({ scopes })).toBe(expected);
  });
});

describe("instrumentWatcherToRest", () => {
  it("is null when the instrument has no active watcher, whatever the scopes", () => {
    expect(instrumentWatcherToRest(null, { scopes: ["*"] })).toBeNull();
    expect(
      instrumentWatcherToRest(null, { scopes: ["instruments:read"] })
    ).toBeNull();
  });

  it("leaves out the host details without watchers:read, and keeps the rest", () => {
    const result = instrumentWatcherToRest(WATCHER, {
      scopes: ["instruments:read"],
    });
    expect(result).toEqual({
      id: "watcher-0001",
      status: "watching",
      status_reason: null,
      last_heartbeat_at: "2026-11-14T12:00:00.000Z",
      file_patterns: ["*.csv"],
      upload_mode: "auto",
      config_state: "none",
    });
    // Absent, not null: the keys aren't in the object at all.
    for (const key of HOST_FIELDS) {
      expect(result).not.toHaveProperty(key);
    }
    expect(JSON.stringify(result)).not.toContain("LAB-PC-01");
    expect(JSON.stringify(result)).not.toContain("D:");
  });

  it.each([
    ["a token with watchers:read", ["instruments:read", "watchers:read"]],
    ["a session or wildcard token", ["*"]],
  ])("returns every field for %s", (_name, scopes) => {
    const result = instrumentWatcherToRest(WATCHER, { scopes });
    expect(result).toMatchObject({
      hostname: "LAB-PC-01",
      os_info: "Windows 11",
      version: "1.2.3",
      watch_directory: "D:\\Exports",
      shared_computer_with: [
        { instrument_id: "other-instrument", display_name: "Other Instrument" },
      ],
    });
    for (const key of [...HOST_FIELDS, ...STATE_FIELDS]) {
      expect(result).toHaveProperty(key);
    }
  });
});
