import type { PlatePoint } from "@/lib/runs/plate-wells";

export const AUNTY_FLAVORS = ["thermal_ramp", "sizing", "isothermal"] as const;
export type AuntyFlavor = (typeof AUNTY_FLAVORS)[number];

export const AUNTY_SERIES_IDS = [
  "fluorescence",
  "differential",
  "z_average_diameter",
  "sls",
  "correlation",
  "intensity",
  "mass",
] as const;
export type AuntySeriesId = (typeof AUNTY_SERIES_IDS)[number];

export type AuntyPoint = PlatePoint;

export interface AuntyWellValues {
  fluor_k1?: number | null;
  fluor_k2?: number | null;
  fluor_k3?: number | null;
  fluor_r2?: number | null;
  pdi?: number | null;
  pk1_diameter?: number | null;
  pk1_intensity?: number | null;
  pk1_mass?: number | null;
  sls_k1?: number | null;
  sls_k2?: number | null;
  sls_k3?: number | null;
  sls_r2?: number | null;
  tagg?: number | null;
  tm1?: number | null;
  tm2?: number | null;
  tm3?: number | null;
  tonset?: number | null;
  tsize?: number | null;
  z_avg_diameter?: number | null;
}

export interface AuntyWell {
  sample: string | null;
  series: Partial<Record<AuntySeriesId, AuntyPoint[]>>;
  values: AuntyWellValues;
  well: string;
}

export interface AuntyExperiment {
  analysisMode: string | null;
  fileName: string;
  flavor: AuntyFlavor;
  primarySeries: AuntySeriesId;
  wells: AuntyWell[];
}

export interface AuntyPlate {
  experiments: AuntyExperiment[];
}

export interface AuntyPlateData {
  curvesFileId: number | null;
  plate: AuntyPlate;
}

export interface AuntySeriesMeta {
  color: string;
  id: AuntySeriesId;
  label: string;
  markerKey?: keyof AuntyWellValues;
  xLabel: string;
  yLabel: string;
}

const TEAL = "#0d9488";
const ORANGE = "#f97316";
const BLUE = "#2563eb";
const VIOLET = "#7c3aed";
const PINK = "#db2777";

export const TM_MARKER_COLOR = ORANGE;

export const AUNTY_SERIES_META: Record<AuntySeriesId, AuntySeriesMeta> = {
  fluorescence: {
    id: "fluorescence",
    label: "Fluorescence",
    xLabel: "Temperature",
    yLabel: "Fluorescence",
    color: TEAL,
    markerKey: "tm1",
  },
  differential: {
    id: "differential",
    label: "Derivative",
    xLabel: "Temperature",
    yLabel: "dF/dT",
    color: BLUE,
    markerKey: "tm1",
  },
  z_average_diameter: {
    id: "z_average_diameter",
    label: "Z-average diameter",
    xLabel: "Temperature",
    yLabel: "Diameter (nm)",
    color: VIOLET,
  },
  sls: {
    id: "sls",
    label: "SLS",
    xLabel: "Temperature",
    yLabel: "SLS",
    color: PINK,
  },
  correlation: {
    id: "correlation",
    label: "Correlation",
    xLabel: "Time (s)",
    yLabel: "Amplitude",
    color: TEAL,
  },
  intensity: {
    id: "intensity",
    label: "Intensity",
    xLabel: "Hydrodynamic diameter (nm)",
    yLabel: "Amplitude",
    color: BLUE,
  },
  mass: {
    id: "mass",
    label: "Mass",
    xLabel: "Hydrodynamic diameter (nm)",
    yLabel: "Amplitude",
    color: ORANGE,
  },
};

export const SERIES_BY_FLAVOR: Record<AuntyFlavor, AuntySeriesId[]> = {
  thermal_ramp: ["fluorescence", "differential", "z_average_diameter", "sls"],
  sizing: ["correlation", "intensity", "mass"],
  isothermal: ["fluorescence", "sls"],
};

export function seriesMetaFor(
  flavor: AuntyFlavor,
  seriesId: AuntySeriesId
): AuntySeriesMeta {
  const base = AUNTY_SERIES_META[seriesId];
  if (
    flavor === "isothermal" &&
    (seriesId === "fluorescence" || seriesId === "sls")
  ) {
    return { ...base, markerKey: undefined, xLabel: "Time (s)" };
  }
  return base;
}

