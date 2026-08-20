"""S3 utility functions for uploading and downloading files.

Ported from legacy/src/data_hub_utils/aws/s3_utils.py, but without
the global boto3 client singleton. Callers either pass an explicit
`s3_client` or one is created from ambient environment credentials.
"""

from __future__ import annotations
import logging
import mimetypes
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

S3Client = Any


def get_s3_client() -> S3Client:
    """Return a boto3 S3 client using ambient credentials (env vars / instance profile)."""
    return boto3.client("s3")


def parse_s3_uri(s3_uri: str) -> tuple[str, str]:
    """Split an S3 URI into `(bucket, key)`.

    >>> parse_s3_uri("s3://my-bucket/path/to/file.txt")
    ('my-bucket', 'path/to/file.txt')
    """
    parsed = urlparse(s3_uri)
    if parsed.scheme != "s3":
        raise ValueError(f"Invalid S3 URI: {s3_uri}")
    return parsed.netloc, parsed.path.lstrip("/")


def _extra_args(file_path: Path) -> dict[str, str]:
    """Build `ExtraArgs` for an S3 upload (content-type, disposition)."""
    args: dict[str, str] = {}
    content_type, _ = mimetypes.guess_type(str(file_path))
    if content_type:
        args["ContentType"] = content_type
        # Images and video get "inline" so browsers render / play them
        # instead of prompting a download when accessed via pre-signed URL.
        if content_type.startswith("image/") or content_type.startswith("video/"):
            args["ContentDisposition"] = "inline"
    return args


def upload_file(
    local_path: Path,
    s3_uri: str,
    *,
    s3_client: S3Client | None = None,
) -> None:
    """Upload *local_path* to *s3_uri* (e.g. `s3://bucket/key`)."""
    client = s3_client or get_s3_client()
    bucket, key = parse_s3_uri(s3_uri)
    extra = _extra_args(local_path)
    logger.debug("Uploading %s → s3://%s/%s", local_path, bucket, key)
    client.upload_file(str(local_path), bucket, key, ExtraArgs=extra)


def object_exists(
    s3_uri: str,
    *,
    s3_client: S3Client | None = None,
) -> bool:
    """Return True if *s3_uri* exists (HEAD), False when it does not.

    Missing keys normally 404. Without `s3:ListBucket`, S3 returns 403
    instead — treat that as missing too, matching `headS3Object` in
    `web/lib/s3.ts`.
    """
    client = s3_client or get_s3_client()
    bucket, key = parse_s3_uri(s3_uri)
    try:
        client.head_object(Bucket=bucket, Key=key)
    except ClientError as exc:
        error = exc.response.get("Error", {})
        code = str(error.get("Code", ""))
        status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if code in {"404", "NoSuchKey", "NotFound"} or status == 404:
            return False
        if code in {"403", "AccessDenied", "Forbidden"} or status == 403:
            logger.warning(
                "HEAD s3://%s/%s returned 403; treating as missing. "
                "If this is steady-state, grant s3:ListBucket on the bucket ARN.",
                bucket,
                key,
            )
            return False
        raise
    return True


def download_file(
    s3_uri: str,
    local_path: Path,
    *,
    s3_client: S3Client | None = None,
) -> None:
    """Download a file from *s3_uri* to *local_path*."""
    client = s3_client or get_s3_client()
    bucket, key = parse_s3_uri(s3_uri)
    local_path.parent.mkdir(parents=True, exist_ok=True)
    logger.debug("Downloading s3://%s/%s → %s", bucket, key, local_path)
    client.download_file(bucket, key, str(local_path))


def list_objects(
    s3_uri_prefix: str,
    suffix: str = "",
    *,
    s3_client: S3Client | None = None,
) -> list[str]:
    """Return S3 URIs for all objects under *s3_uri_prefix*, optionally filtered by *suffix*."""
    client = s3_client or get_s3_client()
    bucket, prefix = parse_s3_uri(s3_uri_prefix)

    object_uris: list[str] = []
    paginator = client.get_paginator("list_objects_v2")

    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if not suffix or key.endswith(suffix):
                object_uris.append(f"s3://{bucket}/{key}")

    return object_uris


def upload_folder(
    local_path: Path,
    s3_uri_prefix: str,
    *,
    s3_client: S3Client | None = None,
) -> None:
    """Upload all files in *local_path* to S3 under *s3_uri_prefix*."""
    for file_path in local_path.rglob("*"):
        if file_path.is_file():
            relative = file_path.relative_to(local_path)
            object_uri = f"{s3_uri_prefix}/{relative}".replace("\\", "/")
            upload_file(file_path, object_uri, s3_client=s3_client)


def get_content_type(file_path: Path) -> str | None:
    """Return the guessed MIME type for *file_path*, or `None`."""
    content_type, _ = mimetypes.guess_type(str(file_path))
    return content_type
