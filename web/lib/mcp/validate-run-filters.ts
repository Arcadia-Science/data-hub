import {
  getInstrumentFilterOptions,
  type InstrumentFilterOptionsByType,
} from "@/lib/api/instrument-runs";
import { getInstrumentById } from "@/lib/api/instruments";

interface MetadataFilterArgs {
  captureType?: string;
  colorMode?: string;
  dpi?: string;
  dyeChannel?: string;
  gelColor?: string;
  gelWavelength?: string;
  hinaChannel?: string;
  hinaDimension?: string;
  hinaSize?: string;
  imagingMode?: string;
  measurementMode?: string;
  measurementType?: string;
  wavelength?: string;
}

// The instrument kind each metadata filter belongs to. A filter is only
// applicable when the scoped instrument's kind matches; supplying one that
// doesn't (e.g. a plate-reader `wavelength` on a gel-doc) is rejected below.
const KEY_TO_KIND = {
  wavelength: "plate_reader",
  measurementMode: "plate_reader",
  measurementType: "plate_reader",
  captureType: "gel_doc",
  imagingMode: "gel_doc",
  gelWavelength: "gel_doc",
  gelColor: "gel_doc",
  dyeChannel: "qpcr",
  hinaChannel: "hina_microscope",
  hinaDimension: "hina_microscope",
  hinaSize: "hina_microscope",
  dpi: "epson_v700_scanner",
  colorMode: "epson_v700_scanner",
} as const satisfies Record<
  keyof MetadataFilterArgs,
  Exclude<InstrumentFilterOptionsByType["kind"], "default">
>;

// Allowed values for a key on an instrument whose kind already matches the
// key (guaranteed by the `KEY_TO_KIND` check in the caller).
function allowedList(
  options: InstrumentFilterOptionsByType,
  key: keyof MetadataFilterArgs
): string[] {
  switch (key) {
    case "wavelength":
      return options.kind === "plate_reader" ? options.options.wavelengths : [];
    case "measurementMode":
      return options.kind === "plate_reader"
        ? options.options.measurementModes
        : [];
    case "measurementType":
      return options.kind === "plate_reader"
        ? options.options.measurementTypes
        : [];
    case "captureType":
      return options.kind === "gel_doc" ? options.options.captureTypes : [];
    case "imagingMode":
      return options.kind === "gel_doc" ? options.options.imagingModes : [];
    case "gelWavelength":
      return options.kind === "gel_doc" ? options.options.wavelengths : [];
    case "gelColor":
      return options.kind === "gel_doc" ? options.options.colors : [];
    case "dyeChannel":
      return options.kind === "qpcr" ? options.options.dyeChannels : [];
    case "hinaChannel":
      return options.kind === "hina_microscope" ? options.options.channels : [];
    case "hinaDimension":
      return options.kind === "hina_microscope"
        ? options.options.dimensions
        : [];
    case "hinaSize":
      return options.kind === "hina_microscope"
        ? options.options.sizes.map((s) => s.value)
        : [];
    case "dpi":
      return options.kind === "epson_v700_scanner" ? options.options.dpis : [];
    case "colorMode":
      return options.kind === "epson_v700_scanner"
        ? options.options.colorModes
        : [];
    default:
      return [];
  }
}

const FILTER_KEYS = Object.keys(KEY_TO_KIND) as (keyof MetadataFilterArgs)[];

// When a single instrument is scoped, reject metadata values that are not in
// that instrument's filter-options so agents get a corrective enum list.
export async function validateSearchRunsMetadataFilters(
  instrumentId: string,
  args: MetadataFilterArgs
): Promise<string | null> {
  const hasAny = FILTER_KEYS.some((key) => args[key] !== undefined);
  if (!hasAny) {
    return null;
  }

  const instrument = await getInstrumentById(instrumentId);
  if (!instrument) {
    return null;
  }

  const options = await getInstrumentFilterOptions(
    instrument.instrumentType,
    instrumentId
  );

  for (const key of FILTER_KEYS) {
    const value = args[key];
    if (value === undefined) {
      continue;
    }
    // Generic instruments have no filter enum to validate against, so we can't
    // produce a corrective list — let these through untouched.
    if (options.kind === "default") {
      continue;
    }
    // Reject filters that don't apply to this instrument's type instead of
    // ignoring them, so an agent can't believe a filter narrowed the query
    // when it was silently dropped.
    if (KEY_TO_KIND[key] !== options.kind) {
      return (
        `Filter ${key}="${value}" does not apply to instrument '${instrumentId}' (type ${options.kind}). ` +
        `See datahub://instruments/${instrumentId}/filter-options for applicable filters.`
      );
    }
    const allowed = allowedList(options, key);
    if (!allowed.includes(value)) {
      return (
        `Invalid ${key}="${value}" for instrument '${instrumentId}'. ` +
        `Expected one of: ${allowed.length > 0 ? allowed.map((v) => JSON.stringify(v)).join(", ") : "(none available)"}. ` +
        `See datahub://instruments/${instrumentId}/filter-options.`
      );
    }
  }

  return null;
}
