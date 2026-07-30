"""Parse instrument metadata from SpectraMax iD3 plate reader `.xls` exports.

SoftMax Pro exports plate data as tab-delimited text with an `.xls`
extension.  The plate header line (``Plate:  ...``) encodes measurement
settings, but the field layout varies by measurement mode (Absorbance vs
Fluorescence).  Fields before the ``Raw``/``Reduced`` token are stable;
fields after it shift depending on the mode.  We locate the anchor token
and read subsequent fields at fixed offsets from it.

The raw data section of each plate block is a grid of rows × columns
(e.g. 8 × 12 for 96-well, 16 × 24 for 384-well), repeated once per
reading (1 for Endpoint, *N* for Kinetic time-points or Well Scan
positions).  Each reading group is followed by an empty separator line.
A summary table (no ``Temperature`` column header) follows the last
group before ``~End``.

SoftMax may declare more Kinetic readings in the plate header than it
exports (e.g. a 48 h protocol stopped early).  The parser emits the
groups that are present and stops at the summary table or ``~End``.
"""

from __future__ import annotations
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import pandas as pd

MEASUREMENT_MODES = {"Absorbance", "Fluorescence"}
MEASUREMENT_TYPES = {"Endpoint", "Kinetic", "Well Scan"}

_COL_PLATE_NAME = 1
_COL_MEASUREMENT_TYPE = 4
_COL_MEASUREMENT_MODE = 5

_ANCHOR_TOKENS = {"Raw", "Reduced"}

# First index where the anchor token can appear.  Fields 0–5 are the
# stable prefix: Plate:, plate_name, version, format, type, mode.
_RAW_SEARCH_START = 6

_OFF_NUM_READINGS = 2  # offset from Raw index
_OFF_WAVELENGTH = 9
_OFF_NUM_WELLS = 12

_ROW_LABELS = "ABCDEFGHIJKLMNOP"

# SoftMax Pro substitutes a short non-numeric token for the well value when
# the instrument couldn't produce a usable reading:
#
#   - ``Path?``  PathCheck pathlength correction failed (typically an empty
#                or low-volume well that breaks the NIR-ratio measurement).
#   - ``Range?`` Reading was outside the detector's dynamic range.
#
# These wells are preserved in the parsed DataFrame with ``value=NaN`` so
# that downstream code can distinguish a "well was attempted but failed"
# from a "well was never read" (which remains absent from the output).
_WELL_VALUE_SENTINELS = frozenset({"Path?", "Range?"})

# SoftMax elapsed time: ``HH:MM:SS`` within the first day, then
# ``D.HH:MM:SS`` once the run crosses 24 h (e.g. ``1.00:05:20``).
_ELAPSED_TIME_RE = re.compile(r"^(?:\d+\.)?\d{1,2}:\d{2}:\d{2}$")


def _at_plate_end(lines: list[str], i: int) -> bool:
    return i >= len(lines) or lines[i].startswith("~End")


def _kinetic_reading_present(lines: list[str], i: int, num_rows: int) -> bool:
    """Return whether ``lines[i:i+num_rows]`` still holds a Kinetic group.

    After the last exported reading, SoftMax writes a summary table or
    ``~End``. Neither carries an elapsed-time token, so an overstated
    ``num_readings`` in the plate header must not consume those lines as
    well data.
    """
    if _at_plate_end(lines, i):
        return False
    end = min(i + num_rows, len(lines))
    for j in range(i, end):
        if lines[j].startswith("~End"):
            return False
        fields = lines[j].split("\t")
        if fields and _ELAPSED_TIME_RE.match(fields[0].strip()):
            return True
    return False


def _parse_well_value(val_str: str) -> float:
    """Convert a SpectraMax well-cell string to a float.

    Returns ``NaN`` for documented non-numeric sentinels emitted by
    SoftMax Pro (see :data:`_WELL_VALUE_SENTINELS`). Any other
    non-numeric token is treated as a parser bug and re-raises
    :class:`ValueError`.
    """
    if val_str in _WELL_VALUE_SENTINELS:
        return float("nan")
    return float(val_str)


