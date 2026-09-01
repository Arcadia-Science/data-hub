import type { PlatePoint } from "@/lib/runs/plate-wells";

// Written by the lambda's melting-curve processor. Both the loaders that
// resolve them and the run page, which hides them from the generic file list
// because the plate grids already present them, match on these.
export const QPCR_MELTING_PLATE_SUFFIX = "_melting_curve_plate.json";
export const QPCR_MELTING_DERIVATIVES_SUFFIX = "_melting_curve_derivatives.csv";

export function isQpcrMeltingPlateFile(filename: string): boolean {
  return filename.toLowerCase().endsWith(QPCR_MELTING_PLATE_SUFFIX);
}

export function isQpcrMeltingDerivativesFile(filename: string): boolean {
  return filename.toLowerCase().endsWith(QPCR_MELTING_DERIVATIVES_SUFFIX);
}

export function isQpcrMeltingArtifact(filename: string): boolean {
  return (
    isQpcrMeltingPlateFile(filename) || isQpcrMeltingDerivativesFile(filename)
  );
}

export type QpcrMeltingPoint = PlatePoint;

export const QPCR_MELTING_SERIES_IDS = ["derivative", "fluorescence"] as const;

export type QpcrMeltingSeriesId = (typeof QPCR_MELTING_SERIES_IDS)[number];

export interface QpcrMeltingSeriesMeta {
  color: string;
  id: QpcrMeltingSeriesId;
  label: string;
  yLabel: string;
}

export const QPCR_MELTING_X_LABEL = "Temperature (\u00b0C)";

export const QPCR_MELTING_SERIES_META: Record<
  QpcrMeltingSeriesId,
  QpcrMeltingSeriesMeta
> = {
  derivative: {
    id: "derivative",
    label: "Derivative",
    yLabel: "\u2212dF%/dT",
    color: "#0d9488",
  },
  fluorescence: {
    id: "fluorescence",
    label: "Melt curve",
    yLabel: "Fluorescence (% of max)",
    color: "#2563eb",
  },
};

// The plate opens on the derivative alone. Ninety-six tiles of two overlaid
// curves is a lot to scan, and the derivative peak is what a plate is read
// for; the melt curve is one click away.
export const QPCR_MELTING_PLATE_SERIES: readonly QpcrMeltingSeriesId[] = [
  "derivative",
];

// A single well at full size has room for both, and the peak is easier to
// trust next to the transition it came from.
export const QPCR_MELTING_WELL_SERIES: readonly QpcrMeltingSeriesId[] =
  QPCR_MELTING_SERIES_IDS;

// Orange so the Tm marker reads as an annotation rather than a third series.
export const QPCR_MELTING_PEAK_COLOR = "#f97316";

// Temperature of the tallest derivative point, which is the well's melting
// temperature. Returns null for a flat trace so an empty channel does not get
// a marker pinned to whichever reading happened to come first.
export function meltPeakTemperature(
  points: readonly QpcrMeltingPoint[] | undefined
): number | null {
  if (!points || points.length === 0) {
    return null;
  }
  let peak = points[0];
  let lowest = points[0].y;
  for (const point of points) {
    if (point.y > peak.y) {
      peak = point;
    }
    if (point.y < lowest) {
      lowest = point.y;
    }
  }
  return peak.y > lowest ? peak.x : null;
}

export function isQpcrMeltingSeriesId(
  value: unknown
): value is QpcrMeltingSeriesId {
  return (
    typeof value === "string" &&
    (QPCR_MELTING_SERIES_IDS as readonly string[]).includes(value)
  );
}

export interface QpcrMeltingWell {
  series: Partial<Record<QpcrMeltingSeriesId, QpcrMeltingPoint[]>>;
  well: string;
}

export interface QpcrMeltingChannel {
  channel: string;
  wells: QpcrMeltingWell[];
}

export interface QpcrMeltingPlate {
  channels: QpcrMeltingChannel[];
}

export interface QpcrMeltingPlateData {
  derivativesCsvFileId: number | null;
  plate: QpcrMeltingPlate;
}

interface RawPlate {
  channels?: unknown;
}

