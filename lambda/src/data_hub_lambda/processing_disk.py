"""Refuse to download a raw file that will not fit on the function's disk."""

from __future__ import annotations
import shutil
from pathlib import Path

from data_hub_shared import s3_utils

# Lambda's disk quota is counted in binary gigabytes (1024^3).
_BYTES_PER_GB = 1024**3


class ObjectTooLargeForDiskError(Exception):
    """The raw object is already in S3, but processing cannot download it."""


def ensure_object_fits_on_disk(s3_uri: str, dest_dir: Path) -> None:
    """Raise when *s3_uri* is larger than the free space on *dest_dir*.

    Processors download the whole object before they write outputs next
    to it. A file bigger than the free space fails the download with a
    full disk, which hides the reason.
    """
    size = s3_utils.object_content_length(s3_uri)
    dest_dir.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(dest_dir).free
    if size > free:
        raise ObjectTooLargeForDiskError(
            f"File is {_gb(size)} GB, larger than the {_gb(free)} GB of disk "
            "available for processing. The raw file is stored and can be downloaded."
        )


def _gb(num_bytes: int) -> str:
    return f"{num_bytes / _BYTES_PER_GB:.1f}"
