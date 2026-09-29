"""Open a raw S3 object on the mount or as a downloaded copy."""

from __future__ import annotations
import json
import logging
import os
import shutil
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from data_hub_lambda.deadline import check_deadline
from data_hub_lambda.processing_disk import ObjectTooLargeForDiskError, ensure_object_fits_on_disk
from data_hub_shared import s3_utils
from data_hub_shared.config import config

logger = logging.getLogger(__name__)

# Files at least this large are read from the mount when one is configured.
# Smaller files are downloaded, so they never wait for the mount to catch up.
MOUNT_READ_MIN_BYTES = 1024**3

MOUNT_WAIT_TIMEOUT_S = 60
MOUNT_POLL_INTERVAL_S = 2

_METRIC_NAMESPACE = "DataHub"
_METRIC_NAME = "RawMountWaitTimeouts"


class _Clock:
    def monotonic(self) -> float:
        return time.monotonic()

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds)


def _mount_root() -> Path | None:
    raw = config.RAW_DATA_MOUNT_PATH.strip()
    if not raw:
        return None
    return Path(raw)


def _object_key(s3_uri: str) -> str:
    _bucket, key = s3_utils.parse_s3_uri(s3_uri)
    return key


def _matching_size(path: Path, expected_size: int) -> bool:
    """True when *path* is a file of *expected_size*. Never lists the folder."""
    try:
        return path.is_file() and path.stat().st_size == expected_size
    except OSError:
        return False


def _emit_mount_wait_timeout() -> None:
    """One stdout JSON line. Lambda's logger would add a prefix and break this."""
    environment = os.getenv("DATA_HUB_ENVIRONMENT") or "unknown"
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
        "Environment": environment,
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
    return f"{num_bytes / 1024**3:.1f}"


def _too_large_message(size: int, free: int, *, tried_mount: bool) -> str:
    size_gb = _gb(size)
    free_gb = _gb(free)
    if tried_mount:
        return (
            f"File is {size_gb} GB. It did not appear on the processing mount, "
            f"and it is larger than the {free_gb} GB of disk available for a "
            "download. The raw file is stored and can be downloaded."
        )
    return (
        f"File is {size_gb} GB, larger than the {free_gb} GB of disk "
        "available for processing. The raw file is stored and can be downloaded."
    )


@contextmanager
def local_raw_file(s3_uri: str, dest_dir: Path) -> Iterator[Path]:
    """Yield a path to *s3_uri* and delete it afterwards only if we downloaded it.

    Files of `MOUNT_READ_MIN_BYTES` or more, and files that will not fit in
    *dest_dir*, are opened on the mount when `RAW_DATA_MOUNT_PATH` is set.
    Anything else is downloaded. A mounted file is left in place: deleting
    it fails on the read-only mount and would remove fixture data locally.
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    size = s3_utils.object_content_length(s3_uri)
    free = shutil.disk_usage(dest_dir).free
    mount_root = _mount_root()
    tried_mount = False
    path: Path | None = None
    downloaded = False

    if mount_root is not None and (size >= MOUNT_READ_MIN_BYTES or size > free):
        tried_mount = True
        path = _wait_for_mounted(mount_root, _object_key(s3_uri), size, _Clock())

    if path is None:
        if size > free:
            raise ObjectTooLargeForDiskError(
                _too_large_message(size, free, tried_mount=tried_mount)
            )
        check_deadline("downloading the raw file")
        ensure_object_fits_on_disk(s3_uri, dest_dir, size_bytes=size)
        local = dest_dir / Path(_object_key(s3_uri)).name
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
