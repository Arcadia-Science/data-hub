"""S3 utility functions for uploading and downloading files.

Ported from legacy/src/data_hub_utils/aws/s3_utils.py, but without
the global boto3 client singleton. Callers either pass an explicit
``s3_client`` or one is created from ambient environment credentials.
"""

from __future__ import annotations
import logging
import mimetypes
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import boto3

logger = logging.getLogger(__name__)

S3Client = Any


def get_s3_client() -> S3Client:
    """Return a boto3 S3 client using ambient credentials (env vars / instance profile)."""
    return boto3.client("s3")


def parse_s3_uri(s3_uri: str) -> tuple[str, str]:
    """Split an S3 URI into ``(bucket, key)``.

    >>> parse_s3_uri("s3://my-bucket/path/to/file.txt")
    ('my-bucket', 'path/to/file.txt')
    """
    parsed = urlparse(s3_uri)
    if parsed.scheme != "s3":
        raise ValueError(f"Invalid S3 URI: {s3_uri}")
    return parsed.netloc, parsed.path.lstrip("/")


def _extra_args(file_path: Path) -> dict[str, str]:
    """Build ``ExtraArgs`` for an S3 upload (content-type, disposition)."""
    args: dict[str, str] = {}
    content_type, _ = mimetypes.guess_type(str(file_path))
    if content_type:
        args["ContentType"] = content_type
        # Images get "inline" disposition so browsers render them directly
        # instead of prompting a download when accessed via pre-signed URL.
        if content_type.startswith("image/"):
            args["ContentDisposition"] = "inline"
    return args


def upload_file(
    local_path: Path,
    s3_uri: str,
    *,
    s3_client: S3Client | None = None,
) -> None:
    """Upload *local_path* to *s3_uri* (e.g. ``s3://bucket/key``)."""
    client = s3_client or get_s3_client()
    bucket, key = parse_s3_uri(s3_uri)
    extra = _extra_args(local_path)
    logger.debug("Uploading %s → s3://%s/%s", local_path, bucket, key)
    client.upload_file(str(local_path), bucket, key, ExtraArgs=extra)


def get_content_type(file_path: Path) -> str | None:
    """Return the guessed MIME type for *file_path*, or ``None``."""
    content_type, _ = mimetypes.guess_type(str(file_path))
    return content_type
