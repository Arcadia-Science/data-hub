// ---------- Gel doc ----------

export const CAPTURE_TYPE_COLORS: Record<string, string> = {
  Gel: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300",
  Blot: "border-purple-200 bg-purple-50 text-purple-700 dark:border-purple-800 dark:bg-purple-950 dark:text-purple-300",
  Plate:
    "border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-300",
  Colony:
    "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-300",
};

export const IMAGING_MODE_COLORS: Record<string, string> = {
  Fluorescence:
    "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-300",
  Chemiluminescence:
    "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300",
  Colorimetric:
    "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300",
  "UV Transillumination":
    "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300",
  "White Epi":
    "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300",
};

export const CHANNEL_COLOR_STYLES: Record<string, string> = {
  Red: "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300",
  Green:
    "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-300",
  Blue: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300",
  Cyan: "border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-800 dark:bg-cyan-950 dark:text-cyan-300",
  Magenta:
    "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700 dark:border-fuchsia-800 dark:bg-fuchsia-950 dark:text-fuchsia-300",
  Yellow:
    "border-yellow-200 bg-yellow-50 text-yellow-700 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-300",
  Orange:
    "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-300",
  "Far Red":
    "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300",
};

// ---------- Epson V700 Scanner ----------

export const DPI_COLORS: Record<string, string> = {
  "300":
    "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300",
  "600":
    "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-300",
};

// Stored values are the canonical strings written by the Lambda
// (`"rgb"` / `"bw"`); the human label is computed at the call site.
export const COLOR_MODE_COLORS: Record<string, string> = {
  rgb: "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700 dark:border-fuchsia-800 dark:bg-fuchsia-950 dark:text-fuchsia-300",
  bw: "border-stone-200 bg-stone-50 text-stone-700 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-300",
};

export const COLOR_MODE_LABELS: Record<string, string> = {
  rgb: "RGB",
  bw: "B&W",
};

// ---------- Plate reader ----------

export const MEASUREMENT_TYPE_COLORS: Record<string, string> = {
  Kinetic:
    "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300",
  Endpoint:
    "border-teal-200 bg-teal-50 text-teal-600 dark:border-teal-700 dark:bg-teal-900 dark:text-teal-400",
  "Well Scan":
    "border-purple-200 bg-purple-50 text-purple-700 dark:border-purple-800 dark:bg-purple-950 dark:text-purple-300",
};

export const MEASUREMENT_MODE_COLORS: Record<string, string> = {
  Absorbance:
    "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-300",
  Fluorescence:
    "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-300",
};

// ---------- qPCR ----------

// Known qPCR dye channels. Unknown values fall through to the hash-based cycle
// below so the same label always maps to the same color across the table and
// the run-detail metadata section.
export const DYE_CHANNEL_COLORS: Record<string, string> = {
  HEX: "border-stone-200 bg-stone-50 text-stone-700 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-300",
  TAMRA:
    "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300",
  ROX: "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300",
  "ORANGE 560":
    "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300",
};

// ---------- Shared wavelength cycle ----------

export const WAVELENGTH_COLOR_CYCLE = [
  "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300",
  "border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-300",
  "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-300",
  "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300",
  "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300",
  "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700 dark:border-fuchsia-800 dark:bg-fuchsia-950 dark:text-fuchsia-300",
  "border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-800 dark:bg-cyan-950 dark:text-cyan-300",
] as const;

/** Assign a stable color from `WAVELENGTH_COLOR_CYCLE` to each wavelength string. */
export function buildWavelengthColorMap(
  wavelengths: string[]
): Record<string, string> {
  const sorted = [...new Set(wavelengths)].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
  const map: Record<string, string> = {};
  for (let i = 0; i < sorted.length; i++) {
    map[sorted[i]] = WAVELENGTH_COLOR_CYCLE[i % WAVELENGTH_COLOR_CYCLE.length];
  }
  return map;
}

/**
 * Deterministic djb2-style hash for stable color assignment. Using a hash
 * (rather than sorted-index) means a label gets the same cycle color no matter
 * which subset of labels it appears alongside.
 */
function hashLabel(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * Stable color for a qPCR dye channel: named entries from
 * `DYE_CHANNEL_COLORS`, otherwise a deterministic slot from
 * `WAVELENGTH_COLOR_CYCLE` keyed by the label itself.
 */
export function getDyeChannelColor(channel: string): string {
  return (
    DYE_CHANNEL_COLORS[channel] ??
    WAVELENGTH_COLOR_CYCLE[hashLabel(channel) % WAVELENGTH_COLOR_CYCLE.length]
  );
}
