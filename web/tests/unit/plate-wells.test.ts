import { describe, expect, it } from "vitest";
import {
  compareWells,
  parseWellPosition,
  sparklineGeometry,
} from "@/lib/runs/plate-wells";

describe("parseWellPosition", () => {
  it("maps a well label to zero-based row and column", () => {
    expect(parseWellPosition("A1")).toEqual({ row: 0, col: 0 });
    expect(parseWellPosition("h12")).toEqual({ row: 7, col: 11 });
    expect(parseWellPosition("P24")).toEqual({ row: 15, col: 23 });
  });

  it("returns null for labels outside the plate grid", () => {
    expect(parseWellPosition("Q1")).toBeNull();
    expect(parseWellPosition("Blank")).toBeNull();
  });
});

describe("compareWells", () => {
  it("sorts row-major so A12 comes before B1", () => {
    const wells = ["B1", "A12", "A1", "H12"];
    wells.sort(compareWells);
    expect(wells).toEqual(["A1", "A12", "B1", "H12"]);
  });
});

describe("sparklineGeometry", () => {
  it("keeps endpoints and skips a marker outside the x range", () => {
    const geometry = sparklineGeometry(
      [
        { x: 25, y: 10 },
        { x: 95, y: 20 },
      ],
      10
    );
    expect(geometry.d.startsWith("M")).toBe(true);
    expect(geometry.d.includes(" L")).toBe(true);
    expect(geometry.markerX).toBeNull();
  });

  it("places a marker inside the x range", () => {
    const geometry = sparklineGeometry(
      [
        { x: 25, y: 10 },
        { x: 95, y: 20 },
      ],
      60
    );
    expect(geometry.markerX).toBeGreaterThan(6);
    expect(geometry.markerX).toBeLessThan(114);
  });

  it("returns an empty path for an empty series", () => {
    expect(sparklineGeometry([])).toEqual({ d: "", markerX: null });
  });
});
