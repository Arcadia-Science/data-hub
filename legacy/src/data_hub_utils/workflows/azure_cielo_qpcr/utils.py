import re


def parse_run_id(filename: str) -> str | None:
    """Parses the "Experiment_YYYYMMDD" or "Experiment_YYYYMMDDHHmmss" prefix from a filename.

    Args:
        filename (str):
            The filename e.g. "Experiment_20250923_MeltingCurve.csv".

    Returns:
        str | None:
            The experiment-date prefix e.g. "Experiment_20250923" or None if not found.
    """
    match = re.match(r"(Experiment_\d{8}(?:\d{6})?)", filename)
    if match:
        return match.group(1)
    return None
