import { describe, expect, it } from "vitest";
import { NOTEBOOKS_PER_RUN_MAX } from "@/lib/notebook-links/url";
import {
  addRunError,
  addRunsSummary,
  notebooksOfRuns,
  removeRunsSummary,
} from "@/lib/runs/notebook-outcomes";

const NO_OUTCOMES = {
  added: 0,
  already_in_notebook: 0,
  run_deleted: 0,
  limit_reached: 0,
  not_found: 0,
};

describe("addRunsSummary", () => {
  it("names the notebook and how many runs went in", () => {
    expect(
      addRunsSummary("Heat stress day 1", { ...NO_OUTCOMES, added: 1 })
    ).toEqual({
      message: "Added 1 run to “Heat stress day 1”.",
      tone: "success",
    });
  });

  it("mentions runs that were already in it, still as a success", () => {
    expect(
      addRunsSummary("Growth curves", {
        ...NO_OUTCOMES,
        added: 3,
        already_in_notebook: 2,
      })
    ).toEqual({
      message: "Added 3 runs to “Growth curves”. 2 runs were already in it.",
      tone: "success",
    });
  });

  it("warns about runs at the limit or that couldn't change", () => {
    expect(
      addRunsSummary("Growth curves", {
        ...NO_OUTCOMES,
        added: 1,
        limit_reached: 1,
        run_deleted: 1,
        not_found: 1,
      })
    ).toEqual({
      message: `Added 1 run to “Growth curves”. 1 run is already in ${NOTEBOOKS_PER_RUN_MAX} notebooks, the most allowed. 2 runs couldn't be changed.`,
      tone: "warning",
    });
  });
});

describe("addRunError", () => {
  it("is null once the run is in the notebook", () => {
    expect(addRunError("added")).toBeNull();
    expect(addRunError("already_in_notebook")).toBeNull();
  });

  it("explains why the run couldn't go in", () => {
    expect(addRunError("limit_reached")).toContain(
      `${NOTEBOOKS_PER_RUN_MAX} notebooks`
    );
    expect(addRunError("run_deleted")).toContain("deleted");
    expect(addRunError("not_found")).toBe("Couldn't find this run.");
    expect(addRunError(undefined)).toBe("Couldn't find this run.");
  });
});

describe("notebooksOfRuns", () => {
  it("lists each notebook once with its run count, most shared first", () => {
    const heat = {
      id: "00000000-0000-4000-8000-0000000000a1",
      name: "Heat stress",
      url: "https://notes.example.com/heat",
    };
    const growth = {
      id: "00000000-0000-4000-8000-0000000000a2",
      name: "Growth curves",
      url: "https://notes.example.com/growth",
    };
    const assay = {
      id: "00000000-0000-4000-8000-0000000000a3",
      name: "Assay setup",
      url: "https://notes.example.com/assay",
    };
    expect(
      notebooksOfRuns([
        { notebooks: [growth, heat] },
        { notebooks: [heat] },
        { notebooks: [assay] },
        { notebooks: [] },
      ])
    ).toEqual([
      { ...heat, runCount: 2 },
      { ...assay, runCount: 1 },
      { ...growth, runCount: 1 },
    ]);
  });
});

describe("removeRunsSummary", () => {
  it("names a single notebook", () => {
    expect(
      removeRunsSummary({
        failedNotebooks: 0,
        notebookNames: ["Heat stress"],
        removedRuns: 3,
      })
    ).toEqual({
      message: "Removed 3 runs from “Heat stress”.",
      tone: "success",
    });
  });

  it("counts several notebooks", () => {
    expect(
      removeRunsSummary({
        failedNotebooks: 0,
        notebookNames: ["Heat stress", "Growth curves"],
        removedRuns: 1,
      })
    ).toEqual({ message: "Removed 1 run from 2 notebooks.", tone: "success" });
  });

  it("warns when some notebooks couldn't be changed", () => {
    expect(
      removeRunsSummary({
        failedNotebooks: 1,
        notebookNames: ["Heat stress", "Growth curves"],
        removedRuns: 2,
      })
    ).toEqual({
      message:
        "Removed 2 runs, but 1 of the 2 notebooks couldn't be changed. Try again?",
      tone: "warning",
    });
  });

  it("is an error when none could be changed", () => {
    expect(
      removeRunsSummary({
        failedNotebooks: 1,
        notebookNames: ["Heat stress"],
        removedRuns: 0,
      })
    ).toEqual({
      message: "Couldn't remove runs from “Heat stress”. Try again?",
      tone: "error",
    });
  });
});
