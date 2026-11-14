import { describe, expect, it } from "vitest";
import {
  isWatcherId,
  isWatcherPagePath,
  legacyWatcherRedirect,
  legacyWatchersRedirect,
  watcherPageHref,
} from "@/lib/watchers/routes";

const WATCHER_ID = "3f2a9c1e-7b4d-4e0a-9c55-1d2e8f6a7b90";

describe("watcherPageHref", () => {
  it("builds each sub-tab's path", () => {
    expect(watcherPageHref("plate-reader-a")).toBe(
      "/instruments/plate-reader-a/watcher"
    );
    expect(watcherPageHref("plate-reader-a", { tab: "health" })).toBe(
      "/instruments/plate-reader-a/watcher/health"
    );
    expect(watcherPageHref("plate-reader-a", { tab: "settings" })).toBe(
      "/instruments/plate-reader-a/watcher/settings"
    );
  });

  it("keeps ?watcher= and ?focus=, and encodes the instrument ID once", () => {
    expect(
      watcherPageHref("plate-reader-a", {
        tab: "health",
        watcherId: WATCHER_ID,
      })
    ).toBe(`/instruments/plate-reader-a/watcher/health?watcher=${WATCHER_ID}`);
    expect(
      watcherPageHref("plate-reader-a", {
        tab: "settings",
        focus: "watch_directory",
      })
    ).toBe(
      "/instruments/plate-reader-a/watcher/settings?focus=watch_directory"
    );
    expect(watcherPageHref("a b/c")).toBe("/instruments/a%20b%2Fc/watcher");
  });
});

// One test per row of the spec's redirect table that starts at /watchers/<id>.
describe("legacyWatcherRedirect", () => {
  const base = { instrumentId: "plate-reader-a", watcherId: WATCHER_ID };

  it("/watchers/<id> for an active watcher goes to the instrument's watcher page", () => {
    expect(
      legacyWatcherRedirect({ ...base, deregistered: false, tab: null })
    ).toBe("/instruments/plate-reader-a/watcher");
  });

  it("/watchers/<id> for a deregistered watcher goes to its ?watcher= page", () => {
    expect(
      legacyWatcherRedirect({ ...base, deregistered: true, tab: null })
    ).toBe(`/instruments/plate-reader-a/watcher?watcher=${WATCHER_ID}`);
  });

  it("?tab=logs goes to Activity", () => {
    expect(
      legacyWatcherRedirect({ ...base, deregistered: false, tab: "logs" })
    ).toBe("/instruments/plate-reader-a/watcher");
  });

  it("?tab=status goes to Health", () => {
    expect(
      legacyWatcherRedirect({ ...base, deregistered: false, tab: "status" })
    ).toBe("/instruments/plate-reader-a/watcher/health");
  });

  it("?tab=configuration goes to Settings", () => {
    expect(
      legacyWatcherRedirect({
        ...base,
        deregistered: false,
        tab: "configuration",
      })
    ).toBe("/instruments/plate-reader-a/watcher/settings");
  });

  it("keeps ?watcher= on every tab of a deregistered watcher", () => {
    expect(
      legacyWatcherRedirect({ ...base, deregistered: true, tab: "status" })
    ).toBe(`/instruments/plate-reader-a/watcher/health?watcher=${WATCHER_ID}`);
    expect(
      legacyWatcherRedirect({
        ...base,
        deregistered: true,
        tab: "configuration",
      })
    ).toBe(
      `/instruments/plate-reader-a/watcher/settings?watcher=${WATCHER_ID}`
    );
  });

  it("opens Activity for a tab the old page never had", () => {
    for (const tab of ["", "nope", "constructor", "__proto__"]) {
      expect(legacyWatcherRedirect({ ...base, deregistered: false, tab })).toBe(
        "/instruments/plate-reader-a/watcher"
      );
    }
  });
});

describe("isWatcherPagePath", () => {
  it.each([
    "/instruments/plate-reader-a/watcher",
    "/instruments/plate-reader-a/watcher/health",
    "/instruments/plate-reader-a/watcher/settings",
    "/instruments/plate-reader-a/watcher/",
  ])("is true for %s", (path) => {
    expect(isWatcherPagePath(path)).toBe(true);
  });

  it.each([
    "/instruments",
    "/instruments/plate-reader-a",
    "/instruments/plate-reader-a/runs/run-1",
    "/instruments/plate-reader-a/watchers",
    "/instruments/plate-reader-a/watcher-notes",
    "/watchers/abc",
  ])("is false for %s", (path) => {
    expect(isWatcherPagePath(path)).toBe(false);
  });
});

describe("isWatcherId", () => {
  it("accepts a UUID, in either case", () => {
    expect(isWatcherId(WATCHER_ID)).toBe(true);
    expect(isWatcherId(WATCHER_ID.toUpperCase())).toBe(true);
  });

  it.each([
    "",
    "not-a-uuid",
    "3f2a9c1e7b4d4e0a9c551d2e8f6a7b90",
    `${WATCHER_ID}x`,
    ` ${WATCHER_ID}`,
  ])("rejects %j", (value) => {
    expect(isWatcherId(value)).toBe(false);
  });
});

// The old `/watchers` list: admins go to Settings › Watchers, members to the
// instruments, and only the Deregistered tab's parameter is kept.
describe("legacyWatchersRedirect", () => {
  it("sends an admin to Settings › Watchers", () => {
    expect(legacyWatchersRedirect({ isAdmin: true, tab: null })).toBe(
      "/settings/watchers"
    );
  });

  it("keeps ?tab=deregistered for an admin", () => {
    expect(legacyWatchersRedirect({ isAdmin: true, tab: "deregistered" })).toBe(
      "/settings/watchers?tab=deregistered"
    );
  });

  it("drops any other ?tab= value for an admin", () => {
    expect(legacyWatchersRedirect({ isAdmin: true, tab: "active" })).toBe(
      "/settings/watchers"
    );
    expect(legacyWatchersRedirect({ isAdmin: true, tab: "nonsense" })).toBe(
      "/settings/watchers"
    );
  });

  it("sends a member to the instruments, with or without the tab", () => {
    expect(legacyWatchersRedirect({ isAdmin: false, tab: null })).toBe(
      "/instruments"
    );
    expect(
      legacyWatchersRedirect({ isAdmin: false, tab: "deregistered" })
    ).toBe("/instruments");
  });
});
