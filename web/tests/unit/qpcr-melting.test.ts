import { describe, expect, it } from "vitest";
import {
  indexQpcrMeltingCurves,
  meltingCurveKey,
  parseQpcrMeltingPlateJson,
} from "@/lib/runs/qpcr-melting";

describe("parseQpcrMeltingPlateJson", () => {
  it("accepts array and object points and drops invalid ones", () => {
    const plate = parseQpcrMeltingPlateJson({
      channels: [
        {
          channel: "Channel2",
          wells: [
            {
              well: "A1",
              series: {
                derivative: [
                  [20, 0.9],
                  { x: "21", y: 1.2 },
                  [22, "nope"],
                  null,
                ],
                fluorescence: [[20, 100]],
                not_a_series: [[20, 1]],
              },
            },
          ],
        },
      ],
    });

    expect(plate.channels).toHaveLength(1);
    const { series } = plate.channels[0].wells[0];
    expect(series.derivative).toEqual([
      { x: 20, y: 0.9 },
      { x: 21, y: 1.2 },
    ]);
    expect(series.fluorescence).toEqual([{ x: 20, y: 100 }]);
    expect(Object.keys(series)).toEqual(["derivative", "fluorescence"]);
  });

  it("rejects a payload without channels", () => {
    expect(() => parseQpcrMeltingPlateJson({})).toThrow(/missing channels/);
  });

  it("rejects a channel without a name", () => {
    expect(() =>
      parseQpcrMeltingPlateJson({ channels: [{ wells: [] }] })
    ).toThrow(/missing a name/);
  });
});

describe("indexQpcrMeltingCurves", () => {
  function row(overrides: Record<string, string>): Record<string, string> {
    return {
      channel: "Channel1",
      well: "A1",
      temperature_c: "60",
      fluorescence: "1200",
      fluorescence_pct_max: "80",
      neg_dFpct_dT: "1.5",
      ...overrides,
    };
  }

  it("groups both series by channel and well in row order", () => {
    const index = indexQpcrMeltingCurves([
      row({ temperature_c: "60", fluorescence_pct_max: "80" }),
      row({ temperature_c: "61", fluorescence_pct_max: "85" }),
      row({ well: "B1", temperature_c: "60", neg_dFpct_dT: "0.4" }),
      row({ channel: "Channel2", temperature_c: "60", neg_dFpct_dT: "2.2" }),
    ]);

    expect(index.get(meltingCurveKey("Channel1", "A1"))).toEqual({
      derivative: [
        { x: 60, y: 1.5 },
        { x: 61, y: 1.5 },
      ],
      fluorescence: [
        { x: 60, y: 80 },
        { x: 61, y: 85 },
      ],
    });
    expect(
      index.get(meltingCurveKey("Channel1", "B1"))?.derivative
    ).toHaveLength(1);
    expect(index.get(meltingCurveKey("Channel2", "A1"))?.derivative).toEqual([
      { x: 60, y: 2.2 },
    ]);
  });

  it("skips rows with no temperature and blank cells within a row", () => {
    const index = indexQpcrMeltingCurves([
      row({ temperature_c: "" }),
      row({ temperature_c: "not-a-number" }),
      row({ well: "" }),
      row({ temperature_c: "62", fluorescence_pct_max: "" }),
    ]);

    expect(index.size).toBe(1);
    expect(index.get(meltingCurveKey("Channel1", "A1"))).toEqual({
      derivative: [{ x: 62, y: 1.5 }],
      fluorescence: [],
    });
  });
});
