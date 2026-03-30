from data_hub_utils.enums import Instrument

# File types accepted by the Notion API.
# API reference: https://developers.notion.com/docs/working-with-files-and-media#supported-file-types.
NOTION_SUPPORTED_FILE_TYPES = [
    # Audio.
    ".aac",
    ".adts",
    ".mid",
    ".midi",
    ".mp3",
    ".mpga",
    ".m4a",
    ".m4b",
    ".mp4",
    # Documents.
    ".pdf",
    ".txt",
    ".json",
    ".doc",
    ".dot",
    ".docx",
    ".dotx",
    ".xls",
    ".xlt",
    ".xla",
    ".xlsx",
    ".xltx",
    ".ppt",
    ".pot",
    ".pps",
    ".ppa",
    ".pptx",
    ".potx",
    # Images.
    ".gif",
    ".heic",
    ".jpeg",
    ".jpg",
    ".png",
    ".svg",
    ".tif",
    ".tiff",
    ".webp",
    ".ico",
    # Video.
    ".amv",
    ".asf",
    ".wmv",
    ".avi",
    ".f4v",
    ".flv",
    ".gifv",
    ".m4v",
    ".mp4",
    ".mkv",
    ".webm",
    ".mov",
    ".qt",
    ".mpeg",
]

# Map of instrument IDs to instrument names.
INSTRUMENT_ID_TO_NAME_MAP = {
    Instrument.AGILENT_4150_TAPESTATION.value: "Agilent 4150 TapeStation",
    Instrument.AKTA_FPLC.value: "Akta FPLC",
    Instrument.AZURE_600_GEL_DOC.value: "Azure 600 Gel Doc",
    Instrument.AZURE_CIELO_QPCR.value: "Azure Cielo qPCR",
    Instrument.SPECTRAMAX_ID3_PLATE_READER.value: "SpectraMax iD3 Plate Reader",
    Instrument.SPECTRAMAX_ID5_PLATE_READER.value: "SpectraMax iD5 Plate Reader",
}

# Map of instrument names to instrument IDs.
INSTRUMENT_NAME_TO_ID_MAP = {
    name: instrument_id for instrument_id, name in INSTRUMENT_ID_TO_NAME_MAP.items()
}
