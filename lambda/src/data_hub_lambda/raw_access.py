"""Open a raw S3 object on the mount or as a downloaded copy."""

from __future__ import annotations
import json
import logging
import shutil
import stat
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from data_hub_lambda.config import lambda_config
from data_hub_lambda.deadline import check_deadline
from data_hub_shared import s3_utils

logger = logging.getLogger(__name__)

# Files at least this large are read from the mount when one is configured.
# Smaller files are downloaded, so they never wait for the mount to catch up.
MOUNT_READ_MIN_BYTES = 1024**3

# Disk kept free after a download for what the processor writes next to it,
# such as the DishCam MP4 and poster.
OUTPUT_HEADROOM_BYTES = 512 * 1024**2

MOUNT_WAIT_TIMEOUT_S = 60
MOUNT_POLL_INTERVAL_S = 2

# S3 Files never imports a key with a longer path component.
_MAX_MOUNT_NAME_BYTES = 255

_METRIC_NAMESPACE = "DataHub"
_METRIC_NAME = "RawMountWaitTimeouts"

# Lambda's disk quota is counted in binary gigabytes (1024^3).
_BYTES_PER_GB = 1024**3


class ObjectTooLargeForDiskError(Exception):
    """The raw object is already in S3, but processing cannot download it."""


class _Clock:
    def monotonic(self) -> float:
        return time.monotonic()

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds)


def _mount_root() -> Path | None:
    raw = lambda_config.RAW_DATA_MOUNT_PATH.strip()
    if not raw:
        return None
    return Path(raw)


def _mount_can_show(key: str) -> bool:
    """False for keys S3 Files never imports, so waiting for them only times out."""
    if "\x00" in key:
        return False
    return all(
        part not in {"", ".", ".."} and len(part.encode()) <= _MAX_MOUNT_NAME_BYTES
        for part in key.split("/")
    )


def _matching_size(path: Path, expected_size: int) -> bool:
    """True when *path* is a file of *expected_size*. Never lists the folder."""
    try:
        st = path.stat()
    except (FileNotFoundError, NotADirectoryError):
        return False
    except OSError as exc:
        logger.warning("Cannot read mounted file %s: %s", path, exc)
        return False
    return stat.S_ISREG(st.st_mode) and st.st_size == expected_size


def _emit_mount_wait_timeout() -> None:
    """One stdout JSON line. Lambda's logger would add a prefix and break this."""
    payload = {
        "_aws": {
            "Timestamp": int(time.time() * 1000),
            "CloudWatchMetrics": [
                {
                    "Namespace": _METRIC_NAMESPACE,
                    "Dimensions": [["Environment"]],
                    "Metrics": [{"Name": _METRIC_NAME, "Unit": "Count"}],
                }
            ],
        },
        "Environment": lambda_config.DATA_HUB_ENVIRONMENT or "unknown",
        _METRIC_NAME: 1,
    }
    print(json.dumps(payload), flush=True)


def _wait_for_mounted(root: Path, key: str, expected_size: int, clock: _Clock) -> Path | None:
    path = root / key
    deadline = clock.monotonic() + MOUNT_WAIT_TIMEOUT_S
    while True:
        check_deadline("waiting for the mounted file")
        if _matching_size(path, expected_size):
            return path
        if clock.monotonic() >= deadline:
            logger.warning(
                "Mounted raw file %s was not ready after %s seconds.",
                key,
                MOUNT_WAIT_TIMEOUT_S,
            )
            _emit_mount_wait_timeout()
            return None
        clock.sleep(MOUNT_POLL_INTERVAL_S)


def _gb(num_bytes: int) -> str:
    return f"{num_bytes / _BYTES_PER_GB:.1f}"


def _too_large_message(size: int, available: int, *, tried_mount: bool) -> str:
    size_gb = _gb(size)
    available_gb = _gb(available)
    if tried_mount:
        return (
            f"File is {size_gb} GB. It did not appear on the processing mount, "
            f"and it is larger than the {available_gb} GB of disk available for a "
            "download. The raw file is stored and can be downloaded."
        )
    return (
        f"File is {size_gb} GB, larger than the {available_gb} GB of disk "
        "available for processing. The raw file is stored and can be downloaded."
    )


@contextmanager
def local_raw_file(
    bucket: str, key: str, dest_dir: Path, *, streams: bool = False
) -> Iterator[Path]:
    """Yield a path to the raw object and delete it afterwards only if we downloaded it.

    With *streams*, files of `MOUNT_READ_MIN_BYTES` or more, and files that will
    not fit in *dest_dir* with `OUTPUT_HEADROOM_BYTES` to spare, are opened on the
    mount when `RAW_DATA_MOUNT_PATH` is set. Only callers that read the file in
    pieces pass it. A processor that loads the whole file gains nothing from the
    mount, because a file too big for the disk is too big for memory too.
    Anything else is downloaded. A mounted file is left in place: deleting
    it fails on the read-only mount and would remove fixture data locally.
    """
    s3_uri = f"s3://{bucket}/{key}"
    dest_dir.mkdir(parents=True, exist_ok=True)
    size = s3_utils.object_content_length(s3_uri)
    available = max(0, shutil.disk_usage(dest_dir).free - OUTPUT_HEADROOM_BYTES)
    fits_on_disk = size <= available
    mount_root = _mount_root() if streams else None
    tried_mount = False
    path: Path | None = None
    downloaded = False

    if mount_root is not None and (size >= MOUNT_READ_MIN_BYTES or not fits_on_disk):
        if _mount_can_show(key):
            tried_mount = True
            path = _wait_for_mounted(mount_root, key, size, _Clock())
        else:
            logger.info("S3 Files does not import %s, so it is not on the mount.", key)

    if path is None:
        if not fits_on_disk:
            raise ObjectTooLargeForDiskError(
                _too_large_message(size, available, tried_mount=tried_mount)
            )
        check_deadline("downloading the raw file")
        local = dest_dir / Path(key).name
        s3_utils.download_file(s3_uri, local)
        path = local
        downloaded = True
        logger.info("Downloaded %s to %s", s3_uri, local)
    else:
        logger.info("Reading %s from the mount at %s", s3_uri, path)

    try:
        yield path
    finally:
        if downloaded:
            path.unlink(missing_ok=True)
