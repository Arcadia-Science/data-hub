"""Presigned-URL upload with retry, API notification, and local state recording.

`Uploader` handles both auto-mode (immediate upload after run detection)
and manual-mode (poll the server's upload queue on heartbeat ticks).

Files are uploaded via presigned S3 PUT URLs obtained from the API, so the
watcher does not need AWS credentials.
"""

from __future__ import annotations
import logging
import mimetypes
import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import dataclass
from pathlib import Path

import requests as http_requests
from requests.adapters import HTTPAdapter

from data_hub_watcher.api_client import ApiError, DataHubClient
from data_hub_watcher.constants import (
    MAX_QUEUE_FILE_ATTEMPTS,
    UPLOAD_RETRY_BASE_DELAY,
    UPLOAD_RETRY_MAX,
)
from data_hub_watcher.events import EventReporter, EventType, WatcherEvent
from data_hub_watcher.heartbeat import WatcherCounters
from data_hub_watcher.models import UploadQueueFile
from data_hub_watcher.run_detector import FileInfo, file_created_at
from data_hub_watcher.state import StateDB
from data_hub_watcher.util import file_sha256

logger = logging.getLogger(__name__)


@dataclass
class _QueueAttempt:
    """Per-file bookkeeping for manual-mode upload-queue retries.

    ``count`` is the number of consecutive heartbeat polls that have failed
    to upload the file (missing on disk or upload error); ``reason`` is the
    most recent failure cause, surfaced in the give-up event.
    """

    count: int
    reason: str


def _guess_content_type(path: Path) -> str | None:
    content_type, _ = mimetypes.guess_type(str(path))
    return content_type


def _relative_path(path: Path, watch_dir: Path) -> str:
    """Return *path* as a forward-slash relative to *watch_dir*.

    Falls back to the basename for paths outside the watch directory
    (e.g. one-shot `upload --file /abs/path`) so we never raise during
    upload recording.
    """
    try:
        return path.relative_to(watch_dir).as_posix()
    except ValueError:
        return path.name


