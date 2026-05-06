from __future__ import annotations

from data_hub_shared.enums import Instrument

INSTRUMENT_ID_TO_NAME_MAP: dict[str, str] = {
    Instrument.AGILENT_4150_TAPESTATION.value: "Agilent 4150 TapeStation",
    Instrument.AKTA_FPLC.value: "Akta FPLC",
    Instrument.AZURE_600_GEL_DOC.value: "Azure 600 Gel Doc",
    Instrument.AZURE_CIELO_QPCR.value: "Azure Cielo qPCR",
    Instrument.EPSON_V700_SCANNER.value: "Epson V700 Scanner",
    Instrument.HINA_MICROSCOPE.value: "Hina Microscope",
    Instrument.SPECTRAMAX_ID3_PLATE_READER.value: "SpectraMax iD3 Plate Reader",
    Instrument.SPECTRAMAX_ID5_PLATE_READER.value: "SpectraMax iD5 Plate Reader",
}

INSTRUMENT_NAME_TO_ID_MAP: dict[str, str] = {
    name: instrument_id for instrument_id, name in INSTRUMENT_ID_TO_NAME_MAP.items()
}
