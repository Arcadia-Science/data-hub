import { describe, expect, it } from "vitest";
import {
  WATCHER_VERSION_HEADER,
  watcherClientFrom,
} from "@/lib/api/watcher-compat";
import {
  compareVersions,
  isAtLeast,
  isBelowFloor,
} from "@/lib/api/watcher-versions";

function requestWith(version: string | null): Request {
  const headers = new Headers();
  if (version !== null) {
    headers.set(WATCHER_VERSION_HEADER, version);
  }
  return new Request("http://localhost/api/v1", { headers });
}

describe("compareVersions", () => {
  it("orders release versions by their numeric parts", () => {
    expect(compareVersions("1.0.2", "1.1.0")).toBe(-1);
    expect(compareVersions("1.1.0", "1.1.0")).toBe(0);
    expect(compareVersions("1.2.0", "1.1.0")).toBe(1);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
  });

  it("sorts a release above a pre-release of the same numbers", () => {
    expect(compareVersions("1.1.0rc1", "1.1.0")).toBe(-1);
    expect(compareVersions("1.1.0", "1.1.0rc1")).toBe(1);
  });

  it("returns null when either side is missing or unreadable", () => {
    expect(compareVersions(null, "1.1.0")).toBeNull();
    expect(compareVersions("1.1.0", undefined)).toBeNull();
    expect(compareVersions("not-a-version", "1.1.0")).toBeNull();
    expect(compareVersions("0.0.0+unknown", "1.1.0")).toBeNull();
  });
});

describe("isBelowFloor", () => {
  it("is true only when the reported version is strictly older", () => {
    expect(isBelowFloor("0.5.0", "1.0.0")).toBe(true);
    expect(isBelowFloor("1.0.0", "1.0.0")).toBe(false);
    expect(isBelowFloor("2.0.0", "1.0.0")).toBe(false);
  });

  it("treats a pre-release as older than the release of the same numbers", () => {
    expect(isBelowFloor("1.1.0rc1", "1.1.0")).toBe(true);
    expect(isAtLeast("1.1.0.post1", "1.1.0")).toBe(false);
  });

  it("treats a missing or unreadable version as not below the floor", () => {
    expect(isBelowFloor(null, "1.0.0")).toBe(false);
    expect(isBelowFloor(undefined, "1.0.0")).toBe(false);
    expect(isBelowFloor("not-a-version", "1.0.0")).toBe(false);
    expect(isBelowFloor("1.0.0", null)).toBe(false);
  });
});

describe("isAtLeast", () => {
  it("requires a readable version at or above the minimum", () => {
    expect(isAtLeast("1.1.0", "1.1.0")).toBe(true);
    expect(isAtLeast("1.2.0", "1.1.0")).toBe(true);
    expect(isAtLeast("1.0.2", "1.1.0")).toBe(false);
    expect(isAtLeast("1.1.0rc1", "1.1.0")).toBe(false);
  });

  it("returns false for a missing or unreadable version", () => {
    expect(isAtLeast(null, "1.1.0")).toBe(false);
    expect(isAtLeast("   ", "1.1.0")).toBe(false);
    expect(isAtLeast("0.0.0+unknown", "1.1.0")).toBe(false);
  });
});

describe("watcherClientFrom", () => {
  it("treats a missing or blank header as a legacy watcher", () => {
    expect(requestSupports(null)).toBe(false);
    expect(watcherClientFrom(requestWith("   ")).version).toBeNull();
    expect(
      watcherClientFrom(requestWith("not-a-version")).supports(
        "renameDuplicateFilenames"
      )
    ).toBe(false);
  });

  it("enables renaming once the watcher reports 1.1.0 or newer", () => {
    expect(requestSupports("1.0.2")).toBe(false);
    expect(requestSupports("1.1.0rc1")).toBe(false);
    expect(requestSupports("1.1.0")).toBe(true);
    expect(requestSupports("1.2.0")).toBe(true);
  });
});

function requestSupports(version: string | null): boolean {
  return watcherClientFrom(requestWith(version)).supports(
    "renameDuplicateFilenames"
  );
}
