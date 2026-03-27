from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import requests


def get_current_utc_time() -> str:
    """Returns the current UTC time as a string."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")  # noqa: UP017


def split_file_into_n_parts(file_path: Path, n_parts: int) -> list[Path]:
    """Splits a file into N approximately equal parts.

    Args:
        file_path (Path):
            Path to the file to split.
        n_parts (int):
            Number of parts to create.

    Returns:
        list[Path]:
            A list of filenames for the created parts. The filenames will be
            of the form "<original_filename>_part_<part_number>.ext".
    """
    file_name = file_path.name.replace(file_path.suffix, "")
    file_size = file_path.stat().st_size
    chunk_size = file_size // n_parts
    remainder = file_size % n_parts

    part_files = []

    with open(file_path, "rb") as input_file:
        for i in range(n_parts):
            # Create the part filename.
            part_filename = f"{file_name}_part_{i + 1:03d}{file_path.suffix}"
            part_filepath = file_path.parent / part_filename

            # Add remainder to the last part.
            current_chunk_size = chunk_size + (remainder if i == n_parts - 1 else 0)

            with open(part_filepath, "wb") as part_file:
                data = input_file.read(current_chunk_size)
                part_file.write(data)

            part_files.append(part_filepath)

    return part_files


def convert_csv_to_excel(csv_path: Path, encoding: str = "utf-8") -> Path:
    """Converts a CSV file to an Excel file.

    Args:
        csv_path (Path): Path to the CSV file to convert.
        encoding (str): The encoding of the CSV file.

    Returns:
        Path: Path to the Excel file.
    """
    df = pd.read_csv(csv_path, encoding=encoding)  # noqa: F821
    excel_path = csv_path.with_suffix(".xlsx")
    df.to_excel(excel_path, index=False)
    return excel_path


def download_file_from_url(url: str, file_path: Path) -> None:
    """Downloads a file from a URL to a local path.

    Args:
        url (str): The URL of the file to download.
        file_path (Path): The path to the file to download.
    """
    file_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        response = requests.get(url, stream=True)
        response.raise_for_status()
    except Exception as e:
        raise e

    with open(file_path, "wb") as file:
        # Iterate over the response content in chunks to handle large files efficiently.
        for chunk in response.iter_content(chunk_size=8192):
            file.write(chunk)
