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
  in its source bucket. This keeps a caller with ``lambda:InvokeFunctionUrl``
  (e.g. via a compromised Vercel role) from being able to build archives of
  unrelated S3 prefixes.
- Each input file carries its own ``source_bucket`` so a single archive can
  zip files that live across the raw and processed buckets (e.g. a run with
  both raw instrument output and Lambda-produced processed artifacts). The
  caller's allow-list is enforced via ``allowed_source_buckets`` in
  ``parse_build_request`` — a caller with ``lambda:InvokeFunctionUrl`` can't
  redirect the builder at an arbitrary bucket the Lambda role happens to
  have GetObject on.
"""

from __future__ import annotations
import io
import logging
from collections.abc import Iterator
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any

import boto3

logger = logging.getLogger(__name__)


# S3 multipart minimum non-final part size is 5 MB; we use 16 MB to keep the
# part count low. Each part is held in memory once before being flushed, so
# the resident set stays around ~32 MB for an in-flight build.
_PART_SIZE_BYTES = 16 * 1024 * 1024

# Block size used when piping bytes from a source S3 GetObject body into the
# zip writer. Chosen to be smaller than _PART_SIZE_BYTES so we don't hold an
# entire part in a single read buffer.
_COPY_BLOCK_SIZE_BYTES = 1 * 1024 * 1024

# S3 enforces a hard cap of 10 000 parts per multipart upload. We treat this
# as the architectural ceiling for a single archive — exceeding it means
# either the part size is too small or the run is genuinely too large to zip
# in one Lambda invocation. With the default 16 MB parts that's a 156 GB
# total cap, well above the ~25–30 GB real-world archives we see today.
_MAX_PARTS = 10_000

# Maximum total size the builder will attempt, derived from the part size +
# S3's part-count cap so the byte and part limits never disagree. The check
# in ``build_run_archive`` aborts between files; the per-part guard in
# ``_MultipartUploadStream._upload_part`` catches the within-a-single-file
# case before it reaches S3.
_MAX_TOTAL_BYTES = _PART_SIZE_BYTES * _MAX_PARTS

# The bottleneck for runs with thousands of tiny files is per-object
# ``GetObject`` latency, not bandwidth, so overlapping fetches collapses what
# was a serial chain of round-trips.
_PREFETCH_CONCURRENCY = 16

# Files at or below this size are prefetched into memory; larger and
# unknown-size files stream inline so peak memory stays bounded regardless of
# total archive size (a 200 GB single-file run must still fit the Lambda).
_PREFETCH_MAX_FILE_BYTES = 16 * 1024 * 1024

# Bounds peak memory from the look-ahead window (many ``_PREFETCH_MAX_FILE_BYTES``
# files queued ahead of a slow writer) independently of ``_PREFETCH_CONCURRENCY``.
_PREFETCH_MAX_INFLIGHT_BYTES = 256 * 1024 * 1024


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
        # Fail fast before the request would be rejected by S3 with an
        # opaque ``InvalidArgument`` — the inter-file ``_MAX_TOTAL_BYTES``
        # check in ``build_run_archive`` won't catch a single huge file
        # that crosses the 10 000-part boundary mid-stream.
        if self._part_number > _MAX_PARTS:
            raise ValueError(
                f"Archive would exceed S3's {_MAX_PARTS}-part multipart upload cap "
                f"(part size = {self._part_size} bytes); refusing to continue"
            )
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
    """A single file to include in a run archive.

    ``source_bucket`` is per-file so the builder can zip across the raw and
    processed buckets in a single archive — the web app sends each file's
    bucket alongside its key.

    ``size_bytes`` is an optional hint used solely to decide whether a file is
    small enough to prefetch into memory concurrently (see ``build_run_archive``).
    It does not affect correctness: an unknown size is treated as "too large to
    buffer" and the file is streamed inline. Never trusted for allocation.
    """

    key: str
    name: str
    source_bucket: str
    size_bytes: int | None = None


@dataclass
class BuildArchiveRequest:
    instrument_id: str
    run_id: str
    destination_bucket: str
    destination_key: str
    files: list[ArchiveFile]


@dataclass
class BuildArchiveResult:
    archive_bucket: str
    archive_key: str
    size_bytes: int


def parse_build_request(
    payload: dict[str, Any],
    *,
    allowed_source_buckets: set[str] | None = None,
) -> BuildArchiveRequest:
    """Validate and parse a ``build_archive`` payload from the Function URL.

    ``allowed_source_buckets``, when supplied, restricts the set of buckets
    files may reference. The handler passes the Lambda's configured raw +
    processed bucket names so a caller with ``lambda:InvokeFunctionUrl``
    can't be used to read arbitrary buckets the Lambda role might otherwise
    be able to GetObject on. Tests pass ``None`` to skip the check.

    Each file may specify its own ``source_bucket``. For backward compat
    with the older single-bucket payload, a top-level ``source_bucket`` is
    accepted as a fallback for files that omit it. New callers should always
    set the per-file field.
    """
    required = ("instrument_id", "run_id", "destination_bucket", "destination_key")
    for field in required:
        if not payload.get(field):
            raise ValueError(f"Missing required field: {field}")

    raw_files = payload.get("files")
    if not isinstance(raw_files, list) or not raw_files:
        raise ValueError("'files' must be a non-empty array")

    fallback_bucket = payload.get("source_bucket")
    if fallback_bucket is not None and not isinstance(fallback_bucket, str):
        raise ValueError("'source_bucket' must be a string when provided")

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

        # Per-file `source_bucket` wins; fall back to the top-level field for
        # legacy clients that haven't migrated yet.
        bucket = entry.get("source_bucket", fallback_bucket)
        if not isinstance(bucket, str) or not bucket:
            raise ValueError(
                "Each 'files' entry must specify a non-empty 'source_bucket' "
                "(or a top-level 'source_bucket' must be provided as a fallback)"
            )
        if allowed_source_buckets is not None and bucket not in allowed_source_buckets:
            raise ValueError(
                f"source_bucket '{bucket}' is not in this Lambda's allow-list of source buckets"
            )

        # Reject keys that escape the run's prefix. This makes the invoke
        # token useless for cross-run/cross-tenant archive exfiltration even
        # if an attacker controls the rest of the payload.
        if not key.startswith(expected_prefix):
            raise ValueError(f"File key '{key}' does not belong to run '{expected_prefix}'")
        if "/" in name or name in ("", ".", ".."):
            raise ValueError(f"Invalid archive entry name: {name!r}")

        # Optional prefetch hint, coerced leniently: anything but a
        # non-negative int becomes ``None`` ("unknown" size), so a malformed
        # value streams the file inline rather than failing the build.
        raw_size = entry.get("size_bytes")
        size_bytes = raw_size if isinstance(raw_size, int) and raw_size >= 0 else None
        parsed_files.append(
            ArchiveFile(key=key, name=name, source_bucket=bucket, size_bytes=size_bytes)
        )

    return BuildArchiveRequest(
        instrument_id=instrument_id,
        run_id=run_id,
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

    Source objects that fit under ``_PREFETCH_MAX_FILE_BYTES`` are fetched
    concurrently a window ahead of the writer (see ``_iter_archive_readers``),
    which collapses the per-object GetObject latency that otherwise dominates
    runs with thousands of tiny files. The zip is still written single-threaded
    and in request order, so entry ordering and the multipart stream are
    untouched. Larger (or unknown-size) files stream inline to keep memory
    bounded.
    """
    import zipfile

    s3 = s3_client or boto3.client("s3")

    stream = _MultipartUploadStream(
        s3_client=s3,
        bucket=request.destination_bucket,
        key=request.destination_key,
        part_size=_PART_SIZE_BYTES,
    )

    # Managed by hand rather than ``with`` so the error path can cancel
    # queued-but-unstarted prefetches via ``cancel_futures=True``, instead of
    # draining doomed ``GetObject`` work before the exception surfaces.
    executor = ThreadPoolExecutor(max_workers=_PREFETCH_CONCURRENCY)
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
            for file, reader in _iter_archive_readers(s3, request.files, executor):
                _write_reader_to_zip(reader, file.name, zf)
                if stream.tell() > _MAX_TOTAL_BYTES:
                    raise ValueError(
                        f"Archive exceeded the {_MAX_TOTAL_BYTES}-byte cap "
                        f"({_MAX_PARTS} S3 parts × {_PART_SIZE_BYTES} bytes); "
                        f"refusing to continue"
                    )
    except Exception:
        stream.abort()
        raise
    finally:
        executor.shutdown(cancel_futures=True)

    stream.close()

    return BuildArchiveResult(
        archive_bucket=request.destination_bucket,
        archive_key=request.destination_key,
        size_bytes=stream.tell(),
    )


