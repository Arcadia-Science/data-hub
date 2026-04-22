"""Small, dependency-free helpers shared across the watcher.

Keep this module lightweight — it is imported by both the monitor and
the uploader, so introducing heavy imports here would pull them into
every startup path.
"""

from __future__ import annotations
import hashlib
from pathlib import Path


def file_sha256(path: Path) -> str:
    """Return the hex SHA-256 digest of *path*.

    Streams the file in 8 KiB chunks so we don't load multi-GiB
    instrument outputs into memory. Lives here rather than next to the
    uploader so callers don't have to import the full upload module
    just to hash a file.
    """
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()