def _parse_wavelengths(raw: str) -> tuple[int, ...]:
    """Parse a space-separated wavelength string like ``'750'`` or ``'750 600'``."""
    tokens = raw.split()
    if not tokens or not all(t.isdigit() for t in tokens):
        raise ValueError(f"Expected space-separated numeric wavelengths, got '{raw}'")
    return tuple(int(t) for t in tokens)


_WELL_POSITION_RE = re.compile(r"^([A-P])(\d{1,2})$")


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

    Locates the ``Raw`` or ``Reduced`` anchor token to determine field
    positions so that both Absorbance and Fluorescence layouts are
    handled correctly.

    Raises:
        ValueError: If the line has no recognised anchor token or
            required fields cannot be read.
    """
    fields = line.split("\t")

    raw_idx: int | None = None
    for j in range(_RAW_SEARCH_START, len(fields)):
        if fields[j] in _ANCHOR_TOKENS:
            raw_idx = j
            break
    if raw_idx is None:
        raise ValueError(
            f"No anchor token ({'/'.join(sorted(_ANCHOR_TOKENS))}) found in plate header: {line!r}"
        )

    required_len = raw_idx + _OFF_NUM_WELLS + 1
    if len(fields) < required_len:
        raise ValueError(
            f"Plate header too short after 'Raw' token "
            f"(need {_OFF_NUM_WELLS + 1} fields after 'Raw', "
            f"have {len(fields) - raw_idx})"
        )

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


@dataclass(frozen=True)
class _ColumnLayout:
    """Describes how data columns are arranged after the time+temperature prefix."""

    format: Literal["grid", "flat"]
    num_data_cols: int
    well_positions: tuple[tuple[str, int], ...] = field(default=())
    group_offsets: tuple[int, ...] = field(default=())


def _parse_column_layout(col_header_line: str) -> _ColumnLayout:
    """Determine the column layout from the column-label header row.

    Two layouts are supported:

    **Grid** – columns are numeric labels (``1``, ``2``, …, ``12``).
    Each plate row (A, B, …) occupies its own data line::

        <time> \\t Temperature(...) \\t 1 \\t 2 \\t ... \\t N

    **Flat** – columns are well-position labels (``A1``, ``A2``, …,
    ``H12``).  All wells appear on a single data line per reading::

        <time> \\t Temperature(...) \\t A1 \\t A2 \\t ... \\t H12
    """
    fields = col_header_line.split("\t")

    groups: list[tuple[int, int]] = []
    idx = 2
    while idx < len(fields):
        if fields[idx].strip().isdigit():
            start = idx
            count = 0
            while idx < len(fields) and fields[idx].strip().isdigit():
                count += 1
                idx += 1
            groups.append((start, count))
        else:
            idx += 1
    if groups:
        return _ColumnLayout(
            format="grid",
            num_data_cols=groups[0][1],
            group_offsets=tuple(g[0] for g in groups),
        )

    well_positions: list[tuple[str, int]] = []
    for f in fields[2:]:
        m = _WELL_POSITION_RE.match(f.strip())
        if m:
            well_positions.append((m.group(1), int(m.group(2))))
        elif well_positions:
            break

    if well_positions:
        return _ColumnLayout(
            format="flat",
            num_data_cols=len(well_positions),
            well_positions=tuple(well_positions),
        )

    raise ValueError("Could not determine column layout from header row")


def parse_metadata(file_path: Path) -> dict[str, object]:
    """Extract measurement metadata from a SpectraMax `.xls` file.

    Returns:
        A dict with keys `measurement_mode`, `measurement_type`, and
        `wavelengths`.  Wavelengths are returned as a list of numeric
        strings (without the ``nm`` suffix) to mirror the shape used by
        other multi-wavelength instruments (e.g. Azure 600 Gel Doc) and
        let the UI layer own display formatting.  Example::

            {
                "measurement_mode": "Absorbance",
                "measurement_type": "Endpoint",
                "wavelengths": ["750", "700", "650", "600"],
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
        wavelengths = _parse_wavelengths(header.wavelength_raw)

        return {
            "measurement_mode": header.measurement_mode,
            "measurement_type": header.measurement_type,
            "wavelengths": [str(w) for w in wavelengths],
        }

    raise ValueError(f"No 'Plate:' header line found in {file_path}")


def parse_raw_well_data(file_path: Path) -> pd.DataFrame:
    """Parse raw well readings from a SpectraMax `.xls` file into long form.

    Each row in the returned DataFrame represents a single well reading.
    Wells with no data (empty cells) are omitted. Wells where SoftMax Pro
    emitted a non-numeric sentinel (e.g. ``Path?`` for a PathCheck
    pathlength failure, ``Range?`` for out-of-range) are kept with
    ``value=NaN`` so the failed well is still visible to downstream
    consumers.

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
        value          float   Raw instrument reading; ``NaN`` for wells
                               whose value was a SoftMax Pro sentinel
                               such as ``Path?`` or ``Range?``.
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
        try:
            wavelengths = _parse_wavelengths(header.wavelength_raw)
        except ValueError:
            wavelengths = ()

        if i + 1 >= len(lines):
            raise ValueError(
                f"File truncated: no column header row after Plate: line at line {i + 1}"
            )
        layout = _parse_column_layout(lines[i + 1])

        i += 2  # Skip plate header + column header row.

        if layout.format == "flat":
            wl = wavelengths[0] if wavelengths else None
            for _ in range(header.num_readings):
                if _at_plate_end(lines, i):
                    break
                if header.measurement_type == "Kinetic" and not _kinetic_reading_present(
                    lines, i, 1
                ):
                    break

                row_fields = lines[i].split("\t")
                time_str = row_fields[0].strip()
                time_val: str | None = time_str if time_str else None
                temp_str = row_fields[1].strip()
                temp_val: float | None = float(temp_str) if temp_str else None

                for col_idx, (row_label, column_label) in enumerate(layout.well_positions):
                    val_str = row_fields[2 + col_idx].strip()
                    if not val_str:
                        continue

                    records.append(
                        {
                            "time": time_val,
                            "plate_name": header.plate_name,
                            "well_position": f"{row_label}{column_label}",
                            "temperature_c": temp_val,
                            "value": _parse_well_value(val_str),
                            "row_label": row_label,
                            "column_label": column_label,
                            "wavelength": wl,
                        }
                    )

                i += 1

                if i < len(lines) and lines[i].strip() == "":
                    i += 1
        else:
            num_cols = layout.num_data_cols
            if header.num_wells % num_cols != 0:
                raise ValueError(
                    f"num_wells ({header.num_wells}) is not evenly divisible "
                    f"by num_cols ({num_cols})"
                )
            num_rows = header.num_wells // num_cols

            offsets = layout.group_offsets or (2,)
            for _ in range(header.num_readings):
                if _at_plate_end(lines, i):
                    break
                if header.measurement_type == "Kinetic" and not _kinetic_reading_present(
                    lines, i, num_rows
                ):
                    break

                time_val = None
                temp_val = None

                for row_idx in range(num_rows):
                    row_fields = lines[i].split("\t")

                    # SoftMax Pro writes elapsed time / temperature on the first
                    # populated row of each reading group. When leading rows are
                    # unselected (e.g. edge wells skipped), that is not row A.
                    if time_val is None and row_fields and row_fields[0].strip():
                        time_val = row_fields[0].strip()
                    if temp_val is None and len(row_fields) > 1 and row_fields[1].strip():
                        temp_val = float(row_fields[1].strip())

                    row_label = _ROW_LABELS[row_idx]

                    for wl_idx, group_start in enumerate(offsets):
                        wl = wavelengths[wl_idx] if wl_idx < len(wavelengths) else None
                        for col_idx in range(num_cols):
                            val_str = row_fields[group_start + col_idx].strip()
                            if not val_str:
                                continue

                            column_label = col_idx + 1
                            records.append(
                                {
                                    "time": time_val,
                                    "plate_name": header.plate_name,
                                    "well_position": f"{row_label}{column_label}",
                                    "temperature_c": temp_val,
                                    "value": _parse_well_value(val_str),
                                    "row_label": row_label,
                                    "column_label": column_label,
                                    "wavelength": wl,
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
