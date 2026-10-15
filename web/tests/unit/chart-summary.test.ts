import { describe, expect, it } from "vitest";
import { describeCurve, formatSummaryNumber } from "@/lib/runs/chart-summary";

describe("formatSummaryNumber", () => {
  it("keeps four significant digits and drops trailing zeros", () => {
    expect(formatSummaryNumber(62.123_456)).toBe("62.12");
    expect(formatSummaryNumber(0.5)).toBe("0.5");
    expect(formatSummaryNumber(0.000_123_456)).toBe("0.0001235");
  });

  it("groups digits in whole numbers", () => {
    expect(formatSummaryNumber(12_345)).toBe("12,345");
    expect(formatSummaryNumber(-7)).toBe("-7");
  });
});

describe("describeCurve", () => {
  it("says where the curve starts, ends, and peaks", () => {
    const text = describeCurve({
      label: "Intensity",
      xLabel: "Wavenumber",
      points: [
        { x: 200, y: 10 },
        { x: 1450, y: 9812 },
        { x: 3200, y: 40 },
      ],
    });
    expect(text).toBe(
      "Intensity: 3 points. Wavenumber runs from 200 to 3,200. Values range from 10 to 9,812, highest at 1,450."
    );
  });

  it("reports an empty curve plainly", () => {
    expect(describeCurve({ label: "Signal", xLabel: "x", points: [] })).toBe(
      "Signal: no data."
    );
  });

  it("uses the singular for one point", () => {
    expect(
      describeCurve({ label: "A", xLabel: "x", points: [{ x: 1, y: 2 }] })
    ).toContain("1 point.");
  });

  it("does not depend on the order of the points", () => {
    const points = [
      { x: 3, y: 5 },
      { x: 1, y: 9 },
      { x: 2, y: 1 },
    ];
    expect(describeCurve({ label: "A", xLabel: "x", points })).toContain(
      "runs from 1 to 3. Values range from 1 to 9, highest at 1."
    );
  });
});
