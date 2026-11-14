// What the Settings › Watchers list says and how it orders its rows: the rollout
// pill, the marker for a computer that runs several watchers, and the sort of
// the active rows. No database imports, so the page, the list and the unit
// tests share one definition.

import type { WatcherRosterItem } from "@/lib/api/watcher-roster";
import { compareVersions } from "@/lib/api/watcher-versions";
import {
  compareInstrumentNames,
  computerKey,
  type SharedComputerInstrument,
} from "@/lib/instruments/connection";

/** The rollout pill above the list: how many active watchers run the latest. */
export interface RolloutPill {
  /** "{N} of {M} on {version}". */
  text: string;
  /** Green when every active watcher is on the latest, amber otherwise. */
  tone: "current" | "behind";
}

/**
 * The rollout pill for the active watchers' versions. Null when no latest
 * version is set, and when there are no active watchers to roll out to. A
 * watcher counts as on the latest when it runs that version or a newer one,
 * as "Up to date" on its page does: after a rollback the watchers that
 * already updated don't fall behind, because a watcher never downgrades. One
 * that reports no version, or one that can't be compared, counts as behind.
 */
export function rolloutPill(input: {
  activeVersions: readonly (string | null)[];
  latestVersion: string | null;
}): RolloutPill | null {
  const latest = input.latestVersion?.trim() ?? "";
  const total = input.activeVersions.length;
  if (latest === "" || total === 0) {
    return null;
  }
  const onLatest = input.activeVersions.filter((version) =>
    isOnLatest(version, latest)
  ).length;
  return {
    text: `${onLatest} of ${total} on ${latest}`,
    tone: onLatest === total ? "current" : "behind",
  };
}

function isOnLatest(version: string | null, latest: string): boolean {
  if (version === null) {
    return false;
  }
  if (version.trim() === latest) {
    return true;
  }
  const order = compareVersions(version, latest);
  return order !== null && order >= 0;
}

/** The marker on a row whose computer runs other active watchers too. */
export interface SharedComputerMarker {
  /** "{N} on this computer", where N counts this watcher as well. */
  label: string;
  /** Names the other watchers on the computer. */
  tooltip: string;
}

/**
 * The marker for a computer that runs `others` as well as this watcher, or
 * null when it runs no other active watcher.
 */
export function sharedComputerMarker(
  others: readonly SharedComputerInstrument[]
): SharedComputerMarker | null {
  if (others.length === 0) {
    return null;
  }
  const names = others.map((other) => other.displayName);
  const tooltip =
    names.length === 1
      ? `This computer also runs the watcher for ${names[0]}.`
      : `This computer also runs the watchers for ${joinNames(names)}.`;
  return { label: `${others.length + 1} on this computer`, tooltip };
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 2) {
    return names.join(" and ");
  }
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

/** A watcher as the shared-computer rule needs it. */
export interface ComputerWatcher {
  /** False for a deregistered watcher. */
  active: boolean;
  displayName: string;
  hostname: string | null;
  id: string;
  instrumentId: string;
}

/**
 * For each active watcher, the other active watchers that report the same
 * hostname. Hostnames compare without case or surrounding spaces, as Windows
 * does, and a blank one names no computer. A deregistered
 * watcher counts for nothing: it neither shares a computer nor is shared. Each
 * list is sorted by instrument name.
 */
export function sharedComputerWithByWatcher(
  rows: readonly ComputerWatcher[]
): Map<string, SharedComputerInstrument[]> {
  const byComputer = new Map<string, ComputerWatcher[]>();
  for (const row of rows) {
    const key = computerKey(row.hostname);
    if (!row.active || key === null) {
      continue;
    }
    const group = byComputer.get(key);
    if (group) {
      group.push(row);
    } else {
      byComputer.set(key, [row]);
    }
  }

  const result = new Map<string, SharedComputerInstrument[]>();
  for (const row of rows) {
    if (!row.active) {
      continue;
    }
    const key = computerKey(row.hostname);
    const others =
      key === null
        ? []
        : (byComputer.get(key) ?? [])
            .filter((other) => other.id !== row.id)
            .map((other) => ({
              instrumentId: other.instrumentId,
              displayName: other.displayName,
            }))
            .sort(compareInstrumentNames);
    result.set(row.id, others);
  }
  return result;
}