def _is_prefetch_eligible(file: ArchiveFile) -> bool:
    # Unknown size → not eligible: we can't admit it to the byte budget, and
    # the safe assumption is that it might be huge, so it streams inline.
    return file.size_bytes is not None and file.size_bytes <= _PREFETCH_MAX_FILE_BYTES


def _fetch_to_buffer(s3_client: Any, file: ArchiveFile) -> io.BytesIO:
    """Read a small source object fully into memory, on a worker thread.

    Only ever called for ``_is_prefetch_eligible`` files, so the buffer is
    bounded by ``_PREFETCH_MAX_FILE_BYTES``.
    """
    obj = s3_client.get_object(Bucket=file.source_bucket, Key=file.key)
    body = obj["Body"]
    try:
        return io.BytesIO(body.read())
    finally:
        body.close()


def _iter_archive_readers(
    s3_client: Any,
    files: list[ArchiveFile],
    executor: ThreadPoolExecutor,
) -> Iterator[tuple[ArchiveFile, Any]]:
    """Yield ``(file, reader)`` pairs in request order, prefetching small files.

    A sliding window of up to ``_PREFETCH_CONCURRENCY`` eligible files (and at
    most ``_PREFETCH_MAX_INFLIGHT_BYTES`` of buffered data) is fetched ahead of
    the consumer on worker threads. ``reader`` is an in-memory ``BytesIO`` for
    prefetched files, or the live ``StreamingBody`` for inline (large/unknown)
    files fetched lazily when the consumer reaches them. Either way the reader
    exposes ``read(n)``/``close()`` so the writer treats them identically.

    The submission cursor advances past inline files without buffering them, so
    a single large file in the middle of a run doesn't stall prefetching of the
    small files after it.
    """
    n = len(files)
    submit_idx = 0
    inflight_bytes = 0
    futures: dict[int, Future[io.BytesIO]] = {}

    def _pump() -> None:
        nonlocal submit_idx, inflight_bytes
        while submit_idx < n and len(futures) < _PREFETCH_CONCURRENCY:
            file = files[submit_idx]
            if not _is_prefetch_eligible(file):
                # Streamed inline at consume time; advance so the window can
                # keep reaching the small files beyond it.
                submit_idx += 1
                continue
            size = file.size_bytes or 0
            # Always allow at least one in-flight fetch; otherwise honor the
            # byte budget so the look-ahead window can't balloon memory.
            if futures and inflight_bytes + size > _PREFETCH_MAX_INFLIGHT_BYTES:
                break
            futures[submit_idx] = executor.submit(_fetch_to_buffer, s3_client, file)
            inflight_bytes += size
            submit_idx += 1

    try:
        for idx in range(n):
            file = files[idx]
            _pump()
            future = futures.pop(idx, None)
            if future is not None:
                buffer = future.result()
                inflight_bytes -= file.size_bytes or 0
                yield file, buffer
            else:
                # Large/unknown-size file: stream it inline, lazily, now.
                obj = s3_client.get_object(Bucket=file.source_bucket, Key=file.key)
                yield file, obj["Body"]
    finally:
        # On early exit (writer error mid-stream) cancel prefetches we never
        # consumed so the executor's shutdown doesn't block on doomed work.
        for future in futures.values():
            future.cancel()


def _write_reader_to_zip(reader: Any, name: str, zf: Any) -> None:
    try:
        # force_zip64=True makes the per-entry header ZIP64-capable so files
        # ≥4 GB don't blow up the writer mid-stream.
        with zf.open(name, mode="w", force_zip64=True) as entry:
            while True:
                chunk = reader.read(_COPY_BLOCK_SIZE_BYTES)
                if not chunk:
                    break
                entry.write(chunk)
    finally:
        reader.close()
