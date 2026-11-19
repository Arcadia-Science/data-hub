import { describe, expect, it } from "vitest";
import {
  notebookPickerState,
  readNotebookQuery,
  runsAlreadyIn,
} from "@/lib/runs/notebook-picker";

const LIVE = {
  id: "00000000-0000-4000-8000-0000000000a1",
  name: "Heat stress day 1",
  deleted_at: null,
};
const DELETED = {
  id: "00000000-0000-4000-8000-0000000000a2",
  name: "Old growth curves",
  deleted_at: "2026-10-01T00:00:00.000Z",
};
const PAGE = "https://notes.example.com/eln/heat-stress-day-1";

describe("readNotebookQuery", () => {
  it("treats a full http or https link as a link", () => {
    expect(readNotebookQuery(`  ${PAGE}  `)).toEqual({
      kind: "link",
      url: PAGE,
    });
  });

  it("searches by name for anything else, including dotted names", () => {
    expect(readNotebookQuery(" Heat stress ")).toEqual({
      kind: "name",
      text: "Heat stress",
    });
    expect(readNotebookQuery("assay.v2")).toEqual({
      kind: "name",
      text: "assay.v2",
    });
    expect(readNotebookQuery("ftp://notes.example.com/a")).toEqual({
      kind: "name",
      text: "ftp://notes.example.com/a",
    });
    expect(readNotebookQuery("")).toEqual({ kind: "name", text: "" });
  });
});

describe("notebookPickerState", () => {
  const link = { kind: "link", url: PAGE } as const;
  const name = { kind: "name", text: "heat" } as const;

  it("waits for a pick while searching by name", () => {
    expect(
      notebookPickerState({
        query: name,
        lookup: { status: "done", notebooks: [LIVE] },
        picked: null,
      })
    ).toEqual({ kind: "searching" });
  });

  it("adds to the lab notebook picked from a name search", () => {
    expect(
      notebookPickerState({
        query: name,
        lookup: { status: "loading" },
        picked: LIVE,
      })
    ).toEqual({ kind: "existing", notebook: LIVE });
  });

  it("picks the lab notebook that has a pasted link's page", () => {
    expect(
      notebookPickerState({
        query: link,
        lookup: { status: "done", notebooks: [LIVE] },
        picked: null,
      })
    ).toEqual({ kind: "existing", notebook: LIVE });
  });

  it("offers to restore a deleted lab notebook that has the page", () => {
    expect(
      notebookPickerState({
        query: link,
        lookup: { status: "done", notebooks: [DELETED] },
        picked: null,
      })
    ).toEqual({ kind: "restore", notebook: DELETED });
  });

  it("offers to create a lab notebook for a page no lab notebook has", () => {
    expect(
      notebookPickerState({
        query: link,
        lookup: { status: "done", notebooks: [] },
        picked: null,
      })
    ).toEqual({ kind: "create", url: PAGE });
  });

  it("waits for a link's lookup, and says when it failed", () => {
    expect(
      notebookPickerState({
        query: link,
        lookup: { status: "loading" },
        picked: null,
      })
    ).toEqual({ kind: "looking_up" });
    expect(
      notebookPickerState({
        query: link,
        lookup: { status: "failed" },
        picked: null,
      })
    ).toEqual({ kind: "lookup_failed" });
  });
});

describe("runsAlreadyIn", () => {
  it("counts the runs already in the lab notebook", () => {
    const runNotebookIds = [[LIVE.id], [], [DELETED.id, LIVE.id]];
    expect(runsAlreadyIn(runNotebookIds, LIVE.id)).toBe(2);
    expect(runsAlreadyIn(runNotebookIds, DELETED.id)).toBe(1);
    expect(runsAlreadyIn([], LIVE.id)).toBe(0);
  });
});