/** The column the list is sorted by, or null for the default order. */
export type ComputerSort = "ascending" | "descending" | null;

/** What the sort reads from an active watcher row. */
export interface SortableWatcher {
  hostname: string | null;
  id: string;
  instrumentDisplayName: string | null;
  instrumentId: string;
}

/**
 * The active rows in list order. With no computer sort they go by instrument
 * name. With one, they go by computer name, without case, and a row with no
 * computer name (missing or blank) goes last in either direction. Ties go by instrument name.
 * The input is left as it was.
 */
export function sortActiveWatchers<T extends SortableWatcher>(
  rows: readonly T[],
  computerSort: ComputerSort
): T[] {
  const byInstrument = (a: T, b: T) =>
    compareInstrumentNames(
      { displayName: instrumentLabel(a), instrumentId: a.instrumentId },
      { displayName: instrumentLabel(b), instrumentId: b.instrumentId }
    ) || a.id.localeCompare(b.id);

  if (computerSort === null) {
    return [...rows].sort(byInstrument);
  }

  const direction = computerSort === "ascending" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = a.hostname?.trim() || null;
    const right = b.hostname?.trim() || null;
    if (left === null || right === null) {
      if (left === right) {
        return byInstrument(a, b);
      }
      return left === null ? 1 : -1;
    }
    return direction * naturalCompare(left, right) || byInstrument(a, b);
  });
}

function instrumentLabel(row: SortableWatcher): string {
  return row.instrumentDisplayName ?? row.instrumentId;
}

// Case-insensitive. Numbers compare by value, so "PC-3" sorts before "PC-10".
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}
/** What the Active table reads from a watcher, and what crosses to the client. */
export type ActiveWatcherRow = Pick<
  WatcherRosterItem,
  | "configState"
  | "effectiveStatus"
  | "hostname"
  | "id"
  | "instrumentDisplayName"
  | "instrumentId"
  | "lastHeartbeatAt"
  | "sharedComputerWith"
  | "statusReason"
  | "watcherVersion"
>;

/** What the Deregistered table reads from a watcher. */
export type DeregisteredWatcherRow = Pick<
  WatcherRosterItem,
  | "deregisteredByName"
  | "deletedAt"
  | "hostname"
  | "id"
  | "instrumentDisplayName"
  | "instrumentId"
  | "watcherVersion"
>;

/**
 * Splits the roster into the two tables' rows, with only the fields they use,
 * so the page doesn't send the whole row to the client. The deregistered rows
 * are newest deregistration first, to match their "Deregistered on" column.
 */
export function splitWatcherRoster(roster: readonly WatcherRosterItem[]): {
  active: ActiveWatcherRow[];
  deregistered: DeregisteredWatcherRow[];
} {
  const active: ActiveWatcherRow[] = [];
  const deregistered: DeregisteredWatcherRow[] = [];
  for (const watcher of roster) {
    if (watcher.deletedAt === null) {
      active.push({
        id: watcher.id,
        instrumentId: watcher.instrumentId,
        instrumentDisplayName: watcher.instrumentDisplayName,
        hostname: watcher.hostname,
        watcherVersion: watcher.watcherVersion,
        effectiveStatus: watcher.effectiveStatus,
        statusReason: watcher.statusReason,
        lastHeartbeatAt: watcher.lastHeartbeatAt,
        configState: watcher.configState,
        sharedComputerWith: watcher.sharedComputerWith,
      });
    } else {
      deregistered.push({
        id: watcher.id,
        instrumentId: watcher.instrumentId,
        instrumentDisplayName: watcher.instrumentDisplayName,
        hostname: watcher.hostname,
        watcherVersion: watcher.watcherVersion,
        deletedAt: watcher.deletedAt,
        deregisteredByName: watcher.deregisteredByName,
      });
    }
  }
  deregistered.sort(
    (a, b) => (b.deletedAt?.getTime() ?? 0) - (a.deletedAt?.getTime() ?? 0)
  );
  return { active, deregistered };
}
