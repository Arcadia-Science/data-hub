"""Small, dependency-free helpers shared across the watcher.

Keep this module lightweight — it is imported by both the monitor and
the uploader, so introducing heavy imports here would pull them into
every startup path.
"""

from __future__ import annotations
import hashlib
from pathlib import Path

# 1 MiB read buffer for streamed hashing. The previous 8 KiB value
# came from CPython's example in the hashlib docs and is fine for
# small files, but instrument outputs are routinely multi-GiB and at
# 8 KiB that's hundreds of thousands of ``read()`` syscalls per file.
# 1 MiB cuts the syscall count by 128x and lets the kernel readahead
# stream the file efficiently. Memory is bounded (one buffer
# allocation per active hash), and on the parallel-upload path each
# worker thread holds at most one buffer at a time.
HASH_CHUNK_SIZE = 1 << 20


def file_sha256(path: Path) -> str:
    """Return the hex SHA-256 digest of *path*.

    Streams the file in :data:`HASH_CHUNK_SIZE`-byte chunks so we don't
    load multi-GiB instrument outputs into memory. Lives here rather
    than next to the uploader so callers don't have to import the full
    upload module just to hash a file.
    """
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(HASH_CHUNK_SIZE), b""):
            h.update(chunk)
    return h.hexdigest()
