from __future__ import annotations
import re


def parse_run_id_from_filename(filename: str) -> str:
    """Parses the ``YYYY-MM-DD - HH-MM-SS`` run ID prefix from a TapeStation filename."""
    if filename.endswith(".pdf"):
        pattern = r"(\d{4}-\d{2}-\d{2} - \d{2}\.\d{2}\.\d{2})"
    elif filename.endswith(".csv"):
        pattern = r"(\d{4}-\d{2}-\d{2} - \d{2}-\d{2}-\d{2})"
    else:
        raise ValueError(f"Unsupported file type: {filename}")

    match = re.match(pattern, filename)
    if match:
        run_id = match.group(1)
        return run_id.replace(".", "-")

    raise ValueError(f"No run ID found in filename: {filename}")


def parse_tape_type(filename: str) -> str | None:
    """Extracts the tape type from a TapeStation CSV filename.

    Filenames follow the pattern ``YYYY-MM-DD - HH-MM-SS-<TapeType>_<suffix>.csv``.
    For example:

    - ``2026-02-18 - 18-00-04-gDNA_peakTable.csv`` → ``"gDNA"``
    - ``2026-02-18 - 18-00-04-HSD1000_peakTable.csv`` → ``"HSD1000"``

    Returns ``None`` for non-CSV files or if the pattern doesn't match.
    """
    if not filename.endswith(".csv"):
        return None

    match = re.match(r"\d{4}-\d{2}-\d{2} - \d{2}-\d{2}-\d{2}-([^_]+)_", filename)
    return match.group(1) if match else None


def get_pdf_file_prefix(run_id: str) -> str:
    """Returns the PDF filename prefix (periods instead of hyphens in time part)."""
    split_run_id = run_id.split(" - ")
    date_parts = split_run_id[0].split("-")
    time_parts = split_run_id[1].split("-")
    date_with_hyphens = "-".join(date_parts)
    time_with_periods = ".".join(time_parts)
    return f"{date_with_hyphens} - {time_with_periods}"
