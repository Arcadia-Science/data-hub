import { describe, expect, it } from "vitest";
import {
  matchingNotebookFirst,
  type NotebookFilter,
  narrowNotebookOptions,
  notebookFilterParams,
  readNotebookFilter,
} from "@/lib/runs/notebook-filter";

const NOTEBOOK_A = "00000000-0000-4000-8000-00000000000a";
const NOTEBOOK_B = "00000000-0000-4000-8000-00000000000b";
const NOTEBOOK_C = "00000000-0000-4000-8000-00000000000c";

describe("readNotebookFilter", () => {
  it("reads every filter the menu can set", () => {
    expect(
      readNotebookFilter({ has_notebook: null, notebook_id: null })
    ).toEqual({ kind: "all" });
    expect(
      readNotebookFilter({ has_notebook: "true", notebook_id: null })
    ).toEqual({ kind: "has_notebook" });
    expect(
      readNotebookFilter({ has_notebook: "false", notebook_id: null })
    ).toEqual({ kind: "no_notebook" });
    expect(
      readNotebookFilter({ has_notebook: null, notebook_id: NOTEBOOK_A })
    ).toEqual({ kind: "notebook", id: NOTEBOOK_A });
  });

  it("shows the notebook as picked when a hand-edited URL sets both", () => {
    expect(
      readNotebookFilter({ has_notebook: "false", notebook_id: NOTEBOOK_A })
    ).toEqual({ kind: "notebook", id: NOTEBOOK_A });
  });

  it("ignores a blank notebook ID", () => {
    expect(
      readNotebookFilter({ has_notebook: "true", notebook_id: "  " })
    ).toEqual({ kind: "has_notebook" });
  });
});

describe("notebookFilterParams", () => {
  it.each<NotebookFilter>([
    { kind: "all" },
    { kind: "has_notebook" },
    { kind: "no_notebook" },
    { kind: "notebook", id: NOTEBOOK_B },
  ])("round-trips $kind through the URL params", (filter) => {
    expect(readNotebookFilter(notebookFilterParams(filter))).toEqual(filter);
  });

  it("clears the param the filter doesn't use", () => {
    expect(notebookFilterParams({ kind: "notebook", id: NOTEBOOK_B })).toEqual({
      has_notebook: null,
      notebook_id: NOTEBOOK_B,
    });
    expect(notebookFilterParams({ kind: "no_notebook" })).toEqual({
      has_notebook: "false",
      notebook_id: null,
    });
    expect(notebookFilterParams({ kind: "all" })).toEqual({
      has_notebook: null,
      notebook_id: null,
    });
  });
});

describe("narrowNotebookOptions", () => {
  const options = [
    { id: NOTEBOOK_A, name: "Heat stress day 1", runCount: 4 },
    { id: NOTEBOOK_B, name: "Growth curves", runCount: 2 },
    { id: NOTEBOOK_C, name: "Heat shock follow-up", runCount: 1 },
  ];

  it("keeps every notebook for blank text", () => {
    expect(narrowNotebookOptions(options, "  ")).toEqual(options);
  });

  it("matches part of a name, ignoring case and surrounding spaces", () => {
    expect(
      narrowNotebookOptions(options, " HEAT ").map((option) => option.id)
    ).toEqual([NOTEBOOK_A, NOTEBOOK_C]);
    expect(narrowNotebookOptions(options, "curve")).toEqual([options[1]]);
    expect(narrowNotebookOptions(options, "yeast")).toEqual([]);
  });
});

describe("matchingNotebookFirst", () => {
  const notebooks = [
    { id: NOTEBOOK_A },
    { id: NOTEBOOK_B },
    { id: NOTEBOOK_C },
  ];

  it("moves the filtered notebook to the front and keeps the rest in order", () => {
    expect(
      matchingNotebookFirst(notebooks, NOTEBOOK_C).map((n) => n.id)
    ).toEqual([NOTEBOOK_C, NOTEBOOK_A, NOTEBOOK_B]);
  });

  it("leaves the order alone without a match", () => {
    expect(matchingNotebookFirst(notebooks, null)).toEqual(notebooks);
    expect(matchingNotebookFirst(notebooks, NOTEBOOK_A)).toEqual(notebooks);
    expect(
      matchingNotebookFirst(notebooks, "00000000-0000-4000-8000-0000000000ff")
    ).toEqual(notebooks);
  });
});
