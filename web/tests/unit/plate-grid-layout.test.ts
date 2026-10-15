import { describe, expect, it } from "vitest";
import { buildPlateLayout, plateCellKey } from "@/lib/runs/plate-wells";

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
