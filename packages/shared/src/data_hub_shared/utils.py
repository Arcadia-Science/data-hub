from __future__ import annotations
from datetime import datetime, timezone
from pathlib import Path

import requests


def get_current_utc_time() -> str:
    """Returns the current UTC time as a ``YYYY-MM-DD HH:MM:SS`` string."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")  # noqa: UP017


def download_file_from_url(url: str, file_path: Path) -> None:
    """Downloads a file from *url* to *file_path*."""
    file_path.parent.mkdir(parents=True, exist_ok=True)

    response = requests.get(url, stream=True)
    response.raise_for_status()

    with open(file_path, "wb") as file:
        for chunk in response.iter_content(chunk_size=8192):
            file.write(chunk)
