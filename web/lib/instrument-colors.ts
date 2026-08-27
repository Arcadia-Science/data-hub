// ---------- Gel doc ----------

export const CAPTURE_TYPE_COLORS: Record<string, string> = {
  Gel: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  Blot: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
  Plate: "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
  Colony:
    "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
};

export const IMAGING_MODE_COLORS: Record<string, string> = {
  Fluorescence:
    "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  Chemiluminescence:
    "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  Colorimetric:
    "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  "UV Transillumination":
    "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  "White Epi":
    "bg-slate-100 text-slate-700 dark:bg-slate-950 dark:text-slate-300",
};

export const CHANNEL_COLOR_STYLES: Record<string, string> = {
  Red: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  Green: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  Blue: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  Cyan: "bg-cyan-100 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300",
  Magenta:
    "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-950 dark:text-fuchsia-300",
  Yellow:
    "bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-300",
  Orange:
    "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  "Far Red": "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
};

// ---------- Epson V700 Scanner ----------

export const DPI_COLORS: Record<string, string> = {
  "300": "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  "600":
    "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
};

// Stored values are the canonical strings written by the Lambda
// (`"rgb"` / `"bw"`); the human label is computed at the call site.
export const COLOR_MODE_COLORS: Record<string, string> = {
  rgb: "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-950 dark:text-fuchsia-300",
  bw: "bg-stone-100 text-stone-700 dark:bg-stone-950 dark:text-stone-300",
};

export const COLOR_MODE_LABELS: Record<string, string> = {
  rgb: "RGB",
  bw: "B&W",
};

/**
 * Map a stored color-mode value (`"rgb"` / `"bw"`) to its display label,
 * falling back to the raw value for forward-compatibility with any future
 * values the Lambda might emit before this map is updated.
 */
export function formatColorMode(value: string): string {
  return COLOR_MODE_LABELS[value] ?? value;
}

// ---------- Plate reader ----------

export const MEASUREMENT_TYPE_COLORS: Record<string, string> = {
  Kinetic: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  Endpoint: "bg-teal-100 text-teal-600 dark:bg-teal-900 dark:text-teal-400",
  Spectrum: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  "Well Scan":
    "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
};

export const MEASUREMENT_MODE_COLORS: Record<string, string> = {
  Absorbance:
    "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  Fluorescence:
    "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
};

// ---------- Aunty ----------

export const AUNTY_EXPERIMENT_TYPE_COLORS: Record<string, string> = {
  thermal_ramp: "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
  sizing:
    "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  isothermal:
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
};

export const AUNTY_EXPERIMENT_TYPE_LABELS: Record<string, string> = {
  thermal_ramp: "Thermal ramp",
  sizing: "Sizing",
  isothermal: "Isothermal",
};

// ---------- qPCR ----------

// Known qPCR dye channels. Unknown values fall through to the hash-based cycle
// below so the same label always maps to the same color across the table and
// the run-detail metadata section.
export const DYE_CHANNEL_COLORS: Record<string, string> = {
  HEX: "bg-stone-100 text-stone-700 dark:bg-stone-950 dark:text-stone-300",
  TAMRA: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  ROX: "bg-slate-100 text-slate-700 dark:bg-slate-950 dark:text-slate-300",
  "ORANGE 560":
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
};

// ---------- Shared wavelength cycle ----------

export const WAVELENGTH_COLOR_CYCLE = [
  "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
  "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-950 dark:text-fuchsia-300",
  "bg-cyan-100 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300",
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
    // biome-ignore lint/suspicious/noBitwiseOperators: djb2 hash uses shifts to stay in unsigned 32-bit range
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