class Uploader:
    """Uploads files via presigned S3 PUT URLs and notifies the Data Hub API.

    Parameters
    ----------
    client:
        API client for presigned URL requests and file status updates.
    state_db:
        Local SQLite DB for deduplication.
    event_reporter:
        For queuing upload events.
    counters:
        Heartbeat counters incremented on each upload.
    instrument_id:
        Instrument identifier for API calls.
    watcher_id:
        Watcher identity for queue polling.
    watch_directory:
        Root watch directory for resolving relative paths in queue mode.
    upload_parallelism:
        Maximum number of files to upload concurrently within a single
        :meth:`upload_files` batch. Defaults to 1 (fully serial) so
        unit tests and call sites that don't pass an explicit value
        keep their previous behaviour. Production wiring (see
        ``runtime.build_runtime``) reads this from the per-instrument
        config.
    """

    def __init__(
        self,
        *,
        client: DataHubClient,
        state_db: StateDB,
        event_reporter: EventReporter,
        counters: WatcherCounters,
        instrument_id: str,
        watcher_id: str,
        watch_directory: Path,
        upload_parallelism: int = 1,
    ) -> None:
        self._client = client
        self._state_db = state_db
        self._reporter = event_reporter
        self._counters = counters
        self._instrument_id = instrument_id
        self._watcher_id = watcher_id
        self._watch_dir = watch_directory
        if upload_parallelism < 1:
            raise ValueError(f"upload_parallelism must be >= 1, got {upload_parallelism}")
        self._parallelism = upload_parallelism
        # Track consecutive upload-queue poll failures so the watcher
        # surfaces a ``kind=upload_queue_poll_failed`` event on the
        # 1st failure and every 10th repeat. The unthrottled case
        # would emit one event per heartbeat tick during an outage,
        # crowding out other signals on the dashboard.
        # Mutated only from the heartbeat thread (manual mode), so
        # not under any explicit lock.
        self._consecutive_queue_poll_failures = 0
        # Per-file upload-queue attempt bookkeeping, keyed by server file id.
        # Bounds retries before giving up (see ``_process_queued_file``) and
        # doubles as the emit-once throttle for the missing-file error. Pruned
        # each poll, so a re-requested id starts fresh. Heartbeat thread only.
        self._queue_attempts: dict[int, _QueueAttempt] = {}
        # Single ``requests.Session`` shared across every S3 PUT
        # (parallel or serial). Keeps TLS connections alive between
        # presigned URLs that target the same S3 bucket -- avoids
        # paying the handshake cost on every file in a multi-file
        # run. ``requests.Session`` is documented as thread-safe for
        # concurrent ``put`` calls.
        self._s3_session = http_requests.Session()
        # Size the urllib3 pool to match ``upload_parallelism`` so we
        # never trip the "Connection pool is full, discarding
        # connection" warning that the default ``pool_maxsize=10``
        # produces once parallelism exceeds 10 -- which the model
        # explicitly allows (``ge=1, le=32``). Discarded connections
        # defeat the keep-alive optimisation this session exists for.
        # ``pool_connections`` controls the number of *host* pools;
        # presigned S3 PUTs typically hit a single bucket-host so one
        # is enough, but matching ``pool_maxsize`` is harmless and
        # leaves room for cross-bucket fan-out if a future config does
        # that. ``pool_block=False`` (the default) preserves the prior
        # behaviour of spinning up a transient connection if the pool
        # is momentarily exhausted instead of blocking the worker.
        adapter = HTTPAdapter(
            pool_connections=upload_parallelism,
            pool_maxsize=upload_parallelism,
        )
        self._s3_session.mount("https://", adapter)
        self._s3_session.mount("http://", adapter)
        # Counter mutations from upload worker threads are protected
        # by the GIL on the underlying ``int`` increment, but use an
        # explicit lock anyway so we can later move to ``threading.
        # Lock``-free atomics or ``itertools.count`` without a behaviour
        # change. Cheap enough at the per-file cadence that the
        # serialisation cost is negligible.
        self._counters_lock = threading.Lock()

    # ------------------------------------------------------------------
    # Auto-mode: upload a batch of files for a reported run
    # ------------------------------------------------------------------

    def upload_files(self, run_id: str, files: list[FileInfo]) -> int:
        """Upload every file in *files* for the given *run_id*.

        Called by `RunDetector` immediately after a successful run report
        (auto mode only).  Returns the number of files successfully uploaded.

        When ``upload_parallelism > 1`` the per-file
        :meth:`_upload_single` calls run in a short-lived
        :class:`~concurrent.futures.ThreadPoolExecutor`. The pool is
        scoped to a single batch (created and torn down per call) so
        idle worker threads don't outlive the run -- watcher hosts are
        long-lived and an always-on pool would just be holding socket
        FDs and Python frames around for nothing between runs.
        """
        if not files:
            # Avoid spinning up a pool for a (rare) empty manifest;
            # also preserves the existing "succeeded == len(files)"
            # check below which would mark the run uploaded with
            # zero work.
            self._state_db.record_run_uploaded(run_id)
            return 0

        # Upper-bound parallelism by the actual file count so a small
        # batch doesn't allocate more threads than it can use.
        max_workers = min(self._parallelism, len(files))

        if max_workers <= 1:
            # Fast path: avoid the pool's overhead (thread spin-up,
            # ``Future`` wrapping) when there's nothing to parallelise.
            # Behaviour-identical to the previous serial loop.
            succeeded = sum(1 for info in files if self._upload_single(info.path, run_id))
        else:
            with ThreadPoolExecutor(
                max_workers=max_workers,
                thread_name_prefix="uploader",
            ) as pool:
                futures = [pool.submit(self._upload_single, info.path, run_id) for info in files]
                # ``wait`` (rather than ``as_completed``) keeps the
                # success count deterministic without caring about
                # completion order. Any exception raised inside
                # ``_upload_single`` would already have been caught
                # and translated into a ``False`` return by the
                # function's own error-handling, so we can safely
                # treat ``future.result()`` as boolean.
                wait(futures)
                succeeded = sum(1 for f in futures if f.result())

        if succeeded == len(files):
            self._state_db.record_run_uploaded(run_id)
        else:
            logger.warning(
                "Not marking run %s as uploaded: %d/%d files succeeded",
                run_id,
                succeeded,
                len(files),
            )

        return succeeded

    # ------------------------------------------------------------------
    # Manual-mode: poll the server queue
    # ------------------------------------------------------------------

    def poll_upload_queue(self) -> None:
        """Fetch the upload queue and process each file.

        Intended to be called on heartbeat ticks in manual mode.
        """
        try:
            queue = self._client.get_upload_queue(self._watcher_id)
        except ApiError as exc:
            logger.warning("Failed to fetch upload queue: %s", exc.message)
            # Route through the shared helper so every error increment
            # (whether emitted from the heartbeat thread here or from
            # an upload-pool worker in ``_upload_single``) goes through
            # the same lock. Inconsistent locking would race the
            # heartbeat reader against parallel-upload writers and
            # surface as off-by-one error totals.
            self._bump_errors()
            self._consecutive_queue_poll_failures += 1
            # Emit on first failure, then every 10th, so a sustained
            # outage stays visible without flooding the queue.
            if (
                self._consecutive_queue_poll_failures == 1
                or self._consecutive_queue_poll_failures % 10 == 0
            ):
                self._reporter.report_error(
                    "upload_queue_poll_failed",
                    f"Failed to fetch upload queue: {exc.message}",
                    error=exc.message,
                    consecutive_failures=self._consecutive_queue_poll_failures,
                )
            return

        # Reset on any success -- the next failure starts a fresh
        # outage window so the throttled emissions are accurate.
        self._consecutive_queue_poll_failures = 0

        # Prune attempt records for files no longer pending (uploaded,
        # cancelled, or dismissed) so the dict tracks only the live queue
        # and a re-requested id starts a fresh attempt window.
        current_ids = {qf.id for qf in queue.files}
        self._queue_attempts = {
            fid: rec for fid, rec in self._queue_attempts.items() if fid in current_ids
        }

        if not queue.files:
            return

        logger.info("Upload queue has %d file(s)", len(queue.files))
        for qf in queue.files:
            self._process_queued_file(qf)

    def _process_queued_file(self, qf: UploadQueueFile) -> None:
        """Attempt one queued file, bounding retries across heartbeat polls.

        Manual-mode polling runs every heartbeat, so a file that can't be
        uploaded -- missing on disk after a watch-directory change, or a
        persistent upload error -- would otherwise re-error forever. We cap
        attempts at ``MAX_QUEUE_FILE_ATTEMPTS`` and then cancel the request
        server-side (revert to ``detected``) so it leaves the queue. The
        "Queued file missing" error is emitted only on the first miss; the
        upload path emits its own per-attempt events via ``_upload_single``.
        """
        attempt = self._queue_attempts.get(qf.id)
        attempt_count = attempt.count if attempt else 0

        # Already exhausted: a prior poll's cancel may have failed, so keep
        # retrying the cancel until the file drops out of the queue.
        if attempt_count >= MAX_QUEUE_FILE_ATTEMPTS:
            self._cancel_queued_file(qf, attempt.reason if attempt else "unknown")
            return

        local_path = self._watch_dir / (qf.relative_path or qf.filename)
        if local_path.exists():
            ok = self._upload_single(local_path, qf.run_id)
            reason = "upload_failed"
        else:
            ok = False
            reason = "missing"
            # Throttle: surface the visible "missing" error only on the
            # first miss for this file; later misses are debug-only until
            # the give-up threshold cancels the request.
            if attempt_count == 0:
                logger.error("Queued file not found locally: %s", local_path)
                self._reporter.queue_event(
                    WatcherEvent(
                        event_type=EventType.ERROR,
                        message=f"Queued file missing: {qf.filename}",
                        details={
                            "kind": "queued_file_missing",
                            "file_id": qf.id,
                            "expected_path": str(local_path),
                        },
                    )
                )
                self._bump_errors()
            else:
                logger.debug("Queued file still missing (already reported): %s", local_path)

        if ok:
            self._queue_attempts.pop(qf.id, None)
            return

        attempt_count += 1
        self._queue_attempts[qf.id] = _QueueAttempt(count=attempt_count, reason=reason)
        if attempt_count >= MAX_QUEUE_FILE_ATTEMPTS:
            self._cancel_queued_file(qf, reason)

    def _cancel_queued_file(self, qf: UploadQueueFile, reason: str) -> None:
        """Cancel a persistently-failing queued file's upload request.

        Reverts the file to ``detected`` server-side so it leaves the upload
        queue. On API failure the attempt record is left in place so the next
        poll retries the cancel; the give-up event fires only on a successful
        cancel, so a retried cancel doesn't re-flood the log.
        """
        try:
            self._client.cancel_upload_request(qf.id)
        except ApiError as exc:
            logger.warning(
                "Failed to cancel upload request for %s (file_id=%s): %s",
                qf.filename,
                qf.id,
                exc.message,
            )
            self._bump_errors()
            return

        logger.warning(
            "Gave up on queued file after %d attempts: %s (reason=%s)",
            MAX_QUEUE_FILE_ATTEMPTS,
            qf.filename,
            reason,
        )
        self._reporter.report_error(
            "upload_request_cancelled",
            (
                f"Gave up uploading {qf.filename} after {MAX_QUEUE_FILE_ATTEMPTS} "
                "attempts; cancelled upload request"
            ),
            file_id=qf.id,
            attempts=MAX_QUEUE_FILE_ATTEMPTS,
            reason=reason,
        )

    # ------------------------------------------------------------------
    # Presigned PUT helper
    # ------------------------------------------------------------------

    def _put_to_presigned_url(self, url: str, path: Path, content_type: str | None) -> None:
        """HTTP PUT a file's bytes to a presigned S3 URL.

        Reuses ``self._s3_session`` so successive PUTs to the same S3
        bucket share TLS connections. Method (rather than static) so
        the parallel-upload path inherits the session without each
        call having to thread it through.
        """
        headers: dict[str, str] = {}
        if content_type:
            headers["Content-Type"] = content_type

        with open(path, "rb") as fh:
            resp = self._s3_session.put(url, data=fh, headers=headers, timeout=300)
        resp.raise_for_status()

    # ------------------------------------------------------------------
    # Single-file upload with retry
    # ------------------------------------------------------------------

    def _bump_errors(self) -> None:
        """Increment the shared error counter under ``_counters_lock``.

        Centralised so worker threads inside the parallel-upload pool
        never race the heartbeat thread reading these values for its
        per-tick payload.
        """
        with self._counters_lock:
            self._counters.errors += 1

    def _bump_files_uploaded(self) -> None:
        """Increment the shared success counter under ``_counters_lock``."""
        with self._counters_lock:
            self._counters.files_uploaded += 1

    def _upload_single(self, path: Path, run_id: str) -> bool:
        """Upload one file via a presigned URL, notify the API, and record in StateDB.

        Returns `True` on success, `False` after all retries exhausted.

        Concurrency note
        ----------------
        ``file_sha256(path)`` and ``client.request_upload_url(...)``
        run on a tiny 2-thread pool so the (CPU+IO bound) hash and the
        (network bound) presigned-URL request fully overlap. On a
        multi-GiB instrument file with a slow API, this halves the
        critical-path latency before the actual S3 PUT can start. The
        pool is created per call -- short-lived overhead is dwarfed by
        the time savings on any non-trivial file.
        """
        content_type = _guess_content_type(path)
        stat = path.stat()
        rel_path = _relative_path(path, self._watch_dir)

        # Kick off both the SHA-256 and the presigned-URL request in
        # parallel. ``ThreadPoolExecutor(2)`` is plenty: hashing is
        # CPU/IO with mostly-released GIL via hashlib's C
        # implementation, and the request thread blocks on the
        # network. Resolve both before branching so the rest of the
        # method behaves exactly as the old serial version.
        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="upload-prep") as prep:
            sha_future = prep.submit(file_sha256, path)
            presign_future = prep.submit(
                self._client.request_upload_url,
                self._instrument_id,
                run_id,
                path.name,
                content_type=content_type,
                size_bytes=stat.st_size,
                file_created_at_ts=file_created_at(stat),
            )

            try:
                presigned = presign_future.result()
            except ApiError as exc:
                # Wait for the hash to finish (cancellation is best-effort
                # for already-running futures) before exiting the
                # ``with`` block, otherwise the pool blocks on shutdown.
                sha_future.cancel()
                try:
                    sha_future.result()
                except Exception:
                    pass
                logger.error("Failed to get presigned URL for %s: %s", path.name, exc.message)
                self._bump_errors()
                self._reporter.queue_event(
                    WatcherEvent(
                        event_type=EventType.UPLOAD_FAILED,
                        message=f"Presigned URL request failed: {path.name}",
                        details={"error": exc.message},
                    )
                )
                return False

            try:
                sha = sha_future.result()
            except Exception as exc:
                # Hashing failed (e.g. the file vanished mid-stream).
                # Treat as an upload failure so the file is retried
                # rather than silently dropped.
                logger.error("Failed to hash %s: %s", path.name, exc)
                self._bump_errors()
                self._reporter.queue_event(
                    WatcherEvent(
                        event_type=EventType.UPLOAD_FAILED,
                        message=f"Hashing failed: {path.name}",
                        details={"error": str(exc)},
                    )
                )
                return False

        s3_key = presigned.s3_key
        s3_bucket = presigned.s3_bucket
        file_id = presigned.file_id

        if presigned.already_uploaded:
            logger.debug("Server says already uploaded, skipping: %s", path.name)
            self._state_db.record_upload(
                path.name,
                sha,
                s3_key,
                relative_path=rel_path,
                size_bytes=stat.st_size,
                mtime=stat.st_mtime,
            )
            return True

        if self._state_db.is_uploaded(path.name, sha, s3_key):
            logger.debug("Skipping already-uploaded file: %s", path.name)
            return True

        last_exc: Exception | None = None

        # Exponential backoff: 1s, 2s, 4s. Retries protect against transient
        # network errors common on lab-PC networks.
        assert presigned.upload_url is not None
        for attempt in range(UPLOAD_RETRY_MAX):
            try:
                self._put_to_presigned_url(presigned.upload_url, path, content_type)
                break
            except Exception as exc:
                last_exc = exc
                delay = UPLOAD_RETRY_BASE_DELAY * (2**attempt)
                logger.warning(
                    "Upload attempt %d/%d failed for %s: %s (retry in %ds)",
                    attempt + 1,
                    UPLOAD_RETRY_MAX,
                    path.name,
                    exc,
                    delay,
                )
                time.sleep(delay)
        else:
            logger.error("Upload failed after %d attempts: %s", UPLOAD_RETRY_MAX, path.name)
            self._reporter.queue_event(
                WatcherEvent(
                    event_type=EventType.UPLOAD_FAILED,
                    message=f"Upload failed: {path.name}",
                    details={"s3_key": s3_key, "error": str(last_exc)},
                )
            )
            self._bump_errors()
            return False

        # Notify API — treat a failed PATCH as an upload failure so the file
        # is not recorded in the dedup DB and will be retried next time.
        try:
            self._client.mark_file_uploaded(
                file_id,
                {
                    "s3_bucket": s3_bucket,
                    "s3_key": s3_key,
                    "content_type": content_type,
                    "status": "uploaded",
                },
            )
        except ApiError as exc:
            logger.error("PATCH /files/%d failed: %s", file_id, exc.message)
            self._bump_errors()
            self._reporter.queue_event(
                WatcherEvent(
                    event_type=EventType.UPLOAD_FAILED,
                    message=f"Upload notification failed: {path.name}",
                    details={"s3_key": s3_key, "file_id": file_id, "error": exc.message},
                )
            )
            return False

        self._state_db.record_upload(
            path.name,
            sha,
            s3_key,
            relative_path=rel_path,
            size_bytes=stat.st_size,
            mtime=stat.st_mtime,
        )
        self._bump_files_uploaded()
        self._reporter.queue_event(
            WatcherEvent(
                event_type=EventType.FILE_UPLOADED,
                message=f"Uploaded {path.name}",
                details={"s3_key": s3_key, "sha256": sha},
            )
        )
        logger.info("Uploaded %s → s3://%s/%s", path.name, s3_bucket, s3_key)
        return True
