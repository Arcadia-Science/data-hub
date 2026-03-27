from enum import Enum


class Instrument(Enum):
    """Enum for supported instruments.

    The kebab-case ID is used as a prefix for S3 object keys.

    The display name is used to reference the instrument's Notion database.
    """

    AGILENT_4150_TAPESTATION = "agilent-4150-tapestation"
    AKTA_FPLC = "akta-fplc"
    AZURE_600_GEL_DOC = "azure-600-gel-doc"
    AZURE_CIELO_QPCR = "azure-cielo-qpcr"
    SPECTRAMAX_ID3_PLATE_READER = "spectramax-id3-plate-reader"
    SPECTRAMAX_ID5_PLATE_READER = "spectramax-id5-plate-reader"


class Analysis(Enum):
    """Enum for supported analyses."""

    MICHAELIS_MENTEN_KINETICS = "Michaelis-Menten Kinetics"
