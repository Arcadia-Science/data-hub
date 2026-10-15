import { describe, expect, it } from "vitest";
import { isGridKey, nextGridCell } from "@/lib/grid-keyboard";
import { buildPlateLayout, plateCellKey } from "@/lib/runs/plate-wells";

function shapeFor(labels: string[]) {
  const layout = buildPlateLayout(labels.map((well) => ({ well })));
  return {
    rows: layout.rows,
    cols: layout.cols,
    has: (row: number, col: number) => layout.byPos.has(plateCellKey(row, col)),
  };
}

// A 3 x 4 plate with these wells present (x) and the rest empty:
//   A: x x . x
//   B: . x . .
//   C: x . . x
const shape = shapeFor(["A1", "A2", "A4", "B2", "C1", "C4"]);

describe("nextGridCell", () => {
  it("moves one well in the arrow direction", () => {
    expect(nextGridCell(shape, { row: 0, col: 0 }, "ArrowRight")).toEqual({
      row: 0,
      col: 1,
    });
    expect(nextGridCell(shape, { row: 0, col: 1 }, "ArrowDown")).toEqual({
      row: 1,
      col: 1,
    });
    expect(nextGridCell(shape, { row: 1, col: 1 }, "ArrowUp")).toEqual({
      row: 0,
      col: 1,
    });
    expect(nextGridCell(shape, { row: 0, col: 1 }, "ArrowLeft")).toEqual({
      row: 0,
      col: 0,
    });
  });

  it("skips empty positions in the same direction", () => {
    expect(nextGridCell(shape, { row: 0, col: 1 }, "ArrowRight")).toEqual({
      row: 0,
      col: 3,
    });
    expect(nextGridCell(shape, { row: 0, col: 0 }, "ArrowDown")).toEqual({
      row: 2,
      col: 0,
    });
  });

  it("continues into the next or previous row when a row runs out", () => {
    expect(nextGridCell(shape, { row: 1, col: 1 }, "ArrowRight")).toEqual({
      row: 2,
      col: 0,
    });
    expect(nextGridCell(shape, { row: 1, col: 1 }, "ArrowLeft")).toEqual({
      row: 0,
      col: 3,
    });
  });

  it("continues into the next or previous column when a column runs out", () => {
    expect(nextGridCell(shape, { row: 2, col: 0 }, "ArrowDown")).toEqual({
      row: 0,
      col: 1,
    });
    expect(nextGridCell(shape, { row: 0, col: 1 }, "ArrowUp")).toEqual({
      row: 2,
      col: 0,
    });
  });

  it("stays put at the very first and last well", () => {
    expect(nextGridCell(shape, { row: 0, col: 0 }, "ArrowLeft")).toBeNull();
    expect(nextGridCell(shape, { row: 0, col: 0 }, "ArrowUp")).toBeNull();
    expect(nextGridCell(shape, { row: 2, col: 3 }, "ArrowRight")).toBeNull();
    expect(nextGridCell(shape, { row: 2, col: 3 }, "ArrowDown")).toBeNull();
  });

  it("reaches a well that sits alone in its row and column", () => {
    //   A: x x x . .
    //   B: . . . . x
    //   C: x x x . .
    const sparse = shapeFor(["A1", "A2", "A3", "B5", "C1", "C2", "C3"]);
    const alone = { row: 1, col: 4 };

    expect(nextGridCell(sparse, { row: 0, col: 2 }, "ArrowRight")).toEqual(
      alone
    );
    expect(nextGridCell(sparse, { row: 2, col: 0 }, "ArrowLeft")).toEqual(
      alone
    );
    expect(nextGridCell(sparse, { row: 2, col: 2 }, "ArrowDown")).toEqual(
      alone
    );
    expect(nextGridCell(sparse, { row: 0, col: 0 }, "ArrowUp")).toBeNull();
    // And back out again.
    expect(nextGridCell(sparse, alone, "ArrowRight")).toEqual({
      row: 2,
      col: 0,
    });
    expect(nextGridCell(sparse, alone, "ArrowLeft")).toEqual({
      row: 0,
      col: 2,
    });
  });

  it("walks a single row, as in the heartbeat strip", () => {
    const strip = { rows: 1, cols: 3, has: () => true };
    expect(nextGridCell(strip, { row: 0, col: 1 }, "ArrowRight")).toEqual({
      row: 0,
      col: 2,
    });
    expect(nextGridCell(strip, { row: 0, col: 2 }, "ArrowRight")).toBeNull();
    expect(nextGridCell(strip, { row: 0, col: 0 }, "ArrowLeft")).toBeNull();
  });

  it("jumps to the ends of a row with Home and End", () => {
    expect(nextGridCell(shape, { row: 0, col: 1 }, "Home")).toEqual({
      row: 0,
      col: 0,
    });
    expect(nextGridCell(shape, { row: 0, col: 1 }, "End")).toEqual({
      row: 0,
      col: 3,
    });
    // Row B has one well, so both ends are that well.
    expect(nextGridCell(shape, { row: 1, col: 1 }, "Home")).toEqual({
      row: 1,
      col: 1,
    });
    expect(nextGridCell(shape, { row: 1, col: 1 }, "End")).toEqual({
      row: 1,
      col: 1,
    });
  });

  it("jumps to the first and last well on the plate with Ctrl", () => {
    expect(nextGridCell(shape, { row: 1, col: 1 }, "Home", true)).toEqual({
      row: 0,
      col: 0,
    });
    expect(nextGridCell(shape, { row: 1, col: 1 }, "End", true)).toEqual({
      row: 2,
      col: 3,
    });
  });

  it("ignores other keys", () => {
    expect(nextGridCell(shape, { row: 0, col: 0 }, "Enter")).toBeNull();
    expect(nextGridCell(shape, { row: 0, col: 0 }, "a")).toBeNull();
  });
});

describe("isGridKey", () => {
  const base = { altKey: false, metaKey: false };

  it("accepts the keys the grid moves with", () => {
    for (const key of ["ArrowUp", "ArrowDown", "Home", "End"]) {
      expect(isGridKey({ ...base, key })).toBe(true);
    }
  });

  it("leaves other keys and browser shortcuts alone", () => {
    expect(isGridKey({ ...base, key: "Enter" })).toBe(false);
    // Alt+Left and Cmd+Left are the browser's Back.
    expect(isGridKey({ ...base, key: "ArrowLeft", altKey: true })).toBe(false);
    expect(isGridKey({ ...base, key: "ArrowLeft", metaKey: true })).toBe(false);
  });
});
