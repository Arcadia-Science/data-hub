import type { InstrumentType } from "@/lib/db/schema";

// The display name of each instrument type. The edit and confirm dialogs both
// name a type from here, so they always agree.
export const INSTRUMENT_TYPE_LABELS: Record<InstrumentType, string> = {
  generic: "Generic",
  plate_reader: "Plate Reader",
  gel_doc: "Gel Doc",
  qpcr: "qPCR",
  tape_station: "TapeStation",
  hina_microscope: "Hina Microscope",
  epson_v700_scanner: "Epson V700 Scanner",
  instant_raman: "InstantRaman",
  fplc: "FPLC",
  dishcam: "DishCam",
  aunty: "Aunty",
};
