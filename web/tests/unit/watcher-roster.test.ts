import { describe, expect, it } from "vitest";
import type { WatcherRosterItem } from "@/lib/api/watcher-roster";
import {
  type ComputerWatcher,
  rolloutPill,
  type SortableWatcher,
  sharedComputerMarker,
  sharedComputerWithByWatcher,
  sortActiveWatchers,
  splitWatcherRoster,
} from "@/lib/watchers/roster";

describe("rolloutPill", () => {
  it("is green when every active watcher is on the latest version", () => {
    expect(
      rolloutPill({
        activeVersions: ["1.4.2", "1.4.2", "1.4.2"],
        latestVersion: "1.4.2",
      })
    ).toEqual({ text: "3 of 3 on 1.4.2", tone: "current" });
  });

  it("is amber when some active watchers are behind", () => {
    expect(
      rolloutPill({
        activeVersions: ["1.4.2", "1.4.1", "1.4.2"],
        latestVersion: "1.4.2",
      })
    ).toEqual({ text: "2 of 3 on 1.4.2", tone: "behind" });
  });

  it("counts a watcher with no version as behind", () => {
    expect(
      rolloutPill({ activeVersions: [null, "1.4.2"], latestVersion: "1.4.2" })
    ).toEqual({ text: "1 of 2 on 1.4.2", tone: "behind" });
  });

  it("counts a watcher ahead of the latest version as current", () => {
    // After a rollback (latest 1.4.2 down to 1.4.1) a watcher never
    // downgrades, so the ones that already updated stay on the latest.
    expect(
      rolloutPill({
        activeVersions: ["1.4.2", "1.4.1", "1.4.1"],
        latestVersion: "1.4.1",
      })
    ).toEqual({ text: "3 of 3 on 1.4.1", tone: "current" });
    expect(
      rolloutPill({
        activeVersions: ["1.5.0", "1.4.0"],
        latestVersion: "1.4.2",
      })
    ).toEqual({ text: "1 of 2 on 1.4.2", tone: "behind" });
  });

  it("counts a version that can't be compared as behind unless it matches", () => {
    expect(
      rolloutPill({
        activeVersions: ["dev-build", "", "1.4.2"],
        latestVersion: "1.4.2",
      })
    ).toEqual({ text: "1 of 3 on 1.4.2", tone: "behind" });
    expect(
      rolloutPill({ activeVersions: [" 1.4.2 "], latestVersion: "1.4.2" })
    ).toEqual({ text: "1 of 1 on 1.4.2", tone: "current" });
  });

  it("is hidden when no latest version is set", () => {
    expect(
      rolloutPill({ activeVersions: ["1.4.2"], latestVersion: null })
    ).toBeNull();
    expect(
      rolloutPill({ activeVersions: ["1.4.2"], latestVersion: "  " })
    ).toBeNull();
  });

  it("is hidden when there are no active watchers to roll out to", () => {
    expect(
      rolloutPill({ activeVersions: [], latestVersion: "1.4.2" })
    ).toBeNull();
  });

  it("reads the same for one watcher", () => {
    expect(
      rolloutPill({ activeVersions: ["1.4.2"], latestVersion: "1.4.2" })
    ).toEqual({ text: "1 of 1 on 1.4.2", tone: "current" });
    expect(
      rolloutPill({ activeVersions: ["1.4.1"], latestVersion: "1.4.2" })
    ).toEqual({ text: "0 of 1 on 1.4.2", tone: "behind" });
  });
});

describe("sharedComputerMarker", () => {
  it("is null when the computer runs no other active watcher", () => {
    expect(sharedComputerMarker([])).toBeNull();
  });

  it("counts this watcher too, and names the one other", () => {
    expect(
      sharedComputerMarker([
        { instrumentId: "plate-b", displayName: "Plate B" },
      ])
    ).toEqual({
      label: "2 on this computer",
      tooltip: "This computer also runs the watcher for Plate B.",
    });
  });

  it("names two others with 'and'", () => {
    expect(
      sharedComputerMarker([
        { instrumentId: "plate-b", displayName: "Plate B" },
        { instrumentId: "scanner-c", displayName: "Scanner C" },
      ])
    ).toEqual({
      label: "3 on this computer",
      tooltip:
        "This computer also runs the watchers for Plate B and Scanner C.",
    });
  });

  it("lists three or more others, and counts them all", () => {
    expect(
      sharedComputerMarker([
        { instrumentId: "a", displayName: "Alpha" },
        { instrumentId: "b", displayName: "Beta" },
        { instrumentId: "c", displayName: "Gamma" },
      ])
    ).toEqual({
      label: "4 on this computer",
      tooltip:
        "This computer also runs the watchers for Alpha, Beta, and Gamma.",
    });
  });
});

