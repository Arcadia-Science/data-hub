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

function allowedList(
  options: InstrumentFilterOptionsByType,
  key: keyof MetadataFilterArgs
): string[] | null {
  if (options.kind === "default") {
    return null;
  }
  switch (key) {
    case "wavelength":
      return options.kind === "plate_reader"
        ? options.options.wavelengths
        : null;
    case "measurementMode":
      return options.kind === "plate_reader"
        ? options.options.measurementModes
        : null;
    case "measurementType":
      return options.kind === "plate_reader"
        ? options.options.measurementTypes
        : null;
    case "captureType":
      return options.kind === "gel_doc" ? options.options.captureTypes : null;
    case "imagingMode":
      return options.kind === "gel_doc" ? options.options.imagingModes : null;
    case "gelWavelength":
      return options.kind === "gel_doc" ? options.options.wavelengths : null;
    case "gelColor":
      return options.kind === "gel_doc" ? options.options.colors : null;
    case "dyeChannel":
      return options.kind === "qpcr" ? options.options.dyeChannels : null;
    case "hinaChannel":
      return options.kind === "hina_microscope"
        ? options.options.channels
        : null;
    case "hinaDimension":
      return options.kind === "hina_microscope"
        ? options.options.dimensions
        : null;
    case "hinaSize":
      return options.kind === "hina_microscope"
        ? options.options.sizes.map((s) => s.value)
        : null;
    case "dpi":
      return options.kind === "epson_v700_scanner"
        ? options.options.dpis
        : null;
    case "colorMode":
      return options.kind === "epson_v700_scanner"
        ? options.options.colorModes
        : null;
    default:
      return null;
  }
}

const FILTER_KEYS = [
  "wavelength",
  "measurementMode",
  "measurementType",
  "captureType",
  "imagingMode",
  "gelWavelength",
  "gelColor",
  "dyeChannel",
  "hinaChannel",
  "hinaDimension",
  "hinaSize",
  "dpi",
  "colorMode",
] as const satisfies ReadonlyArray<keyof MetadataFilterArgs>;

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
    const allowed = allowedList(options, key);
    if (!allowed) {
      continue;
    }
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
