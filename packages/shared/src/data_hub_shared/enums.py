from __future__ import annotations
from enum import Enum


class Instrument(Enum):
    """Enum for supported instruments.

    The kebab-case value is used as a prefix for S3 object keys.
    """

    AGILENT_4150_TAPESTATION = "agilent-4150-tapestation"
    AKTA_FPLC = "akta-fplc"
    AZURE_600_GEL_DOC = "azure-600-gel-doc"
    AZURE_CIELO_QPCR = "azure-cielo-qpcr"
    HINA_MICROSCOPE = "hina-microscope"
    SPECTRAMAX_ID3_PLATE_READER = "spectramax-id3-plate-reader"
    SPECTRAMAX_ID5_PLATE_READER = "spectramax-id5-plate-reader"
