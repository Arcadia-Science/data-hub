from __future__ import annotations
import re


def parse_run_id(filename: str) -> str | None:
    """Parses the `Experiment_YYYYMMDD` prefix from a filename."""
    match = re.match(r"(Experiment_\d{8}(?:\d{6})?)", filename)
    if match:
        return match.group(1)
    return None
