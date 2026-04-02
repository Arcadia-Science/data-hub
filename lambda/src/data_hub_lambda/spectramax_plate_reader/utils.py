"""Parse instrument metadata from SpectraMax iD3 plate reader `.xls` exports.

SoftMax Pro exports plate data as tab-delimited text with an `.xls`
extension.  The plate header line (`Plate:  ...`) encodes measurement
settings at fixed column positions.

The raw data section of each plate block is a grid of 8 rows (A–H for
96-well plates) × 12 columns, repeated once per reading (1 for Endpoint,
*N* for Kinetic time-points or Well Scan positions).  Each reading group
is followed by an empty separator line.  A summary table (no
`Temperature` column header) follows the last group before `~End`.
"""

from __future__ import annotations
from pathlib import Path

import pandas as pd

MEASUREMENT_MODES = {"Absorbance", "Fluorescence"}
MEASUREMENT_TYPES = {"Endpoint", "Kinetic", "Well Scan"}

_MEASUREMENT_TYPE_LABELS: dict[str, str] = {
    "Endpoint": "Endpoint",
    "Kinetic": "Kinetic",
    "Well Scan": "Well Scan",
}

_COL_PLATE_NAME = 1
_COL_MEASUREMENT_TYPE = 4
_COL_MEASUREMENT_MODE = 5
_COL_NUM_READINGS = 8
_COL_WAVELENGTH = 15
_COL_NUM_COLUMNS = 17
_COL_NUM_WELLS = 18

_ROW_LABELS = "ABCDEFGHIJKLMNOP"

_WELL_DATA_COLUMNS = [
    "time",
    "plate_name",
    "well_position",
    "temperature_c",
    "value",
    "row_label",
    "column_label",
    "wavelength",
]


def parse_metadata(file_path: Path) -> dict[str, str]:
    """Extract measurement metadata from a SpectraMax `.xls` file.

    Returns:
        A dict with keys `measurement_mode`, `measurement_type`, and
        `wavelength`.  Example::

            {
                "measurement_mode": "Absorbance",
                "measurement_type": "Endpoint",
                "wavelength": "750 nm",
            }

    Raises:
        ValueError: If the file contains no `Plate:` header or the header
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


def parse_raw_well_data(file_path: Path) -> pd.DataFrame:
    """Parse raw well readings from a SpectraMax `.xls` file into long form.

    Each row in the returned DataFrame represents a single well reading.
    Wells with no data (empty cells) are omitted.

    Returns:
        A :class:`~pandas.DataFrame` with columns:

        ============== ======= ==========================================
        Column         Type    Notes
        ============== ======= ==========================================
        time           str?    None for Endpoint reads
        plate_name     str     e.g. "Plate2"
        well_position  str     e.g. "A1", "H12"
        temperature_c  float?  Celsius; shared across all wells in a
                               reading group
        value          float   Raw instrument reading
        row_label      str     e.g. "A"
        column_label   int     e.g. 1
        wavelength     int?    Nanometres; `None` when not reported
        ============== ======= ==========================================

    Raises:
        ValueError: If the file contains no `Plate:` header line.
    """
    text = file_path.read_text(encoding="utf-16")
    lines = text.splitlines()

    records: list[dict[str, object]] = []
    i = 0

    while i < len(lines):
        if not lines[i].startswith("Plate:"):
            i += 1
            continue

        plate_fields = lines[i].split("\t")
        plate_name = plate_fields[_COL_PLATE_NAME]
        num_readings = int(plate_fields[_COL_NUM_READINGS])
        num_cols = int(plate_fields[_COL_NUM_COLUMNS])
        num_wells = int(plate_fields[_COL_NUM_WELLS])
        num_rows = num_wells // num_cols
        wavelength_raw = plate_fields[_COL_WAVELENGTH].strip()
        wavelength = int(wavelength_raw) if wavelength_raw.isdigit() else None

        i += 2  # Skip plate header + column header row.

        for _ in range(num_readings):
            time_val: str | None = None
            temp_val: float | None = None

            for row_idx in range(num_rows):
                row_fields = lines[i].split("\t")

                if row_idx == 0:
                    time_str = row_fields[0].strip()
                    time_val = time_str if time_str else None
                    temp_str = row_fields[1].strip()
                    temp_val = float(temp_str) if temp_str else None

                row_label = _ROW_LABELS[row_idx]

                for col_idx in range(num_cols):
                    val_str = row_fields[2 + col_idx].strip()
                    if not val_str:
                        continue

                    column_label = col_idx + 1
                    records.append(
                        {
                            "time": time_val,
                            "plate_name": plate_name,
                            "well_position": f"{row_label}{column_label}",
                            "temperature_c": temp_val,
                            "value": float(val_str),
                            "row_label": row_label,
                            "column_label": column_label,
                            "wavelength": wavelength,
                        }
                    )

                i += 1

            # Skip blank separator between reading groups.
            if i < len(lines) and lines[i].strip() == "":
                i += 1

        # Skip summary table until ~End.
        while i < len(lines) and not lines[i].startswith("~End"):
            i += 1
        if i < len(lines):
            i += 1  # Advance past ~End.

    if not records:
        raise ValueError(f"No 'Plate:' header line found in {file_path}")

    return pd.DataFrame(records, columns=_WELL_DATA_COLUMNS)