interface RawChannel {
  channel?: unknown;
  wells?: unknown;
}

interface RawWell {
  series?: unknown;
  well?: unknown;
}

export function parseQpcrMeltingPlateJson(raw: unknown): QpcrMeltingPlate {
  if (!raw || typeof raw !== "object") {
    throw new Error("qPCR melting plate JSON is not an object");
  }
  const payload = raw as RawPlate;
  if (!Array.isArray(payload.channels)) {
    throw new Error("qPCR melting plate JSON is missing channels");
  }
  return { channels: payload.channels.map(parseChannel) };
}

function parseChannel(raw: unknown): QpcrMeltingChannel {
  const ch = (raw ?? {}) as RawChannel;
  if (typeof ch.channel !== "string" || ch.channel.length === 0) {
    throw new Error("qPCR melting channel is missing a name");
  }
  const wells = Array.isArray(ch.wells) ? ch.wells.map(parseWell) : [];
  return { channel: ch.channel, wells };
}

function parseWell(raw: unknown): QpcrMeltingWell {
  const w = (raw ?? {}) as RawWell;
  if (typeof w.well !== "string" || w.well.length === 0) {
    throw new Error("qPCR melting well is missing a label");
  }
  return { well: w.well, series: parseSeriesMap(w.series) };
}

function parseSeriesMap(
  raw: unknown
): Partial<Record<QpcrMeltingSeriesId, QpcrMeltingPoint[]>> {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const out: Partial<Record<QpcrMeltingSeriesId, QpcrMeltingPoint[]>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(isQpcrMeltingSeriesId(key) && Array.isArray(value))) {
      continue;
    }
    const points = value
      .map(parsePoint)
      .filter((p): p is QpcrMeltingPoint => p !== null);
    if (points.length > 0) {
      out[key] = points;
    }
  }
  return out;
}

// The lambda writes `[x, y]` pairs to keep a 384-well plate small; object
// points are accepted so a hand-written or older payload still parses.
function parsePoint(raw: unknown): QpcrMeltingPoint | null {
  if (Array.isArray(raw) && raw.length >= 2) {
    return finitePoint(Number(raw[0]), Number(raw[1]));
  }
  if (raw && typeof raw === "object") {
    const rec = raw as { x?: unknown; y?: unknown };
    return finitePoint(Number(rec.x), Number(rec.y));
  }
  return null;
}

function finitePoint(x: number, y: number): QpcrMeltingPoint | null {
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

export type QpcrMeltingWellCurves = Record<
  QpcrMeltingSeriesId,
  QpcrMeltingPoint[]
>;

export type QpcrMeltingCurveIndex = Map<string, QpcrMeltingWellCurves>;

export function meltingCurveKey(channel: string, well: string): string {
  return `${channel}\t${well}`;
}

const CSV_COLUMN_BY_SERIES: Record<QpcrMeltingSeriesId, string> = {
  derivative: "neg_dFpct_dT",
  fluorescence: "fluorescence_pct_max",
};

function finiteNumber(value: string | undefined): number | null {
  if (value === undefined || value === "") {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Turns the tidy `_melting_curve_derivatives.csv` into full-resolution curves
// keyed by channel and well. The writer emits rows in temperature order, so
// the points come out sorted without an extra pass.
export function indexQpcrMeltingCurves(
  rows: Record<string, string>[]
): QpcrMeltingCurveIndex {
  const index: QpcrMeltingCurveIndex = new Map();
  for (const row of rows) {
    const channel = row.channel;
    const well = row.well;
    const x = finiteNumber(row.temperature_c);
    if (!(channel && well) || x === null) {
      continue;
    }
    const key = meltingCurveKey(channel, well);
    let curves = index.get(key);
    if (!curves) {
      curves = { derivative: [], fluorescence: [] };
      index.set(key, curves);
    }
    for (const id of QPCR_MELTING_SERIES_IDS) {
      const y = finiteNumber(row[CSV_COLUMN_BY_SERIES[id]]);
      if (y !== null) {
        curves[id].push({ x, y });
      }
    }
  }
  return index;
}
