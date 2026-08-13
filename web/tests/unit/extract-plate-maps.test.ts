import { describe, expect, it } from "vitest";
import { extractPlateMaps } from "@/lib/runs/extract-plate-maps";

describe("extractPlateMaps", () => {
  it("uses a wavelength slider when metadata is Endpoint but rows are a scan", () => {
    const rows = [
      {
        plate_name: "Plate1",
        well_position: "A1",
        wavelength: "595",
        value: "0.1",
      },
      {
        plate_name: "Plate1 (440–450)",
        well_position: "A1",
        wavelength: "440",
        value: "1.0",
      },
      {
        plate_name: "Plate1 (440–450)",
        well_position: "A1",
        wavelength: "445",
        value: "1.1",
      },
      {
        plate_name: "Plate1 (440–450)",
        well_position: "A1",
        wavelength: "450",
        value: "1.2",
      },
    ];

    const groups = extractPlateMaps(rows, { kinetic: false, spectrum: false });

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      mode: "static",
      plateName: "Plate1",
      wavelength: "595",
    });
    expect(groups[1]).toMatchObject({
      mode: "kinetic",
      plateName: "Plate1 (440–450)",
      sliderAxis: "wavelength",
      frameLabels: ["440", "445", "450"],
    });
  });

  it("groups Spectrum plates by wavelength when metadata says Spectrum", () => {
    const rows = [
      {
        plate_name: "Plate1",
        well_position: "A1",
        wavelength: "440",
        value: "1.0",
      },
      {
        plate_name: "Plate1",
        well_position: "A2",
        wavelength: "440",
        value: "1.1",
      },
      {
        plate_name: "Plate1",
        well_position: "A1",
        wavelength: "445",
        value: "1.2",
      },
      {
        plate_name: "Plate1",
        well_position: "A2",
        wavelength: "445",
        value: "1.3",
      },
    ];

    const groups = extractPlateMaps(rows, { kinetic: false, spectrum: true });

    expect(groups).toEqual([
      expect.objectContaining({
        mode: "kinetic",
        plateName: "Plate1",
        sliderAxis: "wavelength",
        frameLabels: ["440", "445"],
      }),
    ]);
    expect(groups[0]?.mode === "kinetic" && groups[0].frames).toHaveLength(2);
  });

  it("keeps kinetic time sliders when time varies", () => {
    const rows = [
      {
        plate_name: "Plate1",
        well_position: "A1",
        wavelength: "595",
        time: "00:00:00",
        value: "0.1",
      },
      {
        plate_name: "Plate1",
        well_position: "A1",
        wavelength: "595",
        time: "00:15:00",
        value: "0.2",
      },
    ];

    const groups = extractPlateMaps(rows, { kinetic: true, spectrum: false });
    const group = groups[0];
    expect(group?.mode).toBe("kinetic");
    if (group?.mode !== "kinetic") {
      return;
    }
    expect(group).toMatchObject({
      plateName: "Plate1",
      wavelength: "595",
      frameLabels: ["00:00:00", "00:15:00"],
    });
    expect(group.sliderAxis).toBeUndefined();
  });
});
