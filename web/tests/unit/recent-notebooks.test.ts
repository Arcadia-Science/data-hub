import { describe, expect, it } from "vitest";
import {
  parseRecentNotebooks,
  RECENT_NOTEBOOKS_MAX,
  type RecentNotebook,
  serializeRecentNotebooks,
  withNotebookVisit,
  withoutNotebook,
} from "@/lib/notebooks/recent";

function visit(id: string, name = `Notebook ${id}`, at = 1): RecentNotebook {
  return { notebookId: id, name, visitedAt: at };
}

describe("parseRecentNotebooks", () => {
  it("reads back what was saved", () => {
    const list = [visit("a", "Growth curves", 2), visit("b", "Gel ladder", 1)];
    expect(parseRecentNotebooks(serializeRecentNotebooks(list))).toEqual(list);
  });

  it("reads nothing from a missing, broken, or unknown value", () => {
    expect(parseRecentNotebooks(null)).toEqual([]);
    expect(parseRecentNotebooks("")).toEqual([]);
    expect(parseRecentNotebooks("not json")).toEqual([]);
    expect(parseRecentNotebooks(JSON.stringify({ notebookId: "a" }))).toEqual(
      []
    );
    expect(
      parseRecentNotebooks(JSON.stringify({ v: 99, data: [visit("a")] }))
    ).toEqual([]);
  });

  it("skips entries without the expected fields", () => {
    const raw = JSON.stringify([
      visit("a"),
      { notebookId: "b", name: "No time" },
      { notebookId: "", name: "Blank ID", visitedAt: 1 },
      { notebookId: 7, name: "Number ID", visitedAt: 1 },
      null,
      "c",
      visit("d"),
    ]);
    expect(parseRecentNotebooks(raw).map((entry) => entry.notebookId)).toEqual([
      "a",
      "d",
    ]);
  });

  it("keeps the first of two entries for one lab notebook", () => {
    const raw = JSON.stringify([
      visit("a", "New name", 2),
      visit("a", "Old", 1),
    ]);
    expect(parseRecentNotebooks(raw)).toEqual([visit("a", "New name", 2)]);
  });

  it("keeps at most RECENT_NOTEBOOKS_MAX entries", () => {
    const many = Array.from({ length: RECENT_NOTEBOOKS_MAX + 5 }, (_, i) =>
      visit(`n${i}`)
    );
    const parsed = parseRecentNotebooks(JSON.stringify(many));
    expect(parsed).toHaveLength(RECENT_NOTEBOOKS_MAX);
    expect(parsed[0]?.notebookId).toBe("n0");
  });
});

describe("withNotebookVisit", () => {
  it("puts the visit first and drops the earlier one, taking the new name", () => {
    const list = [visit("a", "A", 3), visit("b", "Before rename", 2)];
    expect(withNotebookVisit(list, visit("b", "After rename", 4))).toEqual([
      visit("b", "After rename", 4),
      visit("a", "A", 3),
    ]);
  });

  it("drops the oldest visit once the list is full", () => {
    const full = Array.from({ length: RECENT_NOTEBOOKS_MAX }, (_, i) =>
      visit(`n${i}`)
    );
    const next = withNotebookVisit(full, visit("new"));
    expect(next).toHaveLength(RECENT_NOTEBOOKS_MAX);
    expect(next[0]?.notebookId).toBe("new");
    expect(next.at(-1)?.notebookId).toBe(`n${RECENT_NOTEBOOKS_MAX - 2}`);
  });
});

describe("withoutNotebook", () => {
  it("takes a lab notebook off the list and keeps the rest in order", () => {
    const list = [visit("a"), visit("b"), visit("c")];
    expect(withoutNotebook(list, "b").map((entry) => entry.notebookId)).toEqual(
      ["a", "c"]
    );
    expect(withoutNotebook(list, "missing")).toEqual(list);
  });
});