export const AUNTY_WELL_VALUE_FIELDS = [
  { key: "tm1", label: "Tm1 (°C)" },
  { key: "tm2", label: "Tm2 (°C)" },
  { key: "tm3", label: "Tm3 (°C)" },
  { key: "tagg", label: "Tagg (°C)" },
  { key: "tonset", label: "Tonset (°C)" },
  { key: "tsize", label: "Tsize (°C)" },
  { key: "z_avg_diameter", label: "Z-avg (nm)" },
  { key: "pdi", label: "PDI" },
  { key: "pk1_diameter", label: "Pk 1 diameter (nm)" },
  { key: "pk1_intensity", label: "Pk 1 intensity (%)" },
  { key: "pk1_mass", label: "Pk 1 mass (%)" },
  { key: "fluor_k1", label: "Fluorescence k\u2081 (s\u207b\u00b9)" },
  { key: "fluor_k2", label: "Fluorescence k\u2082 (s\u207b\u00b9)" },
  { key: "fluor_k3", label: "Fluorescence k\u2083 (s\u207b\u00b9)" },
  { key: "fluor_r2", label: "Fluorescence R\u00b2" },
  { key: "sls_k1", label: "SLS k\u2081 (s\u207b\u00b9)" },
  { key: "sls_k2", label: "SLS k\u2082 (s\u207b\u00b9)" },
  { key: "sls_k3", label: "SLS k\u2083 (s\u207b\u00b9)" },
  { key: "sls_r2", label: "SLS R\u00b2" },
] as const satisfies readonly {
  key: keyof AuntyWellValues;
  label: string;
}[];

export function formatAuntyNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 0.01 || abs >= 10_000)) {
    return value.toExponential(2);
  }
  if (Number.isInteger(value)) {
    return String(value);
  }
  if (abs >= 10) {
    return value.toFixed(1);
  }
  return value.toFixed(2);
}

export function wellTileValue(
  flavor: AuntyFlavor,
  values: AuntyWellValues
): string | null {
  const keys =
    flavor === "thermal_ramp"
      ? (["tm1", "tagg"] as const)
      : flavor === "sizing"
        ? (["z_avg_diameter"] as const)
        : (["fluor_k1", "sls_k1"] as const);
  for (const key of keys) {
    const value = values[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return formatAuntyNumber(value);
    }
  }
  return null;
}

export function presentWellValues(
  values: AuntyWellValues
): { label: string; text: string }[] {
  const out: { label: string; text: string }[] = [];
  for (const field of AUNTY_WELL_VALUE_FIELDS) {
    const value = values[field.key];
    if (typeof value === "number" && Number.isFinite(value)) {
      out.push({ label: field.label, text: formatAuntyNumber(value) });
    }
  }
  return out;
}

export function isAuntyFlavor(value: unknown): value is AuntyFlavor {
  return (
    typeof value === "string" &&
    (AUNTY_FLAVORS as readonly string[]).includes(value)
  );
}

export function isAuntySeriesId(value: unknown): value is AuntySeriesId {
  return (
    typeof value === "string" &&
    (AUNTY_SERIES_IDS as readonly string[]).includes(value)
  );
}

export function seriesForFlavor(
  flavor: AuntyFlavor,
  available: Iterable<string>
): AuntySeriesId[] {
  const present = new Set(available);
  return SERIES_BY_FLAVOR[flavor].filter((id) => present.has(id));
}

export function tmMarkerValue(values: AuntyWellValues): number | null {
  const tm1 = values.tm1;
  if (typeof tm1 !== "number" || tm1 === 0 || !Number.isFinite(tm1)) {
    return null;
  }
  return tm1;
}

interface RawPlate {
  experiments?: unknown;
}

interface RawExperiment {
  analysisMode?: unknown;
  fileName?: unknown;
  flavor?: unknown;
  primarySeries?: unknown;
  wells?: unknown;
}

interface RawWell {
  sample?: unknown;
  series?: unknown;
  values?: unknown;
  well?: unknown;
}

export function parseAuntyPlateJson(raw: unknown): AuntyPlate {
  if (!raw || typeof raw !== "object") {
    throw new Error("Aunty plate JSON is not an object");
  }
  const payload = raw as RawPlate;
  if (!Array.isArray(payload.experiments)) {
    throw new Error("Aunty plate JSON is missing experiments");
  }
  return {
    experiments: payload.experiments.map(parseExperiment),
  };
}

