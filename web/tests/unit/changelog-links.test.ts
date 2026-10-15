import { describe, expect, it } from "vitest";
import { listChangelogEntries } from "@/lib/changelog/entries";
import { initialExpandedIds } from "@/lib/changelog/expanded";
import { changelogEntryPath } from "@/lib/changelog/href";

const IDS = [
  "2026-10-14-newest",
  "2026-10-09-second",
  "2026-10-08-third",
  "2026-10-07-oldest",
];

const none = new Set<string>();

describe("changelogEntryPath", () => {
  it("puts the entry ID in the changelog parameter of the home page", () => {
    expect(changelogEntryPath("2026-10-08-hina-large-image-previews")).toBe(
      "/?changelog=2026-10-08-hina-large-image-previews"
    );
  });

  it("builds a link that survives a real entry ID", () => {
    for (const entry of listChangelogEntries()) {
      const url = new URL(changelogEntryPath(entry.id), "https://example.com");
      expect(url.pathname).toBe("/");
      expect(url.searchParams.get("changelog")).toBe(entry.id);
    }
  });
});

describe("initialExpandedIds", () => {
  it("opens only the linked entry, even when others are new", () => {
    expect(
      initialExpandedIds({
        ids: IDS,
        linkedId: "2026-10-08-third",
        unseenIds: new Set(["2026-10-14-newest", "2026-10-09-second"]),
      })
    ).toEqual(["2026-10-08-third"]);
  });

  it("opens every new entry when some, but not all, are new", () => {
    expect(
      initialExpandedIds({
        ids: IDS,
        linkedId: null,
        unseenIds: new Set(["2026-10-14-newest", "2026-10-08-third"]),
      })
    ).toEqual(["2026-10-14-newest", "2026-10-08-third"]);
  });

  it("opens only the newest entry when nothing is new", () => {
    expect(
      initialExpandedIds({ ids: IDS, linkedId: null, unseenIds: none })
    ).toEqual(["2026-10-14-newest"]);
  });

  it("opens only the newest entry when every entry is new, as on a first visit", () => {
    expect(
      initialExpandedIds({
        ids: IDS,
        linkedId: null,
        unseenIds: new Set(IDS),
      })
    ).toEqual(["2026-10-14-newest"]);
  });

  it("falls back to the new entries when the link names an entry that does not exist", () => {
    expect(
      initialExpandedIds({
        ids: IDS,
        linkedId: "2026-01-01-missing",
        unseenIds: new Set(["2026-10-09-second"]),
      })
    ).toEqual(["2026-10-09-second"]);
  });

  it("keeps the order of the list, newest first", () => {
    const unseen = new Set(["2026-10-07-oldest", "2026-10-09-second"]);
    expect(
      initialExpandedIds({ ids: IDS, linkedId: null, unseenIds: unseen })
    ).toEqual(["2026-10-09-second", "2026-10-07-oldest"]);
  });

  it("opens the one entry of a one-entry changelog", () => {
    expect(
      initialExpandedIds({
        ids: ["2026-10-14-only"],
        linkedId: null,
        unseenIds: new Set(["2026-10-14-only"]),
      })
    ).toEqual(["2026-10-14-only"]);
  });

  it("opens nothing when there are no entries", () => {
    expect(
      initialExpandedIds({ ids: [], linkedId: null, unseenIds: none })
    ).toEqual([]);
  });
});
