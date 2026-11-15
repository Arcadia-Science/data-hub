import { describe, expect, it } from "vitest";
import {
  describeDeregistration,
  selectWatcherRegistration,
  summarizeRegistration,
  type WatcherRegistration,
} from "@/lib/watchers/registrations";

const NOW = new Date("2026-11-14T12:00:00Z");

function registration(
  id: string,
  createdAt: string,
  deletedAt: string | null = null,
  deregisteredByName: string | null = null
): WatcherRegistration {
  return {
    id,
    hostname: `LAB-PC-${id}`,
    createdAt: new Date(createdAt),
    deletedAt: deletedAt ? new Date(deletedAt) : null,
    deregisteredByName,
  };
}

const CURRENT = registration("current", "2026-11-10T09:00:00Z");
const PAST_NEW = registration(
  "past-new",
  "2026-09-01T09:00:00Z",
  "2026-11-10T08:00:00Z",
  "Alice Example"
);
const PAST_OLD = registration(
  "past-old",
  "2026-06-30T09:00:00Z",
  "2026-08-30T08:00:00Z",
  "Alice Example"
);

// One test per row of the spec's past-watcher switcher table.
describe("selectWatcherRegistration", () => {
  it("1 active, 0 past: opens the current watcher and hides the switcher", () => {
    const selection = selectWatcherRegistration([CURRENT], null);
    expect(selection?.selected?.id).toBe("current");
    expect(selection?.isPast).toBe(false);
    expect(selection?.showSwitcher).toBe(false);
  });

  it("1 active, 2 past: opens the current watcher and shows the switcher", () => {
    // Given out of order, to show that the page doesn't rely on it.
    const selection = selectWatcherRegistration(
      [PAST_OLD, CURRENT, PAST_NEW],
      null
    );
    expect(selection?.selected?.id).toBe("current");
    expect(selection?.current?.id).toBe("current");
    expect(selection?.isPast).toBe(false);
    expect(selection?.showSwitcher).toBe(true);
    expect(selection?.registrations.map((r) => r.id)).toEqual([
      "current",
      "past-new",
      "past-old",
    ]);
  });

  it("1 active, 1 past: shows the switcher", () => {
    const selection = selectWatcherRegistration([PAST_NEW, CURRENT], null);
    expect(selection?.selected?.id).toBe("current");
    expect(selection?.showSwitcher).toBe(true);
  });

  it("opens the current watcher even when a past one has a later start date", () => {
    // Registered earlier, still active: the date order doesn't decide it.
    const earlyCurrent = registration("early-current", "2026-01-01T09:00:00Z");
    const selection = selectWatcherRegistration([PAST_NEW, earlyCurrent], null);
    expect(selection?.selected?.id).toBe("early-current");
    expect(selection?.isPast).toBe(false);
  });

  it("0 active, 1 past: opens that past watcher, read-only, with no switcher", () => {
    const selection = selectWatcherRegistration([PAST_NEW], null);
    expect(selection?.selected?.id).toBe("past-new");
    expect(selection?.current).toBeNull();
    expect(selection?.isPast).toBe(true);
    expect(selection?.showSwitcher).toBe(false);
  });

  it("0 active, 2 past: opens the most recent past watcher and shows the switcher", () => {
    const selection = selectWatcherRegistration([PAST_OLD, PAST_NEW], null);
    expect(selection?.selected?.id).toBe("past-new");
    expect(selection?.current).toBeNull();
    expect(selection?.isPast).toBe(true);
    expect(selection?.showSwitcher).toBe(true);
  });

  it("none at all: nothing is selected and the switcher is hidden", () => {
    const selection = selectWatcherRegistration([], null);
    expect(selection?.selected).toBeNull();
    expect(selection?.current).toBeNull();
    expect(selection?.isPast).toBe(false);
    expect(selection?.showSwitcher).toBe(false);
  });

  describe("with ?watcher=", () => {
    it("opens the registration it names, past or current", () => {
      const all = [CURRENT, PAST_NEW, PAST_OLD];
      const past = selectWatcherRegistration(all, "past-old");
      expect(past?.selected?.id).toBe("past-old");
      expect(past?.isPast).toBe(true);
      // The current watcher is still known, for the link back to it.
      expect(past?.current?.id).toBe("current");

      const current = selectWatcherRegistration(all, "current");
      expect(current?.selected?.id).toBe("current");
      expect(current?.isPast).toBe(false);
    });

    it("says it was requested, so the tab links keep the parameter", () => {
      const all = [CURRENT, PAST_NEW];
      expect(selectWatcherRegistration(all, "past-new")?.requested).toBe(true);
      expect(selectWatcherRegistration(all, "current")?.requested).toBe(true);
      expect(selectWatcherRegistration(all, null)?.requested).toBe(false);
      expect(selectWatcherRegistration([], null)?.requested).toBe(false);
    });

    it("compares the ID without case", () => {
      const id = "3F2A9C1E-7B4D-4E0A-9C55-1D2E8F6A7B90";
      const row = registration(id.toLowerCase(), "2026-11-10T09:00:00Z");
      expect(selectWatcherRegistration([row], id)?.selected?.id).toBe(
        id.toLowerCase()
      );
    });

    it("returns null for an ID that isn't one of this instrument's watchers", () => {
      expect(
        selectWatcherRegistration(
          [CURRENT, PAST_NEW],
          "00000000-0000-4000-8000-000000000000"
        )
      ).toBeNull();
      expect(selectWatcherRegistration([], "current")).toBeNull();
      expect(selectWatcherRegistration([CURRENT], "not-a-uuid")).toBeNull();
    });
  });

  it("leaves the list it was given as it was", () => {
    const input = [PAST_OLD, CURRENT, PAST_NEW];
    selectWatcherRegistration(input, null);
    expect(input.map((r) => r.id)).toEqual(["past-old", "current", "past-new"]);
  });
});

describe("summarizeRegistration", () => {
  it("says Current and when the current watcher began", () => {
    expect(summarizeRegistration(CURRENT, "UTC", NOW)).toEqual({
      tag: "Current",
      detail: "Since Nov 10",
    });
  });

  it("gives a past watcher's dates and who deregistered it", () => {
    expect(summarizeRegistration(PAST_OLD, "UTC", NOW)).toEqual({
      tag: null,
      detail: "Jun 30 to Aug 30 · deregistered by Alice Example",
    });
  });

  it("leaves out who when it wasn't recorded, and adds the year for another year", () => {
    const unknown = registration(
      "x",
      "2025-12-30T09:00:00Z",
      "2026-01-05T09:00:00Z"
    );
    expect(summarizeRegistration(unknown, "UTC", NOW).detail).toBe(
      "Dec 30, 2025 to Jan 5"
    );
  });
});

describe("describeDeregistration", () => {
  it("names the date and the person", () => {
    expect(describeDeregistration(PAST_NEW, "UTC", NOW)).toBe(
      "It was deregistered on Nov 10 by Alice Example."
    );
  });

  it("leaves out the person when no one was recorded", () => {
    const unknown = registration(
      "x",
      "2026-06-01T09:00:00Z",
      "2026-11-10T09:00:00Z"
    );
    expect(describeDeregistration(unknown, "UTC", NOW)).toBe(
      "It was deregistered on Nov 10."
    );
  });
});
