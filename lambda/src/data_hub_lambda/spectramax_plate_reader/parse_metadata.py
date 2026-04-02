"""Parse instrument metadata from SpectraMax iD3 plate reader ``.xls`` exports.

SoftMax Pro exports plate data as tab-delimited text with an ``.xls``
extension.  The plate header line (``Plate:  ...``) encodes measurement
settings at fixed column positions.
"""

from __future__ import annotations
from pathlib import Path

MEASUREMENT_MODES = {"Absorbance", "Fluorescence"}
MEASUREMENT_TYPES = {"Endpoint", "Kinetic", "Well Scan", "WellScan"}

_MEASUREMENT_TYPE_LABELS: dict[str, str] = {
    "Endpoint": "Endpoint",
    "Kinetic": "Kinetic",
    "Well Scan": "Well Scan",
    "WellScan": "Well Scan",
}

_COL_MEASUREMENT_TYPE = 4
_COL_MEASUREMENT_MODE = 5
_COL_WAVELENGTH = 15


def parse_metadata(file_path: Path) -> dict[str, str]:
    """Extract measurement metadata from a SpectraMax ``.xls`` file.

    Returns:
        A dict with keys ``measurement_mode``, ``measurement_type``, and
        ``wavelength``.  Example::

            {
                "measurement_mode": "Absorbance",
                "measurement_type": "Endpoint",
                "wavelength": "750 nm",
            }

    Raises:
        ValueError: If the file contains no ``Plate:`` header or the header
            contains unexpected values.
    """
    text = file_path.read_text(encoding="utf-16")

    for line in text.splitlines():
        if not line.startswith("Plate:"):
            continue

        fields = line.split("\t")

        measurement_mode = fields[_COL_MEASUREMENT_MODE].strip()
        measurement_type_raw = fields[_COL_MEASUREMENT_TYPE].strip()
        wavelength_raw = fields[_COL_WAVELENGTH].strip()

        if measurement_mode not in MEASUREMENT_MODES:
            raise ValueError(
                f"Unexpected measurement mode '{measurement_mode}'; "
                f"expected one of {sorted(MEASUREMENT_MODES)}"
            )
        if measurement_type_raw not in MEASUREMENT_TYPES:
            raise ValueError(
                f"Unexpected measurement type '{measurement_type_raw}'; "
                f"expected one of {sorted(MEASUREMENT_TYPES)}"
            )
        if not wavelength_raw.isdigit():
            raise ValueError(f"Expected numeric wavelength, got '{wavelength_raw}'")

        return {
            "measurement_mode": measurement_mode,
            "measurement_type": _MEASUREMENT_TYPE_LABELS[measurement_type_raw],
            "wavelength": f"{wavelength_raw} nm",
        }

    raise ValueError(f"No 'Plate:' header line found in {file_path}")
