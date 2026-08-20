import type { InstrumentType } from "@/lib/db/schema";

// Instrument types that have a processor entry in
// `lambda/src/data_hub_lambda/processors.py`. Keep in sync when adding a
// processor — types without a handler (e.g. `generic`, `instant_raman`) stay out.
export const PROCESSABLE_INSTRUMENT_TYPES = [
  "qpcr",
  "plate_reader",
  "gel_doc",
  "tape_station",
  "hina_microscope",
  "epson_v700_scanner",
  "fplc",
  "dishcam",
] as const satisfies readonly InstrumentType[];

const PROCESSABLE_SET = new Set<string>(PROCESSABLE_INSTRUMENT_TYPES);

export function isProcessableInstrumentType(
  instrumentType: InstrumentType
): boolean {
  return PROCESSABLE_SET.has(instrumentType);
}