function watcher(
  id: string,
  instrumentId: string,
  hostname: string | null,
  options: { active?: boolean; displayName?: string } = {}
): ComputerWatcher {
  return {
    id,
    instrumentId,
    displayName: options.displayName ?? instrumentId,
    hostname,
    active: options.active ?? true,
  };
}

describe("sharedComputerWithByWatcher", () => {
  it("pairs active watchers whose hostnames differ only in case", () => {
    const shared = sharedComputerWithByWatcher([
      watcher("w1", "plate-reader-beta", "LAB-PC-01", {
        displayName: "Plate Reader Beta",
      }),
      watcher("w2", "incubator-gamma", "lab-pc-01", {
        displayName: "Incubator Gamma",
      }),
    ]);
    expect(shared.get("w1")).toEqual([
      { instrumentId: "incubator-gamma", displayName: "Incubator Gamma" },
    ]);
    expect(shared.get("w2")).toEqual([
      { instrumentId: "plate-reader-beta", displayName: "Plate Reader Beta" },
    ]);
  });

  it("leaves a computer with one active watcher alone", () => {
    const shared = sharedComputerWithByWatcher([
      watcher("w1", "plate-delta", "LAB-PC-09"),
    ]);
    expect(shared.get("w1")).toEqual([]);
  });

  it("ignores deregistered watchers, both as sharers and as shared", () => {
    const shared = sharedComputerWithByWatcher([
      watcher("w1", "plate-a", "LAB-PC-02"),
      watcher("w2", "plate-b", "LAB-PC-02", { active: false }),
    ]);
    expect(shared.get("w1")).toEqual([]);
    expect(shared.has("w2")).toBe(false);
  });

  it("gives a watcher with no hostname nothing shared", () => {
    const shared = sharedComputerWithByWatcher([
      watcher("w1", "plate-a", null),
      watcher("w2", "plate-b", null),
    ]);
    expect(shared.get("w1")).toEqual([]);
    expect(shared.get("w2")).toEqual([]);
  });

  it("treats a blank hostname as missing, so blank ones don't pair up", () => {
    const shared = sharedComputerWithByWatcher([
      watcher("w1", "plate-a", ""),
      watcher("w2", "plate-b", "   "),
      watcher("w3", "plate-c", ""),
    ]);
    expect(shared.get("w1")).toEqual([]);
    expect(shared.get("w2")).toEqual([]);
    expect(shared.get("w3")).toEqual([]);
  });

  it("pairs hostnames that differ only in surrounding spaces", () => {
    const shared = sharedComputerWithByWatcher([
      watcher("w1", "plate-a", "LAB-PC-04 "),
      watcher("w2", "plate-b", " lab-pc-04"),
    ]);
    expect(shared.get("w1")?.map((other) => other.instrumentId)).toEqual([
      "plate-b",
    ]);
  });

  it("sorts numbers in instrument names by value", () => {
    const numbered = sharedComputerWithByWatcher([
      watcher("w1", "reader-1", "PC-8", { displayName: "Reader 1" }),
      watcher("w2", "reader-10", "PC-8", { displayName: "Reader 10" }),
      watcher("w3", "reader-2", "PC-8", { displayName: "Reader 2" }),
    ]);
    expect(numbered.get("w1")?.map((other) => other.displayName)).toEqual([
      "Reader 2",
      "Reader 10",
    ]);
  });

  it("sorts each list by instrument name", () => {
    const shared = sharedComputerWithByWatcher([
      watcher("w1", "z-plate", "PC-7", { displayName: "Zeta Plate" }),
      watcher("w2", "a-scanner", "pc-7", { displayName: "Alpha Scanner" }),
      watcher("w3", "m-gel", "PC-7", { displayName: "Mid Gel" }),
    ]);
    expect(shared.get("w1")?.map((other) => other.displayName)).toEqual([
      "Alpha Scanner",
      "Mid Gel",
    ]);
  });
});

function row(
  id: string,
  instrumentDisplayName: string | null,
  hostname: string | null
): SortableWatcher & { label: string } {
  return {
    id,
    instrumentId: id,
    instrumentDisplayName,
    hostname,
    label: id,
  };
}

