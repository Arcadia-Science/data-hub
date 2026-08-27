import { describe, expect, it } from "vitest";
import {
  formatAuntyExperimentType,
  formatAuntyRampRate,
  formatAuntyTemperatureRange,
} from "@/components/runs/run-metadata-badges";
import {
  compareWells,
  curveKey,
  formatAuntyNumber,
  indexAuntyCurves,
  parseAuntyCurvesCsv,
  parseAuntyPlateJson,
  presentWellValues,
  seriesForFlavor,
  seriesMetaFor,
  sparklineGeometry,
  tmMarkerValue,
  wellTileValue,
} from "@/lib/runs/aunty";

describe("parseAuntyCurvesCsv", () => {
  it("keeps finite series rows and drops unknown series", () => {
    const rows = parseAuntyCurvesCsv([
      {
        file_name: "Thermal ramp seed T0900",
        analysis_mode: "BCM",
        well: "A1",
        sample: "A1",
        series: "fluorescence",
        x: "25",
        y: "330.1",
      },
      {
        file_name: "Thermal ramp seed T0900",
        analysis_mode: "BCM",
        well: "A1",
        sample: "A1",
        series: "not_a_series",
        x: "26",
        y: "331",
      },
      {
        file_name: "Thermal ramp seed T0900",
        analysis_mode: "BCM",
        well: "A1",
        sample: "A1",
        series: "fluorescence",
        x: "not-a-number",
        y: "1",
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fileName: "Thermal ramp seed T0900",
      series: "fluorescence",
      well: "A1",
      x: 25,
      y: 330.1,
    });
  });
});

describe("indexAuntyCurves", () => {
  it("groups points by file, well, and series", () => {
    const index = indexAuntyCurves([
      {
        analysisMode: "BCM",
        fileName: "exp",
        sample: "A1",
        series: "fluorescence",
        well: "A1",
        x: 25,
        y: 1,
      },
      {
        analysisMode: "BCM",
        fileName: "exp",
        sample: "A1",
        series: "fluorescence",
        well: "A1",
        x: 26,
        y: 2,
      },
      {
        analysisMode: "BCM",
        fileName: "exp",
        sample: "B1",
        series: "fluorescence",
        well: "B1",
        x: 25,
        y: 3,
      },
    ]);

    expect(index.get(curveKey("exp", "A1", "fluorescence"))).toEqual([
      { x: 25, y: 1 },
      { x: 26, y: 2 },
    ]);
    expect(index.get(curveKey("exp", "B1", "fluorescence"))).toEqual([
      { x: 25, y: 3 },
    ]);
  });
});

describe("compareWells", () => {
  it("sorts row-major so A12 comes before B1", () => {
    const wells = ["B1", "A12", "A1", "H12"];
    wells.sort(compareWells);
    expect(wells).toEqual(["A1", "A12", "B1", "H12"]);
  });
});

describe("tmMarkerValue", () => {
  it("treats 0 as no transition", () => {
    expect(tmMarkerValue({ tm1: 64.6 })).toBe(64.6);
    expect(tmMarkerValue({ tm1: 0 })).toBeNull();
    expect(tmMarkerValue({ tm1: null })).toBeNull();
  });
});

describe("seriesForFlavor", () => {
  it("keeps only series present on the well", () => {
    expect(
      seriesForFlavor("thermal_ramp", ["fluorescence", "sls", "mass"])
    ).toEqual(["fluorescence", "sls"]);
    expect(seriesForFlavor("sizing", ["correlation", "intensity"])).toEqual([
      "correlation",
      "intensity",
    ]);
    expect(
      seriesForFlavor("isothermal", ["fluorescence", "sls", "correlation"])
    ).toEqual(["fluorescence", "sls"]);
  });
});

describe("parseAuntyPlateJson", () => {
  it("accepts array and object points", () => {
    const plate = parseAuntyPlateJson({
      experiments: [
        {
          fileName: "Thermal ramp seed T0900",
          analysisMode: "BCM",
          flavor: "thermal_ramp",
          primarySeries: "fluorescence",
          wells: [
            {
              well: "A1",
              sample: "A1",
              values: { tm1: 64.6, tm2: 0 },
              series: {
                fluorescence: [[25, 330], { x: 95, y: 350 }],
              },
            },
          ],
        },
      ],
    });

    expect(plate.experiments).toHaveLength(1);
    expect(plate.experiments[0].wells[0].series.fluorescence).toEqual([
      { x: 25, y: 330 },
      { x: 95, y: 350 },
    ]);
    expect(plate.experiments[0].wells[0].values.tm1).toBe(64.6);
    expect(plate.experiments[0].wells[0].values.tm2).toBe(0);
  });

  it("rejects an unknown flavor", () => {
    expect(() =>
      parseAuntyPlateJson({
        experiments: [{ fileName: "x", flavor: "unknown", wells: [] }],
      })
    ).toThrow(/unknown flavor/);
  });
});

describe("sparklineGeometry", () => {
  it("keeps endpoints and skips a Tm marker outside the x range", () => {
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

  it("places a Tm marker inside the x range", () => {
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
});

describe("seriesMetaFor", () => {
  it("uses time on the x-axis for isothermal fluorescence", () => {
    expect(seriesMetaFor("isothermal", "fluorescence").xLabel).toBe("Time (s)");
    expect(seriesMetaFor("thermal_ramp", "fluorescence").xLabel).toBe(
      "Temperature"
    );
  });
});

describe("well summaries", () => {
  it("picks a tile value by flavor and skips empty Tm", () => {
    expect(wellTileValue("thermal_ramp", { tm1: 64.6 })).toBe("64.6");
    expect(wellTileValue("thermal_ramp", { tagg: 60.1 })).toBe("60.1");
    expect(wellTileValue("sizing", { z_avg_diameter: 16.72 })).toBe("16.7");
    expect(wellTileValue("isothermal", { fluor_k1: 0.0034 })).toBe("3.40e-3");
  });

  it("lists finite well values in display order", () => {
    expect(
      presentWellValues({ tm1: 64.6, tm2: null, fluor_k1: 0.0034 })
    ).toEqual([
      { label: "Tm1 (°C)", text: "64.6" },
      { label: "Fluorescence k₁ (s⁻¹)", text: "3.40e-3" },
    ]);
  });

  it("formats large and tiny numbers compactly", () => {
    expect(formatAuntyNumber(18951.2)).toBe("1.90e+4");
    expect(formatAuntyNumber(0)).toBe("0");
  });
});

describe("Aunty metadata labels", () => {
  it("maps known experiment types and formats temperature and ramp rate", () => {
    expect(formatAuntyExperimentType("thermal_ramp")).toBe("Thermal ramp");
    expect(formatAuntyExperimentType("sizing")).toBe("Sizing");
    expect(formatAuntyExperimentType("isothermal")).toBe("Isothermal");
    expect(formatAuntyExperimentType("custom_run")).toBe("custom run");
    expect(formatAuntyTemperatureRange("25", "95")).toBe("25–95 °C");
    expect(formatAuntyRampRate("1")).toBe("1 °C/min");
  });
});
