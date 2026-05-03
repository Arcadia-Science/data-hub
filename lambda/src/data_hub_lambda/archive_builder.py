"""Build run-archive zips by streaming raw S3 objects directly into a
destination S3 multipart upload, with no on-disk staging.

This exists so the web app's ``download-archive`` route can offload zip
building to Lambda and serve the result via a presigned GET URL — bypassing
Vercel's Fast Origin Transfer entirely. See ``docs/architecture.md``.

Design notes:
- ``zipfile.ZipFile`` is given a file-like object (``_MultipartUploadStream``)
  that buffers writes into ~16 MB parts and flushes each via ``UploadPart``.
  This keeps memory bounded regardless of total archive size, so a 200 GB
  microscope run zips inside the Lambda's standard 10 GB memory budget.
- ``ZIP_STORED`` skips deflate entirely — instrument output is rarely
  compressible and we don't want to spend Lambda CPU on it.
- ``force_zip64=True`` on every ``ZipFile.open`` call so the writer always
  emits ZIP64 headers; without it, a single ≥4 GB entry would raise.
- Every input ``key`` is required to live under ``{instrument_id}/{run_id}/``
  in the *raw* bucket. This keeps a leaked invoke token from being usable to
  build archives of unrelated S3 prefixes.
"""

from __future__ import annotations
import logging
from dataclasses import dataclass
from typing import Any

import boto3

logger = logging.getLogger(__name__)


# S3 multipart minimum non-final part size is 5 MB; we use 16 MB to keep the
# part count low (max parts/upload is 10 000, so 16 MB × 10 000 = 156 GB,
# safely above any current run). Each part is held in memory once before being
# flushed, so the resident set stays around ~32 MB for an in-flight build.
_PART_SIZE_BYTES = 16 * 1024 * 1024

# Block size used when piping bytes from a source S3 GetObject body into the
# zip writer. Chosen to be smaller than _PART_SIZE_BYTES so we don't hold an
# entire part in a single read buffer.
_COPY_BLOCK_SIZE_BYTES = 1 * 1024 * 1024

# Maximum total size the builder will attempt. The Lambda Function URL caps
# synchronous responses at 15 minutes; at ~500 MB/s in-region S3-to-S3 that
# translates to ~450 GB worth of zipping per invocation. We bound conservatively
# at 400 GB so a slow source bucket can't push us into the timeout.
_MAX_TOTAL_BYTES = 400 * 1024 * 1024 * 1024


# ---------------------------------------------------------------------------
# Multipart upload file-like wrapper
# ---------------------------------------------------------------------------


class _MultipartUploadStream:
    """A write-only file-like that streams to S3 via multipart upload.

    Buffers writes in memory and flushes a part whenever the buffer crosses
    ``part_size``. ``close()`` finalizes the upload (or aborts if any part
    failed). The wrapper deliberately implements only the subset of the
    file protocol that ``zipfile.ZipFile(mode="w")`` actually uses: ``write``,
    ``tell``, ``flush``, and ``close``. ``ZipFile`` does not seek when given
    a file-like with no ``seek`` attribute — it falls back to writing only
    forward-compatible (ZIP64) entries.
    """

    def __init__(self, s3_client: Any, bucket: str, key: str, part_size: int) -> None:
        self._s3 = s3_client
        self._bucket = bucket
        self._key = key
        self._part_size = part_size
        self._buffer = bytearray()
        self._parts: list[dict[str, Any]] = []
        self._part_number = 1
        self._position = 0
        self._closed = False
        self._aborted = False

        response = s3_client.create_multipart_upload(Bucket=bucket, Key=key)
        self._upload_id: str = response["UploadId"]
        logger.info(
            "Started multipart upload to s3://%s/%s (upload_id=%s)", bucket, key, self._upload_id
        )

    # ZipFile uses tell() to compute the central directory offsets.
    def tell(self) -> int:
        return self._position

    def write(self, data: bytes | bytearray | memoryview) -> int:
        if self._closed:
            raise ValueError("write() on closed multipart stream")
        view = memoryview(data)
        n = len(view)
        self._buffer.extend(view)
        self._position += n

        # Flush all complete parts. Buffer can hold at most one in-progress part.
        while len(self._buffer) >= self._part_size:
            chunk = bytes(self._buffer[: self._part_size])
            del self._buffer[: self._part_size]
            self._upload_part(chunk)

        return n

    def flush(self) -> None:
        # No-op: parts are sized rigidly and S3 doesn't support partial part
        # commits. The trailing bytes are flushed in close().
        pass

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True

        try:
            if self._buffer:
                # The final part is allowed to be smaller than _PART_SIZE_BYTES.
                self._upload_part(bytes(self._buffer))
                self._buffer.clear()

            if not self._parts:
                # ZipFile always writes at least the EOCD record, so this
                # should never trigger in practice; guard anyway.
                raise RuntimeError("multipart upload completed with zero parts")

            self._s3.complete_multipart_upload(
                Bucket=self._bucket,
                Key=self._key,
                UploadId=self._upload_id,
                MultipartUpload={"Parts": self._parts},
            )
            logger.info(
                "Completed multipart upload to s3://%s/%s (%d parts, %d bytes)",
                self._bucket,
                self._key,
                len(self._parts),
                self._position,
            )
        except Exception:
            self.abort()
            raise

    def abort(self) -> None:
        if self._aborted:
            return
        self._aborted = True
        try:
            self._s3.abort_multipart_upload(
                Bucket=self._bucket, Key=self._key, UploadId=self._upload_id
            )
            logger.warning(
                "Aborted multipart upload to s3://%s/%s (upload_id=%s)",
                self._bucket,
                self._key,
                self._upload_id,
            )
        except Exception:
            logger.exception("Failed to abort multipart upload s3://%s/%s", self._bucket, self._key)

    def _upload_part(self, body: bytes) -> None:
        response = self._s3.upload_part(
            Bucket=self._bucket,
            Key=self._key,
            UploadId=self._upload_id,
            PartNumber=self._part_number,
            Body=body,
        )
        self._parts.append({"ETag": response["ETag"], "PartNumber": self._part_number})
        logger.debug(
            "Uploaded part %d (%d bytes) to s3://%s/%s",
            self._part_number,
            len(body),
            self._bucket,
            self._key,
        )
        self._part_number += 1


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


