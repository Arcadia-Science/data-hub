import re


def parse_run_id_from_filename(filename: str) -> str:
    """
    Parses the "YYYY-MM-DD - HH-MM-SS" prefix from the CSV file name, or the
    "YYYY-MM-DD - HH.MM.SS" prefix from the PDF file name.

    Args:
        filename (str): The filename.

    Returns:
        str: The run ID e.g. "2025-09-23 - 14-08-12".
    """
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


def get_pdf_file_prefix(run_id: str) -> str:
    """Returns the prefix of the PDF filename using the given run ID.

    The PDF filename prefix is the run ID with "." instead of "-" for the
    delimiter between hours, minutes, and seconds.

    Args:
        run_id (str): The run ID e.g. "2025-09-23 - 14-08-12".

    Returns:
        str: The prefix of the PDF filename e.g. "2025-09-23 - 14.08.12".
    """
    split_run_id = run_id.split(" - ")

    date_parts = split_run_id[0].split("-")
    time_parts = split_run_id[1].split("-")

    date_with_hyphens = "-".join(date_parts)
    time_with_periods = ".".join(time_parts)

    return f"{date_with_hyphens} - {time_with_periods}"
