"""Parse instrument metadata from SpectraMax iD3 plate reader `.xls` exports.

SoftMax Pro exports plate data as tab-delimited text with an `.xls`
extension.  The plate header line (``Plate:  ...``) encodes measurement
settings, but the field layout varies by measurement mode (Absorbance vs
Fluorescence).  Fields before the ``Raw``/``Reduced`` token are stable;
fields after it shift depending on the mode.  We locate the anchor token
and read subsequent fields at fixed offsets from it.

The raw data section of each plate block is a grid of rows × columns
(e.g. 8 × 12 for 96-well, 16 × 24 for 384-well), repeated once per
reading (1 for Endpoint, *N* for Kinetic time-points, Well Scan
positions, or Spectrum wavelengths).  Each reading group is followed
by an empty separator line.  A summary table (no ``Temperature``
column header) follows the last group before ``~End``.

Spectrum scans leave the usual wavelength field empty and store the
window at fixed offsets from ``Raw`` (start, end, step).  Column 0 of
each reading group is the wavelength in nm, not elapsed time.

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
MEASUREMENT_TYPES = {"Endpoint", "Kinetic", "Spectrum", "Well Scan"}

_COL_PLATE_NAME = 1
_COL_MEASUREMENT_TYPE = 4
_COL_MEASUREMENT_MODE = 5

_ANCHOR_TOKENS = {"Raw", "Reduced"}

# First index where the anchor token can appear.  Fields 0–5 are the
# stable prefix: Plate:, plate_name, version, format, type, mode.
_RAW_SEARCH_START = 6

_OFF_NUM_READINGS = 2  # offset from Raw index
_OFF_SPECTRUM_START = 5
_OFF_SPECTRUM_END = 6
_OFF_SPECTRUM_STEP = 7
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


def _spectrum_wavelengths(start: int, end: int, step: int) -> tuple[int, ...]:
    """Expand a Spectrum scan window into discrete nanometre values."""
    if step <= 0:
        raise ValueError(f"Spectrum step must be positive, got {step}")
    wavelengths = tuple(range(start, end + 1, step))
    if not wavelengths:
        raise ValueError(f"Spectrum window {start}–{end} step {step} is empty")
    return wavelengths


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
    spectrum_start: int | None = None
    spectrum_end: int | None = None
    spectrum_step: int | None = None


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

    measurement_type = fields[_COL_MEASUREMENT_TYPE].strip()
    spectrum_start: int | None = None
    spectrum_end: int | None = None
    spectrum_step: int | None = None
    if measurement_type == "Spectrum":
        start_s = fields[raw_idx + _OFF_SPECTRUM_START].strip()
        end_s = fields[raw_idx + _OFF_SPECTRUM_END].strip()
        step_s = fields[raw_idx + _OFF_SPECTRUM_STEP].strip()
        if start_s.isdigit() and end_s.isdigit() and step_s.isdigit():
            spectrum_start = int(start_s)
            spectrum_end = int(end_s)
            spectrum_step = int(step_s)

    return _PlateHeader(
        plate_name=fields[_COL_PLATE_NAME],
        measurement_type=measurement_type,
        measurement_mode=fields[_COL_MEASUREMENT_MODE].strip(),
        num_readings=int(fields[raw_idx + _OFF_NUM_READINGS]),
        wavelength_raw=fields[raw_idx + _OFF_WAVELENGTH].strip(),
        num_wells=int(fields[raw_idx + _OFF_NUM_WELLS]),
        spectrum_start=spectrum_start,
        spectrum_end=spectrum_end,
        spectrum_step=spectrum_step,
    )


def _header_wavelengths(header: _PlateHeader) -> tuple[int, ...]:
    """Wavelengths declared on a plate header.

    Endpoint / Kinetic / Well Scan store a space-separated list in the
    usual wavelength field. Spectrum leaves that field empty and encodes
    the scan as start/end/step instead.
    """
    if header.wavelength_raw:
        return _parse_wavelengths(header.wavelength_raw)
    if (
        header.measurement_type == "Spectrum"
        and header.spectrum_start is not None
        and header.spectrum_end is not None
        and header.spectrum_step is not None
    ):
        return _spectrum_wavelengths(
            header.spectrum_start, header.spectrum_end, header.spectrum_step
        )
    raise ValueError(f"Expected space-separated numeric wavelengths, got '{header.wavelength_raw}'")


def _disambiguate_plate_name(header: _PlateHeader, seen_names: set[str]) -> str:
    """Keep the first SoftMax plate name as-is; suffix later collisions.

    One export can reuse ``Plate1`` for emission vs excitation sweeps (or
    a trailing Endpoint block). Downstream grouping keys on ``plate_name``,
    so duplicates would merge unrelated scans.
    """
    name = header.plate_name
    if name not in seen_names:
        seen_names.add(name)
        return name
    if header.spectrum_start is not None and header.spectrum_end is not None:
        return f"{name} ({header.spectrum_start}–{header.spectrum_end})"
    if header.wavelength_raw:
        return f"{name} ({header.wavelength_raw.split()[0]})"
    return f"{name} ({len(seen_names) + 1})"


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
        `wavelengths`.  Type and mode come from the first plate;
        wavelengths are the sorted union across every plate so a file
        that mixes Spectrum windows (or a trailing Endpoint) is not
        truncated to the first block.  Wavelengths are numeric strings
        (without the ``nm`` suffix) to mirror other multi-wavelength
        instruments (e.g. Azure 600 Gel Doc).  Example::

            {
                "measurement_mode": "Absorbance",
                "measurement_type": "Endpoint",
                "wavelengths": ["600", "650", "700", "750"],
            }

    Raises:
        ValueError: If the file contains no `Plate:` header or the header
            contains unexpected values.
    """
    text = file_path.read_text(encoding="utf-16")

    first_header: _PlateHeader | None = None
    wavelength_set: set[int] = set()

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
        wavelength_set.update(_header_wavelengths(header))
        if first_header is None:
            first_header = header

    if first_header is None:
        raise ValueError(f"No 'Plate:' header line found in {file_path}")

    return {
        "measurement_mode": first_header.measurement_mode,
        "measurement_type": first_header.measurement_type,
        "wavelengths": [str(w) for w in sorted(wavelength_set)],
    }


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
        time           str?    None for Endpoint and Spectrum reads
        plate_name     str     e.g. "Plate2"
        well_position  str     e.g. "A1", "H12"
        temperature_c  float?  Celsius; shared across all wells in a
                               reading group
        value          float   Raw instrument reading; ``NaN`` for wells
                               whose value was a SoftMax Pro sentinel
                               such as ``Path?`` or ``Range?``.
        row_label      str     e.g. "A"
        column_label   int     e.g. 1
        wavelength     int?    Nanometres; `None` when not reported.
                               Spectrum scans put each group's column-0
                               wavelength here (not in ``time``).
        ============== ======= ==========================================

    Raises:
        ValueError: If the file contains no `Plate:` header line.
    """
    text = file_path.read_text(encoding="utf-16")
    lines = text.splitlines()

    records: list[dict[str, object]] = []
    seen_plate_names: set[str] = set()
    i = 0

    while i < len(lines):
        if not lines[i].startswith("Plate:"):
            i += 1
            continue

        header = _parse_plate_header(lines[i])
        plate_name = _disambiguate_plate_name(header, seen_plate_names)
        is_spectrum = header.measurement_type == "Spectrum"
        try:
            wavelengths = _header_wavelengths(header)
        except ValueError:
            wavelengths = ()

        if i + 1 >= len(lines):
            raise ValueError(
                f"File truncated: no column header row after Plate: line at line {i + 1}"
            )
        layout = _parse_column_layout(lines[i + 1])

        i += 2  # Skip plate header + column header row.

        if layout.format == "flat":
            header_wl = wavelengths[0] if wavelengths else None
            for _ in range(header.num_readings):
                if _at_plate_end(lines, i):
                    break
                if header.measurement_type == "Kinetic" and not _kinetic_reading_present(
                    lines, i, 1
                ):
                    break

                row_fields = lines[i].split("\t")
                col0 = row_fields[0].strip()
                temp_str = row_fields[1].strip()
                temp_val: float | None = float(temp_str) if temp_str else None
                if is_spectrum:
                    time_val = None
                    wl = int(col0) if col0.isdigit() else header_wl
                else:
                    time_val = col0 if col0 else None
                    wl = header_wl

                for col_idx, (row_label, column_label) in enumerate(layout.well_positions):
                    val_str = row_fields[2 + col_idx].strip()
                    if not val_str:
                        continue

                    records.append(
                        {
                            "time": time_val,
                            "plate_name": plate_name,
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
                group_wavelength: int | None = None

                for row_idx in range(num_rows):
                    row_fields = lines[i].split("\t")

                    # SoftMax Pro writes elapsed time / temperature on the first
                    # populated row of each reading group. When leading rows are
                    # unselected (e.g. edge wells skipped), that is not row A.
                    # Spectrum stores wavelength in the same column-0 slot.
                    col0 = row_fields[0].strip() if row_fields else ""
                    if is_spectrum:
                        if group_wavelength is None and col0.isdigit():
                            group_wavelength = int(col0)
                    elif time_val is None and col0:
                        time_val = col0
                    if temp_val is None and len(row_fields) > 1 and row_fields[1].strip():
                        temp_val = float(row_fields[1].strip())

                    row_label = _ROW_LABELS[row_idx]

                    for wl_idx, group_start in enumerate(offsets):
                        if is_spectrum:
                            wl = group_wavelength
                        else:
                            wl = wavelengths[wl_idx] if wl_idx < len(wavelengths) else None
                        for col_idx in range(num_cols):
                            val_str = row_fields[group_start + col_idx].strip()
                            if not val_str:
                                continue

                            column_label = col_idx + 1
                            records.append(
                                {
                                    "time": time_val,
                                    "plate_name": plate_name,
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
