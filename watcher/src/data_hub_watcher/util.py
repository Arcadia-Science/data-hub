"""Small helpers shared across the watcher.

`file_digests` uses `awscrt` for CRC64NVME, the checksum S3 recommends for
a whole multipart object. Python's standard library does not implement it.
"""

from __future__ import annotations
import base64
import hashlib
from pathlib import Path

from awscrt import checksums

# 1 MiB read buffer for streamed hashing. The previous 8 KiB value
# came from CPython's example in the hashlib docs and is fine for
# small files, but instrument outputs are routinely multi-GiB and at
# 8 KiB that's hundreds of thousands of ``read()`` syscalls per file.
# 1 MiB cuts the syscall count by 128x and lets the kernel readahead
# stream the file efficiently. Memory is bounded (one buffer
# allocation per active hash), and on the parallel-upload path each
# worker thread holds at most one buffer at a time.
HASH_CHUNK_SIZE = 1 << 20


def file_digests(path: Path) -> tuple[str, str]:
    """Return ``(sha256_hex, crc64nvme_base64)`` for *path* in one read.

    Streams in :data:`HASH_CHUNK_SIZE`-byte chunks so a multi-gigabyte
    instrument file is not loaded into memory. The CRC is the value S3
    checks when a multipart upload is finished.
    """
    sha = hashlib.sha256()
    crc = 0
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(HASH_CHUNK_SIZE), b""):
            sha.update(chunk)
            crc = checksums.crc64nvme(chunk, crc)
    crc_b64 = base64.b64encode(crc.to_bytes(8, byteorder="big")).decode("ascii")
    return sha.hexdigest(), crc_b64


def file_sha256(path: Path) -> str:
    """Return the hex SHA-256 digest of *path*."""
    return file_digests(path)[0]
