import { z } from "zod";
import type { InstrumentFilterOptionsByType } from "@/lib/api/instrument-runs";

// Single catalog for instrument-metadata run filters. REST query parsing,
// MCP `search_runs` Zod args, and MCP enum validation all derive from this
// so adding a filter is one edit instead of three.

type FilterableKind = Exclude<InstrumentFilterOptionsByType["kind"], "default">;

interface RunMetadataFilterDef {
  allowedValues: (options: InstrumentFilterOptionsByType) => string[];
  description: string;
  // camelCase key used by `buildRunListQuery` and MCP tool args.
  key: string;
  kind: FilterableKind;
  // snake_case query param on REST list routes (matches the instrument page).
  queryParam: string;
}

export const RUN_METADATA_FILTER_DEFS = [
  {
    key: "wavelength",
    queryParam: "wavelength",
    kind: "plate_reader",
    description: "Plate reader: filter by wavelength",
    allowedValues: (o) =>
      o.kind === "plate_reader" ? o.options.wavelengths : [],
  },
  {
    key: "measurementMode",
    queryParam: "measurement_mode",
    kind: "plate_reader",
    description: "Plate reader: filter by measurement mode",
    allowedValues: (o) =>
      o.kind === "plate_reader" ? o.options.measurementModes : [],
  },
  {
    key: "measurementType",
    queryParam: "measurement_type",
    kind: "plate_reader",
    description: "Plate reader: filter by measurement type",
    allowedValues: (o) =>
      o.kind === "plate_reader" ? o.options.measurementTypes : [],
  },
  {
    key: "captureType",
    queryParam: "capture_type",
    kind: "gel_doc",
    description: "Gel-doc: filter by capture type",
    allowedValues: (o) => (o.kind === "gel_doc" ? o.options.captureTypes : []),
  },
  {
    key: "imagingMode",
    queryParam: "imaging_mode",
    kind: "gel_doc",
    description: "Gel-doc: filter by imaging mode",
    allowedValues: (o) => (o.kind === "gel_doc" ? o.options.imagingModes : []),
  },
  {
    key: "gelWavelength",
    queryParam: "gel_wavelength",
    kind: "gel_doc",
    description: "Gel-doc: filter by wavelength",
    allowedValues: (o) => (o.kind === "gel_doc" ? o.options.wavelengths : []),
  },
  {
    key: "gelColor",
    queryParam: "gel_color",
    kind: "gel_doc",
    description: "Gel-doc: filter by color",
    allowedValues: (o) => (o.kind === "gel_doc" ? o.options.colors : []),
  },
  {
    key: "dyeChannel",
    queryParam: "dye_channel",
    kind: "qpcr",
    description: "qPCR: filter by dye channel",
    allowedValues: (o) => (o.kind === "qpcr" ? o.options.dyeChannels : []),
  },
  {
    key: "hinaChannel",
    queryParam: "hina_channel",
    kind: "hina_microscope",
    description: "Hina microscope: filter by channel name",
    allowedValues: (o) =>
      o.kind === "hina_microscope" ? o.options.channels : [],
  },
  {
    key: "hinaDimension",
    queryParam: "hina_dimension",
    kind: "hina_microscope",
    description: "Hina microscope: filter by dimension",
    allowedValues: (o) =>
      o.kind === "hina_microscope" ? o.options.dimensions : [],
  },
  {
    key: "hinaSize",
    queryParam: "hina_size",
    kind: "hina_microscope",
    description:
      "Hina microscope: filter by sizes JSON object string (from filter-options)",
    allowedValues: (o) =>
      o.kind === "hina_microscope" ? o.options.sizes.map((s) => s.value) : [],
  },
  {
    key: "dpi",
    queryParam: "dpi",
    kind: "epson_v700_scanner",
    description: "Epson scanner: filter by DPI (e.g. '300')",
    allowedValues: (o) =>
      o.kind === "epson_v700_scanner" ? o.options.dpis : [],
  },
  {
    key: "colorMode",
    queryParam: "color_mode",
    kind: "epson_v700_scanner",
    description: "Epson scanner: filter by color mode (e.g. 'rgb', 'bw')",
    allowedValues: (o) =>
      o.kind === "epson_v700_scanner" ? o.options.colorModes : [],
  },
] as const satisfies readonly RunMetadataFilterDef[];

export type RunMetadataFilterKey =
  (typeof RUN_METADATA_FILTER_DEFS)[number]["key"];

export type RunMetadataFilterArgs = {
  [K in RunMetadataFilterKey]?: string;
};

export function pickMetadataFilterArgs(
  source: Partial<Record<RunMetadataFilterKey, string | undefined>>
): RunMetadataFilterArgs {
  const out: RunMetadataFilterArgs = {};
  for (const def of RUN_METADATA_FILTER_DEFS) {
    const value = source[def.key];
    if (value !== undefined) {
      out[def.key] = value;
    }
  }
  return out;
}

// Query keys are snake_case to match the instrument page's URL params;
// returned keys are camelCase for `buildRunListQuery`.
export function parseRunMetadataFilters(
  searchParams: URLSearchParams
): RunMetadataFilterArgs {
  const out: RunMetadataFilterArgs = {};
  for (const def of RUN_METADATA_FILTER_DEFS) {
    const value = searchParams.get(def.queryParam);
    if (value != null) {
      out[def.key] = value;
    }
  }
  return out;
}

// Zod fields for MCP `search_runs` — spread into that tool's inputSchema.
export const mcpMetadataFilterInputSchema = Object.fromEntries(
  RUN_METADATA_FILTER_DEFS.map((def) => [
    def.key,
    z.string().optional().describe(def.description),
  ])
) as {
  [K in RunMetadataFilterKey]: z.ZodOptional<z.ZodString>;
};
