"""Parse dye channel names from Azure Cielo qPCR Cq Values CSV exports."""

from __future__ import annotations
import csv
from pathlib import Path

_FLUORESCENCE_COLUMN = "Fluorescence"


def parse_dye_channels(file_path: Path) -> list[str]:
    """Extract the unique dye channel names from a Cq Values CSV file.

    Reads the ``Fluorescence`` column and returns the distinct values in the
    order they first appear.

    Args:
        file_path: Path to the Cq Values CSV file.

    Returns:
        A list of unique dye channel names, e.g. ``["ORANGE 560", "TAMRA", "ROX"]``.

    Raises:
        ValueError: If the CSV has no ``Fluorescence`` column.
    """
    seen: dict[str, None] = {}

    with open(file_path, newline="") as fh:
        reader = csv.DictReader(fh)

        if reader.fieldnames is None or _FLUORESCENCE_COLUMN not in reader.fieldnames:
            raise ValueError(
                f"CSV file is missing the required '{_FLUORESCENCE_COLUMN}' column: {file_path}"
            )

        for row in reader:
            value = row[_FLUORESCENCE_COLUMN].strip()
            if value and value not in seen:
                seen[value] = None

    if not seen:
        raise ValueError(
            f"No dye channel values found in '{_FLUORESCENCE_COLUMN}' column: {file_path}"
        )

    return list(seen)
