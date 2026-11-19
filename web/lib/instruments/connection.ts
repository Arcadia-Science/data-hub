// How an instrument is connected to its watcher, and the badge that shows it.
// No database imports, so server code and client components share one
// definition and the web app, REST API and MCP tools always agree.
//
// An instrument has at most one active watcher registration (a partial unique
// index on `watchers` guarantees it), so everything here takes one watcher or
// none. The server builds the watcher (`lib/api/instrument-watchers.ts`), and
// `computeConnection` turns its status into the connection that every
// instrument response carries.

import type { EffectiveStatus } from "@/lib/api/watcher-status";
import { isRestartStopReason } from "@/lib/api/watcher-status";

export type InstrumentLifecycleStatus = "pending" | "active" | "inactive";

export const CONNECTION_STATES = [
  "online",
  "restarting",
  "connecting",
  "offline",
] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

// Why an instrument is offline. Null for every other state.
export const CONNECTION_REASONS = [
  // The watcher is running but can't find its watch folder.
  "folder_missing",
  // No heartbeat for 5 minutes, or no return from a restart within 15.
  "unresponsive",
  // The watcher registered but sent no heartbeat within 15 minutes of its
  // registration, or of the instrument's confirmation if that came later.
  "never_checked_in",
  // Someone stopped the watcher, with no restart or update reason.
  "stopped",
  // The instrument has never had a watcher.
  "no_watcher",
  // The instrument's watcher was deregistered and none replaced it.
  "deregistered",
] as const;
export type ConnectionReason = (typeof CONNECTION_REASONS)[number];

export interface Connection {
  reason: ConnectionReason | null;
  state: ConnectionState;
}

export const WATCHER_CONFIG_STATES = [
  "none",
  "pending",
  "applied",
  "rejected",
  "edited_on_pc",
] as const;
export type InstrumentWatcherConfigState =
  (typeof WATCHER_CONFIG_STATES)[number];

export const UPLOAD_MODES = ["auto", "manual"] as const;
export type UploadMode = (typeof UPLOAD_MODES)[number];

/** Another instrument whose active watcher runs on the same computer. */
export interface SharedComputerInstrument {
  displayName: string;
  instrumentId: string;
}

/**
 * Orders instruments by name for any list that names them: case-insensitive,
 * numbers by value ("Reader 2" before "Reader 10"), then by id. The watcher
 * page, the instrument list's tooltip and Settings › Watchers all name shared
 * instruments through this one rule, so they list them in the same order.
 */
export function compareInstrumentNames(
  a: SharedComputerInstrument,
  b: SharedComputerInstrument
): number {
  return (
    a.displayName.localeCompare(b.displayName, undefined, {
      numeric: true,
      sensitivity: "base",
    }) || a.instrumentId.localeCompare(b.instrumentId)
  );
}

/**
 * The computer a hostname names, for comparing computers: trimmed and without
 * case, as Windows compares names. Null when the hostname is missing or blank,
 * since registration accepts an empty string. The shared-computer join in
 * `lib/api/instrument-watchers.ts` applies the same rule in SQL
 * (`lower(nullif(trim(hostname), ''))`), so change them together.
 */
export function computerKey(hostname: string | null): string | null {
  const trimmed = hostname?.trim() ?? "";
  return trimmed === "" ? null : trimmed.toLowerCase();
}

/**
 * The one active watcher of an instrument. `status` is the effective status
 * (see `computeEffectiveStatus`), so it can be `stale`, which the database
 * never stores.
 */
export interface InstrumentWatcher {
  configState: InstrumentWatcherConfigState;
  /** From the watcher's config, in the order the config lists them. */
  filePatterns: string[];
  hostname: string | null;
  id: string;
  lastHeartbeatAt: Date | null;
  osInfo: string | null;
  /**
   * The instruments whose active watchers report the same hostname, compared
   * without case, as Windows does. Empty when the computer runs only this
   * watcher.
   */
  sharedComputerWith: SharedComputerInstrument[];
  status: EffectiveStatus;
  /**
   * The stored `status_reason`: the missing folder of a `waiting` watcher, or
   * the restart or update reason of a `stopped` one. It stays while a
   * restart's 15 minutes have passed and the status reads `stale`.
   */
  statusReason: string | null;
  uploadMode: UploadMode;
  version: string | null;
  watchDirectory: string | null;
}

