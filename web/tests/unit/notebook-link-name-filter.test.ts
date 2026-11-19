import { describe, expect, it } from "vitest";
import { parseNotebookLinkNameParams } from "@/lib/api/validators";
import {
  buildNotebookLinkNameOptions,
  countRunsWithNameContaining,
  matchingLinkFirst,
  notebookLinkFilterParams,
  notebookLinkNameContains,
  notebookLinkNameMatches,
  readNotebookLinkFilter,
} from "@/lib/notebook-links/name-filter";

// The "Lab Notebook" column's menu lists link names with run counts, and the
// run list query filters with the same matching rules.

const links = [
  { runId: "r1", name: "Growth curve method" },
  { runId: "r1", name: "Yeast growth curves" },
  { runId: "r2", name: "Growth curve method" },
  { runId: "r3", name: "Growth curve method" },
  { runId: "r4", name: "Bradford, post-elution" },
  { runId: "r5", name: "notion.so › OD600 regression" },
  { runId: "r5", name: "Bradford, post-elution" },
];

describe("buildNotebookLinkNameOptions", () => {
  it("counts runs per name, most-used first, then by name", () => {
    const options = buildNotebookLinkNameOptions(links);
    expect(options.names).toEqual([
      { name: "Growth curve method", runCount: 3 },
      { name: "Bradford, post-elution", runCount: 2 },
      { name: "notion.so › OD600 regression", runCount: 1 },
      { name: "Yeast growth curves", runCount: 1 },
    ]);
  });

  it("counts a run once when two of its links share a name", () => {
    const options = buildNotebookLinkNameOptions([
      { runId: "r1", name: "Plate map" },
      { runId: "r1", name: "Plate map" },
    ]);
    expect(options.names).toEqual([{ name: "Plate map", runCount: 1 }]);
    expect(options.sharedRuns).toEqual([]);
  });

  it("records the names of runs that have more than one", () => {
    const options = buildNotebookLinkNameOptions(links);
    // r1: Growth curve method (0), Yeast growth curves (3).
    // r5: Bradford (1), notion.so › OD600 regression (2).
    expect(options.sharedRuns).toEqual([
      [0, 3],
      [1, 2],
    ]);
  });
});

describe("countRunsWithNameContaining", () => {
  const options = buildNotebookLinkNameOptions(links);

  it("counts a run once even when several of its names match", () => {
    // r1 matches twice, r2 and r3 once each.
    expect(countRunsWithNameContaining(options, "growth")).toBe(3);
  });

  it("ignores case and surrounding spaces", () => {
    expect(countRunsWithNameContaining(options, "  BRADFORD ")).toBe(2);
  });

  it("is zero when nothing matches or the text is blank", () => {
    expect(countRunsWithNameContaining(options, "pombe")).toBe(0);
    expect(countRunsWithNameContaining(options, "   ")).toBe(0);
  });
});

describe("notebookLinkNameMatches", () => {
  it("matches an exact name, case and all", () => {
    expect(notebookLinkNameMatches("Plate map", { name: "Plate map" })).toBe(
      true
    );
    expect(notebookLinkNameMatches("Plate map", { name: "plate map" })).toBe(
      false
    );
  });

  it("matches text a name contains", () => {
    expect(notebookLinkNameContains("Yeast growth curves", "GROWTH")).toBe(
      true
    );
    expect(
      notebookLinkNameMatches("Yeast growth curves", { search: "curve" })
    ).toBe(true);
    expect(notebookLinkNameMatches("Plate map", { search: "curve" })).toBe(
      false
    );
  });
});

describe("matchingLinkFirst", () => {
  const runLinks = [
    { display_name: "Plate map" },
    { display_name: "Yeast growth curves" },
    { display_name: "Growth curve method" },
  ];

  it("moves the first matching link to the front", () => {
    expect(
      matchingLinkFirst(runLinks, { name: "Growth curve method" }).map(
        (link) => link.display_name
      )
    ).toEqual(["Growth curve method", "Plate map", "Yeast growth curves"]);
    expect(
      matchingLinkFirst(runLinks, { search: "growth" }).map(
        (link) => link.display_name
      )
    ).toEqual(["Yeast growth curves", "Plate map", "Growth curve method"]);
  });

  it("keeps the order when there's no name filter or no match", () => {
    expect(matchingLinkFirst(runLinks, {})).toBe(runLinks);
    expect(matchingLinkFirst(runLinks, { search: "pombe" })).toBe(runLinks);
  });
});

describe("the filter's URL params", () => {
  it("round-trips every filter", () => {
    for (const filter of [
      { kind: "all" },
      { kind: "has_link" },
      { kind: "no_link" },
      { kind: "name", name: "Plate map" },
      { kind: "search", text: "plate" },
    ] as const) {
      expect(readNotebookLinkFilter(notebookLinkFilterParams(filter))).toEqual(
        filter
      );
    }
  });

  it("clears the other params when one filter is picked", () => {
    expect(
      notebookLinkFilterParams({ kind: "name", name: "Plate map" })
    ).toEqual({
      has_notebook_link: null,
      notebook_link_name: "Plate map",
      notebook_link_search: null,
    });
  });

  it("reads blank params as no filter on the server", () => {
    expect(parseNotebookLinkNameParams({ name: " ", search: "" })).toEqual({});
    expect(
      parseNotebookLinkNameParams({ name: "Plate map", search: " grow " })
    ).toEqual({ notebookLinkName: "Plate map", notebookLinkSearch: "grow" });
  });
});