describe("sortActiveWatchers", () => {
  // By instrument name the order is delta, zeta, alpha, epsilon. By computer
  // name, ascending it is zeta (pc-3), alpha (PC-10), delta (PC-20), and
  // descending it is delta, alpha, zeta. Epsilon has no computer name.
  const rows = [
    row("delta", "Balance Delta", "PC-20"),
    row("alpha", "Plate Reader Alpha", "PC-10"),
    row("epsilon", "Scanner Epsilon", null),
    row("zeta", "Imager Zeta", "pc-3"),
  ];

  it("sorts by instrument name when no column is sorted", () => {
    expect(sortActiveWatchers(rows, null).map((r) => r.label)).toEqual([
      "delta",
      "zeta",
      "alpha",
      "epsilon",
    ]);
  });

  it("sorts by computer name ascending, without case, with nameless computers last", () => {
    expect(sortActiveWatchers(rows, "ascending").map((r) => r.label)).toEqual([
      "zeta",
      "alpha",
      "delta",
      "epsilon",
    ]);
  });

  it("sorts by computer name descending, and still puts nameless computers last", () => {
    expect(sortActiveWatchers(rows, "descending").map((r) => r.label)).toEqual([
      "delta",
      "alpha",
      "zeta",
      "epsilon",
    ]);
  });

  it("treats a blank computer name as missing and sorts it last", () => {
    const blank = [
      row("blank", "Alpha", "  "),
      row("empty", "Beta", ""),
      row("named", "Gamma", "PC-1"),
    ];
    expect(sortActiveWatchers(blank, "ascending").map((r) => r.label)).toEqual([
      "named",
      "blank",
      "empty",
    ]);
    expect(sortActiveWatchers(blank, "descending").map((r) => r.label)).toEqual(
      ["named", "blank", "empty"]
    );
  });

  it("breaks a tie between computers by instrument name", () => {
    const tied = [row("w-b", "Beta", "PC-1"), row("w-a", "Alpha", "pc-1")];
    expect(sortActiveWatchers(tied, "ascending").map((r) => r.label)).toEqual([
      "w-a",
      "w-b",
    ]);
  });

  it("leaves the input as it was", () => {
    const before = rows.map((r) => r.label);
    sortActiveWatchers(rows, "ascending");
    expect(rows.map((r) => r.label)).toEqual(before);
  });
});

describe("splitWatcherRoster", () => {
  const base = {
    configState: "none" as const,
    deregisteredByName: null,
    effectiveStatus: "online" as const,
    hostname: "PC-1",
    instrumentDisplayName: "Plate Reader A",
    instrumentId: "plate-a",
    lastHeartbeatAt: null,
    sharedComputerWith: [],
    statusReason: null,
    watcherVersion: "1.4.2",
  };
  const asItem = (value: object) => value as unknown as WatcherRosterItem;

  it("sends only the fields each table uses", () => {
    const { active, deregistered } = splitWatcherRoster([
      // Fields the tables don't read must not cross to the client.
      asItem({ ...base, id: "w1", deletedAt: null, configRevision: 3 }),
      asItem({
        ...base,
        id: "w2",
        deletedAt: new Date("2026-02-01T00:00:00Z"),
        configRevision: 4,
      }),
    ]);
    expect(Object.keys(active[0]).sort()).toEqual([
      "configState",
      "effectiveStatus",
      "hostname",
      "id",
      "instrumentDisplayName",
      "instrumentId",
      "lastHeartbeatAt",
      "sharedComputerWith",
      "statusReason",
      "watcherVersion",
    ]);
    expect(Object.keys(deregistered[0]).sort()).toEqual([
      "deletedAt",
      "deregisteredByName",
      "hostname",
      "id",
      "instrumentDisplayName",
      "instrumentId",
      "watcherVersion",
    ]);
  });

  it("lists deregistered watchers newest deregistration first", () => {
    const at = (day: number) => new Date(Date.UTC(2026, 0, day));
    const { deregistered } = splitWatcherRoster(
      [
        { id: "old", deletedAt: at(2) },
        { id: "newest", deletedAt: at(20) },
        { id: "middle", deletedAt: at(10) },
      ].map((item) => asItem({ ...base, ...item }))
    );
    expect(deregistered.map((watcher) => watcher.id)).toEqual([
      "newest",
      "middle",
      "old",
    ]);
  });
});
