// What the Settings › Watchers list says and how it orders its rows: the rollout
// pill, the marker for a computer that runs several watchers, and the sort of
// the active rows. No database imports, so the page, the list and the unit
// tests share one definition.

import type { SharedComputerInstrument } from "@/lib/instruments/connection";

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
 * watcher that reports no version counts as behind.
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
  const onLatest = input.activeVersions.filter(
    (version) => version?.trim() === latest
  ).length;
  return {
    text: `${onLatest} of ${total} on ${latest}`,
    tone: onLatest === total ? "current" : "behind",
  };
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
 * hostname. Hostnames compare without case, as Windows does. A deregistered
 * watcher counts for nothing: it neither shares a computer nor is shared. Each
 * list is sorted by instrument name.
 */
export function sharedComputerWithByWatcher(
  rows: readonly ComputerWatcher[]
): Map<string, SharedComputerInstrument[]> {
  const byComputer = new Map<string, ComputerWatcher[]>();
  for (const row of rows) {
    const key = computerKey(row);
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
    const key = computerKey(row);
    const others =
      key === null
        ? []
        : (byComputer.get(key) ?? [])
            .filter((other) => other.id !== row.id)
            .map((other) => ({
              instrumentId: other.instrumentId,
              displayName: other.displayName,
            }))
            .sort(
              (a, b) =>
                naturalCompare(a.displayName, b.displayName) ||
                a.instrumentId.localeCompare(b.instrumentId)
            );
    result.set(row.id, others);
  }
  return result;
}

function computerKey(row: Pick<ComputerWatcher, "hostname">): string | null {
  return row.hostname === null ? null : row.hostname.toLowerCase();
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
 * computer name goes last in either direction. Ties go by instrument name.
 * The input is left as it was.
 */
export function sortActiveWatchers<T extends SortableWatcher>(
  rows: readonly T[],
  computerSort: ComputerSort
): T[] {
  const byInstrument = (a: T, b: T) =>
    naturalCompare(instrumentLabel(a), instrumentLabel(b)) ||
    a.id.localeCompare(b.id);

  if (computerSort === null) {
    return [...rows].sort(byInstrument);
  }

  const direction = computerSort === "ascending" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (a.hostname === null || b.hostname === null) {
      if (a.hostname === b.hostname) {
        return byInstrument(a, b);
      }
      return a.hostname === null ? 1 : -1;
    }
    return (
      direction * naturalCompare(a.hostname, b.hostname) || byInstrument(a, b)
    );
  });
}

function instrumentLabel(row: SortableWatcher): string {
  return row.instrumentDisplayName ?? row.instrumentId;
}

// Case-insensitive. Numbers compare by value, so "PC-3" sorts before "PC-10".
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}
