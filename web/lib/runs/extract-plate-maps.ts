import type { PlateWellData } from "@/components/runs/plate-map-grid";
import type { RawWellRow } from "@/lib/api/instrument-runs";
import { sortTimeKeys } from "@/lib/runs/sort-kinetic-time-keys";

/**
 * CSV parsing (csv-parse) returns all cell values as strings. The heatmap grid
 * relies on `typeof value === "number"` to apply the Plasma colorscale, so we
 * coerce numeric-looking strings (e.g. "0.649") to real numbers at the
 * PlateWellData boundary.
 */
export function coerceNumeric(value: unknown): unknown {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value !== "string" || value === "") {
    return value;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

export type PlateMapGroup =
  | {
      mode: "static";
      plateName: string;
      wavelength: string;
      wells: PlateWellData[];
    }
  | {
      mode: "kinetic";
      plateName: string;
      wavelength: string;
      frameLabels: string[];
      frames: PlateWellData[][];
      sliderAxis?: "time" | "wavelength";
    };

/**
 * Groups kinetic CSV rows into time-indexed plate map frames, one group per
 * unique plate + wavelength combination. Each group becomes either a single
 * static plate map (if only one time-point exists) or a kinetic slider with
 * one frame per time-point.
 */
export function extractKineticPlateMapGroups(
  rows: RawWellRow[],
  wellKey: "well_position" | "well"
): PlateMapGroup[] {
  const byPlateWave = new Map<string, RawWellRow[]>();
  for (const row of rows) {
    const pw = `${row.plate_name ?? ""}|${row.wavelength ?? ""}`;
    const arr = byPlateWave.get(pw) ?? [];
    arr.push(row);
    byPlateWave.set(pw, arr);
  }

  const results: PlateMapGroup[] = [];
  for (const [pw, subset] of byPlateWave) {
    const byTime = new Map<string, RawWellRow[]>();
    for (const row of subset) {
      const tk = String(row.time ?? "");
      const g = byTime.get(tk) ?? [];
      g.push(row);
      byTime.set(tk, g);
    }

    const [plateName = "", wavelength = ""] = pw.split("|");

    if (byTime.size < 2) {
      const flat = [...byTime.values()].flat();
      results.push({
        mode: "static",
        plateName,
        wavelength,
        wells: flat.map((r) => ({
          well: String(r[wellKey]),
          value: coerceNumeric(r.value),
        })),
      });
      continue;
    }

    const timeKeysSorted = sortTimeKeys([...byTime.keys()]);
    const frames = timeKeysSorted.map((tk) =>
      (byTime.get(tk) ?? []).map((r) => ({
        well: String(r[wellKey]),
        value: coerceNumeric(r.value),
      }))
    );
    results.push({
      mode: "kinetic",
      plateName,
      wavelength,
      frameLabels: timeKeysSorted,
      frames,
    });
  }
  return results;
}

/**
 * Groups Spectrum CSV rows into wavelength-indexed plate map frames, one
 * group per plate. A trailing Endpoint block in the same file becomes a
 * single-frame (static) map.
 */
export function extractSpectrumPlateMapGroups(
  rows: RawWellRow[],
  wellKey: "well_position" | "well"
): PlateMapGroup[] {
  const byPlate = new Map<string, RawWellRow[]>();
  for (const row of rows) {
    const plate = String(row.plate_name ?? "");
    const arr = byPlate.get(plate) ?? [];
    arr.push(row);
    byPlate.set(plate, arr);
  }

  const results: PlateMapGroup[] = [];
  for (const [plateName, subset] of byPlate) {
    const byWavelength = new Map<string, RawWellRow[]>();
    for (const row of subset) {
      const wk = String(row.wavelength ?? "");
      const g = byWavelength.get(wk) ?? [];
      g.push(row);
      byWavelength.set(wk, g);
    }

    if (byWavelength.size < 2) {
      const flat = [...byWavelength.values()].flat();
      results.push({
        mode: "static",
        plateName,
        wavelength: [...byWavelength.keys()][0] ?? "",
        wells: flat.map((r) => ({
          well: String(r[wellKey]),
          value: coerceNumeric(r.value),
        })),
      });
      continue;
    }

    const wavelengthKeys = sortTimeKeys([...byWavelength.keys()]);
    const frames = wavelengthKeys.map((wk) =>
      (byWavelength.get(wk) ?? []).map((r) => ({
        well: String(r[wellKey]),
        value: coerceNumeric(r.value),
      }))
    );
    results.push({
      mode: "kinetic",
      plateName,
      wavelength: "",
      frameLabels: wavelengthKeys,
      frames,
      sliderAxis: "wavelength",
    });
  }
  return results;
}

/**
 * True when at least one plate has multiple wavelengths and no row has a
 * time value. Used so an Endpoint-first mixed file still gets a wavelength
 * slider even though run metadata reports the first plate's type.
 */
export function rowsLookLikeSpectrumScan(rows: RawWellRow[]): boolean {
  if (rows.some((r) => String(r.time ?? "") !== "")) {
    return false;
  }
  const byPlate = new Map<string, Set<string>>();
  for (const row of rows) {
    const plate = String(row.plate_name ?? "");
    const set = byPlate.get(plate) ?? new Set();
    const wl = String(row.wavelength ?? "");
    if (wl !== "") {
      set.add(wl);
    }
    byPlate.set(plate, set);
  }
  return [...byPlate.values()].some((s) => s.size > 1);
}

/**
 * Converts flat CSV rows into renderable plate map groups.
 *
 * Strategy:
 *  - Kinetic with multiple time-points → time-slider groups (one per plate+wavelength)
 *  - Spectrum, or well data that looks like a wavelength scan → wavelength-slider groups
 *  - Single combination of (plate, wavelength, time) → one unlabelled static map
 *  - Multiple combinations → separate labelled static maps (e.g. multi-wavelength endpoint)
 *
 * The CSV may use either "well_position" (SpectraMax) or "well" as the column
 * name for well coordinates — we auto-detect from the first row.
 */
export function extractPlateMaps(
  rows: RawWellRow[],
  options: { kinetic: boolean; spectrum: boolean }
): PlateMapGroup[] {
  if (rows.length === 0) {
    return [];
  }

  const wellKey =
    rows[0].well_position === undefined ? "well" : "well_position";
  if (rows[0][wellKey] === undefined) {
    return [];
  }

  const uniqueTimes = new Set(rows.map((r) => String(r.time ?? "")));
  const hasTimeVariation = uniqueTimes.size > 1;

  if (options.kinetic && hasTimeVariation) {
    return extractKineticPlateMapGroups(
      rows,
      wellKey as "well_position" | "well"
    );
  }

  if (options.spectrum || rowsLookLikeSpectrumScan(rows)) {
    return extractSpectrumPlateMapGroups(
      rows,
      wellKey as "well_position" | "well"
    );
  }

  const hasMultiple =
    new Set(rows.map((r) => `${r.plate_name}|${r.wavelength}|${r.time}`)).size >
    1;

  if (!hasMultiple) {
    return [
      {
        mode: "static",
        plateName: "",
        wavelength: "",
        wells: rows.map((r) => ({
          well: String(r[wellKey]),
          value: coerceNumeric(r.value),
        })),
      },
    ];
  }

  const grouped = new Map<string, RawWellRow[]>();
  for (const row of rows) {
    const key = `${row.plate_name ?? ""}|${row.wavelength ?? ""}|${row.time ?? ""}`;
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }

  return Array.from(grouped.entries()).map(([key, group]) => {
    const [plate = "", wavelength = "", time = ""] = key.split("|");
    const titleParts: string[] = [];
    if (plate) {
      titleParts.push(plate);
    }
    if (time) {
      titleParts.push(`t=${time}`);
    }
    return {
      mode: "static" as const,
      plateName: titleParts.join(" · "),
      wavelength,
      wells: group.map((r) => ({
        well: String(r[wellKey]),
        value: coerceNumeric(r.value),
      })),
    };
  });
}
