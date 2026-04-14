"""Parse instrument metadata from SpectraMax iD3 plate reader `.xls` exports.

SoftMax Pro exports plate data as tab-delimited text with an `.xls`
extension.  The plate header line (``Plate:  ...``) encodes measurement
settings, but the field layout varies by measurement mode (Absorbance vs
Fluorescence).  Fields before the ``Raw`` token are stable; fields after
it shift depending on the mode.  We locate ``Raw`` as an anchor and read
subsequent fields at fixed offsets from it.

The raw data section of each plate block is a grid of rows × columns
(e.g. 8 × 12 for 96-well, 16 × 24 for 384-well), repeated once per
reading (1 for Endpoint, *N* for Kinetic time-points or Well Scan
positions).  Each reading group is followed by an empty separator line.
A summary table (no ``Temperature`` column header) follows the last
group before ``~End``.
"""

from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

MEASUREMENT_MODES = {"Absorbance", "Fluorescence"}
MEASUREMENT_TYPES = {"Endpoint", "Kinetic", "Well Scan"}

_COL_PLATE_NAME = 1
_COL_MEASUREMENT_TYPE = 4
_COL_MEASUREMENT_MODE = 5

_OFF_NUM_READINGS = 2  # offset from Raw index
_OFF_WAVELENGTH = 9
_OFF_NUM_WELLS = 12

_ROW_LABELS = "ABCDEFGHIJKLMNOP"


@dataclass(frozen=True)
class _PlateHeader:
    """Parsed fields from a single ``Plate:`` header line."""

    plate_name: str
    measurement_type: str
    measurement_mode: str
    num_readings: int
    wavelength_raw: str
    num_wells: int


def _parse_plate_header(line: str) -> _PlateHeader:
    """Parse a ``Plate:`` header line into structured fields.

    Locates the ``Raw`` token to anchor field positions so that both
    Absorbance and Fluorescence layouts are handled correctly.

    Raises:
        ValueError: If the line has no ``Raw`` token or required fields
            cannot be read.
    """
    fields = line.split("\t")

    raw_idx: int | None = None
    for j in range(6, len(fields)):
        if fields[j] == "Raw":
            raw_idx = j
            break
    if raw_idx is None:
        raise ValueError(f"No 'Raw' anchor token found in plate header: {line!r}")

    return _PlateHeader(
        plate_name=fields[_COL_PLATE_NAME],
        measurement_type=fields[_COL_MEASUREMENT_TYPE].strip(),
        measurement_mode=fields[_COL_MEASUREMENT_MODE].strip(),
        num_readings=int(fields[raw_idx + _OFF_NUM_READINGS]),
        wavelength_raw=fields[raw_idx + _OFF_WAVELENGTH].strip(),
        num_wells=int(fields[raw_idx + _OFF_NUM_WELLS]),
    )


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


def _count_cols_in_header(col_header_line: str) -> int:
    """Return the number of data columns from the column-label header row.

    The column header is tab-delimited::

        <time> \\t Temperature(...) \\t 1 \\t 2 \\t ... \\t N \\t <separator> ...

    We count consecutive numeric labels after the first two fields (time and
    temperature) to determine the actual grid width.  This is more reliable
    than the plate-header ``num_columns`` field which some SoftMax Pro
    protocol templates populate with a value unrelated to the grid geometry.
    """
    fields = col_header_line.split("\t")
    count = 0
    for field in fields[2:]:
        if field.strip().isdigit():
            count += 1
        elif count > 0:
            break
    if count == 0:
        raise ValueError("Could not determine column count from header row")
    return count


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

        header = _parse_plate_header(line)

        if header.measurement_mode not in MEASUREMENT_MODES:
            raise ValueError(
                f"Unexpected measurement mode '{header.measurement_mode}'; "
                f"expected one of {sorted(MEASUREMENT_MODES)}"
            )
        if header.measurement_type not in MEASUREMENT_TYPES:
            raise ValueError(
                f"Unexpected measurement type '{header.measurement_type}'; "
                f"expected one of {sorted(MEASUREMENT_TYPES)}"
            )
        if not header.wavelength_raw.isdigit():
            raise ValueError(f"Expected numeric wavelength, got '{header.wavelength_raw}'")

        return {
            "measurement_mode": header.measurement_mode,
            "measurement_type": header.measurement_type,
            "wavelength": f"{header.wavelength_raw} nm",
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

        header = _parse_plate_header(lines[i])
        wavelength = int(header.wavelength_raw) if header.wavelength_raw.isdigit() else None

        num_cols = _count_cols_in_header(lines[i + 1])
        num_rows = header.num_wells // num_cols

        i += 2  # Skip plate header + column header row.

        for _ in range(header.num_readings):
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
                            "plate_name": header.plate_name,
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