function parseExperiment(raw: unknown): AuntyExperiment {
  const exp = (raw ?? {}) as RawExperiment;
  if (!isAuntyFlavor(exp.flavor)) {
    throw new Error("Aunty experiment has an unknown flavor");
  }
  if (typeof exp.fileName !== "string" || exp.fileName.length === 0) {
    throw new Error("Aunty experiment is missing a file name");
  }
  const wells = Array.isArray(exp.wells) ? exp.wells.map(parseWell) : [];
  const primary = isAuntySeriesId(exp.primarySeries)
    ? exp.primarySeries
    : SERIES_BY_FLAVOR[exp.flavor][0];
  return {
    fileName: exp.fileName,
    analysisMode:
      typeof exp.analysisMode === "string" ? exp.analysisMode : null,
    flavor: exp.flavor,
    primarySeries: primary,
    wells,
  };
}

function parseWell(raw: unknown): AuntyWell {
  const well = (raw ?? {}) as RawWell;
  if (typeof well.well !== "string" || well.well.length === 0) {
    throw new Error("Aunty well is missing a well label");
  }
  return {
    well: well.well,
    sample: typeof well.sample === "string" ? well.sample : null,
    values: parseValues(well.values),
    series: parseSeriesMap(well.series),
  };
}

function parseValues(raw: unknown): AuntyWellValues {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const src = raw as Record<string, unknown>;
  const out: AuntyWellValues = {};
  for (const key of [
    "tm1",
    "tm2",
    "tm3",
    "tagg",
    "tonset",
    "tsize",
    "z_avg_diameter",
    "pdi",
    "pk1_diameter",
    "pk1_intensity",
    "pk1_mass",
    "fluor_k1",
    "fluor_k2",
    "fluor_k3",
    "fluor_r2",
    "sls_k1",
    "sls_k2",
    "sls_k3",
    "sls_r2",
  ] as const) {
    out[key] = optionalNumber(src[key]);
  }
  return out;
}

function parseSeriesMap(
  raw: unknown
): Partial<Record<AuntySeriesId, AuntyPoint[]>> {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const out: Partial<Record<AuntySeriesId, AuntyPoint[]>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(isAuntySeriesId(key) && Array.isArray(value))) {
      continue;
    }
    const points = value
      .map(parsePoint)
      .filter((p): p is AuntyPoint => p !== null);
    if (points.length > 0) {
      out[key] = points;
    }
  }
  return out;
}

function parsePoint(raw: unknown): AuntyPoint | null {
  if (Array.isArray(raw) && raw.length >= 2) {
    const x = Number(raw[0]);
    const y = Number(raw[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      return { x, y };
    }
    return null;
  }
  if (raw && typeof raw === "object") {
    const rec = raw as { x?: unknown; y?: unknown };
    const x = Number(rec.x);
    const y = Number(rec.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      return { x, y };
    }
  }
  return null;
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export interface AuntyCurveRow {
  analysisMode: string;
  fileName: string;
  sample: string;
  series: AuntySeriesId;
  well: string;
  x: number;
  y: number;
}

export function parseAuntyCurvesCsv(
  rows: Record<string, string>[]
): AuntyCurveRow[] {
  const out: AuntyCurveRow[] = [];
  for (const row of rows) {
    if (!isAuntySeriesId(row.series)) {
      continue;
    }
    const x = Number(row.x);
    const y = Number(row.y);
    if (!(Number.isFinite(x) && Number.isFinite(y))) {
      continue;
    }
    const fileName = row.file_name ?? "";
    const well = row.well ?? "";
    if (!(fileName && well)) {
      continue;
    }
    out.push({
      fileName,
      analysisMode: row.analysis_mode ?? "",
      well,
      sample: row.sample ?? "",
      series: row.series,
      x,
      y,
    });
  }
  return out;
}

export function indexAuntyCurves(
  rows: AuntyCurveRow[]
): Map<string, AuntyPoint[]> {
  const index = new Map<string, AuntyPoint[]>();
  for (const row of rows) {
    const key = curveKey(row.fileName, row.well, row.series);
    const list = index.get(key);
    if (list) {
      list.push({ x: row.x, y: row.y });
    } else {
      index.set(key, [{ x: row.x, y: row.y }]);
    }
  }
  return index;
}

export function curveKey(
  fileName: string,
  well: string,
  series: AuntySeriesId
): string {
  return `${fileName}\t${well}\t${series}`;
}