@dataclass
class ArchiveFile:
    """A single file to include in a run archive."""

    key: str
    name: str


@dataclass
class BuildArchiveRequest:
    instrument_id: str
    run_id: str
    source_bucket: str
    destination_bucket: str
    destination_key: str
    files: list[ArchiveFile]


@dataclass
class BuildArchiveResult:
    archive_bucket: str
    archive_key: str
    size_bytes: int


def parse_build_request(payload: dict[str, Any]) -> BuildArchiveRequest:
    """Validate and parse a ``build_archive`` payload from the Function URL."""
    required = ("instrument_id", "run_id", "source_bucket", "destination_bucket", "destination_key")
    for field in required:
        if not payload.get(field):
            raise ValueError(f"Missing required field: {field}")

    raw_files = payload.get("files")
    if not isinstance(raw_files, list) or not raw_files:
        raise ValueError("'files' must be a non-empty array")

    instrument_id = str(payload["instrument_id"])
    run_id = str(payload["run_id"])
    expected_prefix = f"{instrument_id}/{run_id}/"

    parsed_files: list[ArchiveFile] = []
    for entry in raw_files:
        if not isinstance(entry, dict):
            raise ValueError("Each 'files' entry must be an object")
        key = entry.get("key")
        name = entry.get("name")
        if not isinstance(key, str) or not isinstance(name, str):
            raise ValueError("Each 'files' entry must have string 'key' and 'name'")
        # Reject keys that escape the run's prefix. This makes the invoke
        # token useless for cross-run/cross-tenant archive exfiltration even
        # if an attacker controls the rest of the payload.
        if not key.startswith(expected_prefix):
            raise ValueError(f"File key '{key}' does not belong to run '{expected_prefix}'")
        if "/" in name or name in ("", ".", ".."):
            raise ValueError(f"Invalid archive entry name: {name!r}")
        parsed_files.append(ArchiveFile(key=key, name=name))

    return BuildArchiveRequest(
        instrument_id=instrument_id,
        run_id=run_id,
        source_bucket=str(payload["source_bucket"]),
        destination_bucket=str(payload["destination_bucket"]),
        destination_key=str(payload["destination_key"]),
        files=parsed_files,
    )


def build_run_archive(
    request: BuildArchiveRequest,
    *,
    s3_client: Any | None = None,
) -> BuildArchiveResult:
    """Stream every file in ``request.files`` into a ZIP at ``destination_key``.

    The archive is uploaded to S3 incrementally — no temporary files, no full
    in-memory buffer. Returns the destination location and total bytes
    uploaded on success. Aborts the multipart upload on any failure so partial
    objects don't leak.
    """
    import zipfile

    s3 = s3_client or boto3.client("s3")

    stream = _MultipartUploadStream(
        s3_client=s3,
        bucket=request.destination_bucket,
        key=request.destination_key,
        part_size=_PART_SIZE_BYTES,
    )

    try:
        # ZipFile.write() requires a real file path on disk; .open() with
        # mode="w" returns a writable handle we can stream into. Both rely
        # on the parent ZipFile having a writable, non-seekable stream.
        with zipfile.ZipFile(
            stream,  # type: ignore[arg-type]
            mode="w",
            compression=zipfile.ZIP_STORED,
            allowZip64=True,
        ) as zf:
            for file in request.files:
                _append_file_to_zip(s3, request.source_bucket, file, zf)
                if stream.tell() > _MAX_TOTAL_BYTES:
                    raise ValueError(
                        f"Archive exceeded {_MAX_TOTAL_BYTES} bytes; refusing to continue"
                    )
    except Exception:
        stream.abort()
        raise

    stream.close()

    return BuildArchiveResult(
        archive_bucket=request.destination_bucket,
        archive_key=request.destination_key,
        size_bytes=stream.tell(),
    )


def _append_file_to_zip(s3_client: Any, source_bucket: str, file: ArchiveFile, zf: Any) -> None:
    obj = s3_client.get_object(Bucket=source_bucket, Key=file.key)
    body = obj["Body"]
    try:
        # force_zip64=True makes the per-entry header ZIP64-capable so files
        # ≥4 GB don't blow up the writer mid-stream.
        with zf.open(file.name, mode="w", force_zip64=True) as entry:
            while True:
                chunk = body.read(_COPY_BLOCK_SIZE_BYTES)
                if not chunk:
                    break
                entry.write(chunk)
    finally:
        body.close()
