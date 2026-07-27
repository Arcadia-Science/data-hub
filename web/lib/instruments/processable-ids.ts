// Instrument IDs that have a `process_file` branch in
// `lambda/src/data_hub_lambda/handler.py`. Keep in sync when adding a
// processor — instruments without a handler (e.g. InstantRaman) stay out.
export const PROCESSABLE_INSTRUMENT_IDS = [
  "akta-fplc",
  "agilent-4150-tapestation",
  "azure-600-gel-doc",
  "azure-cielo-qpcr",
  "epson-v700-scanner",
  "hina-microscope",
  "spectramax-id3-plate-reader",
  "spectramax-id5-plate-reader",
] as const;

const PROCESSABLE_SET = new Set<string>(PROCESSABLE_INSTRUMENT_IDS);

export function isProcessableInstrument(instrumentId: string): boolean {
  return PROCESSABLE_SET.has(instrumentId);
}