/** What `computeConnection` needs of a watcher. */
export type ConnectionWatcher = Pick<
  InstrumentWatcher,
  "lastHeartbeatAt" | "status" | "statusReason"
>;

/**
 * The connection of an instrument from its active watcher, or null when it has
 * none. `pastWatcherCount` counts the deregistered ones, and tells an
 * instrument that lost its watcher from one that never had any.
 *
 * Only `watching` with a heartbeat inside 5 minutes reads Online, and the
 * instrument's own status plays no part: `instrumentBadgeState` lets Pending
 * and Retired win.
 */
export function computeConnection(
  watcher: ConnectionWatcher | null,
  pastWatcherCount: number
): Connection {
  if (watcher === null) {
    return {
      state: "offline",
      reason: pastWatcherCount > 0 ? "deregistered" : "no_watcher",
    };
  }
  switch (watcher.status) {
    case "watching":
      return { state: "online", reason: null };
    case "registered":
      return { state: "connecting", reason: null };
    case "waiting":
      return { state: "offline", reason: "folder_missing" };
    case "stale":
      // A watcher that never sent a heartbeat is a `registered` one past its
      // time limit: it was set up but never started, or can't reach Data Hub.
      return {
        state: "offline",
        reason:
          watcher.lastHeartbeatAt === null
            ? "never_checked_in"
            : "unresponsive",
      };
    case "stopped":
      // The effective status is `stopped` for a restart only inside its 15
      // minutes. After that it reads `stale`, which is the case above.
      return isRestartStopReason(watcher.statusReason)
        ? { state: "restarting", reason: null }
        : { state: "offline", reason: "stopped" };
    default:
      return watcher.status satisfies never;
  }
}

/** What the badge in an instrument's header, row or card shows. */
export type InstrumentBadgeState = "pending" | "retired" | ConnectionState;

/**
 * The instrument badge. Check the rows in order; the first match wins:
 *
 * 1. Instrument status is pending: Pending.
 * 2. Instrument status is inactive: Retired.
 * 3. No current watcher: Offline.
 * 4. Watcher is registered, with no heartbeat yet, and 15 minutes haven't
 *    passed since it registered or the instrument was confirmed: Connecting.
 * 5. Watcher stopped for a Windows restart or an automatic update, and 15
 *    minutes haven't passed: Restarting.
 * 6. Watcher is watching, with a heartbeat inside 5 minutes: Online.
 * 7. Anything else (unresponsive, never checked in, stopped by someone,
 *    waiting for its folder): Offline.
 *
 * Rows 3 to 7 are the connection's state, which `computeConnection` decides.
 */
export function instrumentBadgeState(
  status: InstrumentLifecycleStatus,
  connection: Connection
): InstrumentBadgeState {
  if (status === "pending") {
    return "pending";
  }
  if (status === "inactive") {
    return "retired";
  }
  return connection.state;
}

/**
 * The status of an instrument's watchers as screens showed it before an
 * instrument had one watcher: online, offline, or a name for having none.
 * Restarting and Connecting read as offline there.
 */
export type LegacyWatcherStatus =
  | "online"
  | "offline"
  | "no_watcher"
  | "deregistered";

export function toLegacyWatcherStatus(
  connection: Connection
): LegacyWatcherStatus {
  if (connection.state === "online") {
    return "online";
  }
  if (connection.reason === "no_watcher") {
    return "no_watcher";
  }
  if (connection.reason === "deregistered") {
    return "deregistered";
  }
  return "offline";
}

type RevisionStatus = "pending" | "applied" | "rejected" | "superseded";

/**
 * The settings state of a watcher, for the one notice on its Settings tab.
 * `currentStatus` is the status of its current config revision (the newest
 * one that wasn't superseded), and `pcEditAwaitingRestart` is true when the
 * newest change is an edit made on the PC that the running watcher hasn't
 * loaded yet. The first match wins: pending, rejected, edited on the PC,
 * applied, none.
 */
export function deriveConfigState(
  currentStatus: RevisionStatus | null,
  pcEditAwaitingRestart: boolean
): InstrumentWatcherConfigState {
  if (currentStatus === "pending") {
    return "pending";
  }
  if (currentStatus === "rejected") {
    return "rejected";
  }
  if (pcEditAwaitingRestart) {
    return "edited_on_pc";
  }
  if (currentStatus === "applied") {
    return "applied";
  }
  return "none";
}
