"""Lambda-local utility functions.

``convert_csv_to_excel`` and ``split_file_into_n_parts`` live here because
they depend on pandas/openpyxl which are Lambda-only dependencies — they
should not be in the shared package.
"""

from __future__ import annotations
from pathlib import Path

import pandas as pd


def convert_csv_to_excel(csv_path: Path, encoding: str = "utf-8") -> Path:
    """Converts a CSV file to an Excel ``.xlsx`` file.

    Returns:
        Path to the created Excel file.
    """
    df = pd.read_csv(csv_path, encoding=encoding)
    excel_path = csv_path.with_suffix(".xlsx")
    df.to_excel(excel_path, index=False)
    return excel_path


def split_file_into_n_parts(file_path: Path, n_parts: int) -> list[Path]:
    """Splits a file into *n_parts* approximately equal binary chunks.

    Part filenames follow the pattern ``<stem>_part_NNN<suffix>``.
    Used by the Notion API's multi-part upload for files >20 MB.
    """
    file_name = file_path.stem
    file_size = file_path.stat().st_size
    chunk_size = file_size // n_parts
    remainder = file_size % n_parts

    part_files: list[Path] = []

    with open(file_path, "rb") as input_file:
        for i in range(n_parts):
            part_filename = f"{file_name}_part_{i + 1:03d}{file_path.suffix}"
            part_filepath = file_path.parent / part_filename
            current_chunk_size = chunk_size + (remainder if i == n_parts - 1 else 0)

            with open(part_filepath, "wb") as part_file:
                data = input_file.read(current_chunk_size)
                part_file.write(data)

            part_files.append(part_filepath)

    return part_files
