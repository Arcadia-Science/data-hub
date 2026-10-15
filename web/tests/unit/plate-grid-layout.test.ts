import { describe, expect, it } from "vitest";
import {
  buildPlateLayout,
  nextPlateCell,
  plateCellKey,
} from "@/lib/runs/plate-wells";

const well = (label: string) => ({ well: label });

describe("buildPlateLayout", () => {
  it("sizes the grid to the furthest well", () => {
    const layout = buildPlateLayout([well("A1"), well("C4")]);
    expect(layout.rows).toBe(3);
    expect(layout.cols).toBe(4);
    expect(layout.byPos.get(plateCellKey(2, 3))).toEqual(well("C4"));
  });

  it("keeps wells with odd labels instead of dropping them", () => {
    const layout = buildPlateLayout([well("A1"), well("Control"), well("Z9")]);
    expect(layout.byPos.size).toBe(1);
    expect(layout.unplaced.map((w) => w.well)).toEqual(["Control", "Z9"]);
  });

  it("handles a plate with nothing on it", () => {
    const layout = buildPlateLayout([]);
    expect(layout.byPos.size).toBe(0);
    expect(layout.unplaced).toEqual([]);
  });
});

// A 3 x 4 plate with these wells present (x) and the rest empty:
//   A: x x . x
//   B: . x . .
//   C: x . . x
function shapeFor(labels: string[]) {
  const layout = buildPlateLayout(labels.map(well));
  return {
    rows: layout.rows,
    cols: layout.cols,
    has: (row: number, col: number) => layout.byPos.has(plateCellKey(row, col)),
  };
}
const shape = shapeFor(["A1", "A2", "A4", "B2", "C1", "C4"]);

describe("nextPlateCell", () => {
  it("moves one well in the arrow direction", () => {
    expect(nextPlateCell(shape, { row: 0, col: 0 }, "ArrowRight")).toEqual({
      row: 0,
      col: 1,
    });
    expect(nextPlateCell(shape, { row: 0, col: 1 }, "ArrowDown")).toEqual({
      row: 1,
      col: 1,
    });
    expect(nextPlateCell(shape, { row: 1, col: 1 }, "ArrowUp")).toEqual({
      row: 0,
      col: 1,
    });
    expect(nextPlateCell(shape, { row: 0, col: 1 }, "ArrowLeft")).toEqual({
      row: 0,
      col: 0,
    });
  });

  it("skips empty positions in the same direction", () => {
    expect(nextPlateCell(shape, { row: 0, col: 1 }, "ArrowRight")).toEqual({
      row: 0,
      col: 3,
    });
    expect(nextPlateCell(shape, { row: 0, col: 0 }, "ArrowDown")).toEqual({
      row: 2,
      col: 0,
    });
  });

  it("returns null at the edge or when nothing lies that way", () => {
    expect(nextPlateCell(shape, { row: 0, col: 0 }, "ArrowLeft")).toBeNull();
    expect(nextPlateCell(shape, { row: 0, col: 0 }, "ArrowUp")).toBeNull();
    expect(nextPlateCell(shape, { row: 1, col: 1 }, "ArrowRight")).toBeNull();
    expect(nextPlateCell(shape, { row: 1, col: 1 }, "ArrowLeft")).toBeNull();
  });

  it("jumps to the ends of a row with Home and End", () => {
    expect(nextPlateCell(shape, { row: 0, col: 1 }, "Home")).toEqual({
      row: 0,
      col: 0,
    });
    expect(nextPlateCell(shape, { row: 0, col: 1 }, "End")).toEqual({
      row: 0,
      col: 3,
    });
    // Row B has one well, so both ends are that well.
    expect(nextPlateCell(shape, { row: 1, col: 1 }, "Home")).toEqual({
      row: 1,
      col: 1,
    });
    expect(nextPlateCell(shape, { row: 1, col: 1 }, "End")).toEqual({
      row: 1,
      col: 1,
    });
  });

  it("jumps to the first and last well on the plate with Ctrl", () => {
    expect(nextPlateCell(shape, { row: 1, col: 1 }, "Home", true)).toEqual({
      row: 0,
      col: 0,
    });
    expect(nextPlateCell(shape, { row: 1, col: 1 }, "End", true)).toEqual({
      row: 2,
      col: 3,
    });
  });

  it("ignores other keys", () => {
    expect(nextPlateCell(shape, { row: 0, col: 0 }, "Enter")).toBeNull();
    expect(nextPlateCell(shape, { row: 0, col: 0 }, "a")).toBeNull();
  });
});
