"""Presigned-URL upload with retry, API notification, and local state recording.

`Uploader` handles both auto-mode (immediate upload after run detection)
and manual-mode (poll the server's upload queue on heartbeat ticks).

Files are uploaded via presigned S3 PUT URLs obtained from the API, so the
watcher does not need AWS credentials.
"""

from __future__ import annotations
import logging
import mimetypes
import time
from pathlib import Path

import requests as http_requests

from data_hub_watcher.api_client import ApiError, DataHubClient
from data_hub_watcher.constants import (
    UPLOAD_RETRY_BASE_DELAY,
    UPLOAD_RETRY_MAX,
)
from data_hub_watcher.events import EventReporter, EventType, WatcherEvent
from data_hub_watcher.heartbeat import WatcherCounters
from data_hub_watcher.monitor import file_sha256
from data_hub_watcher.run_detector import FileInfo
from data_hub_watcher.state import StateDB

logger = logging.getLogger(__name__)


def _guess_content_type(path: Path) -> str | None:
    content_type, _ = mimetypes.guess_type(str(path))
    return content_type


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
    ) -> None:
        self._client = client
        self._state_db = state_db
        self._reporter = event_reporter
        self._counters = counters
        self._instrument_id = instrument_id
        self._watcher_id = watcher_id
        self._watch_dir = watch_directory

    # ------------------------------------------------------------------
    # Auto-mode: upload a batch of files for a reported run
    # ------------------------------------------------------------------

    def upload_files(self, run_id: str, files: list[FileInfo]) -> int:
        """Upload every file in *files* for the given *run_id*.

        Called by `RunDetector` immediately after a successful run report
        (auto mode only).  Returns the number of files successfully uploaded.
        """
        succeeded = 0
        for info in files:
            if self._upload_single(info.path, run_id):
                succeeded += 1

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
            self._counters.errors += 1
            return

        if not queue.files:
            return

        logger.info("Upload queue has %d file(s)", len(queue.files))
        for qf in queue.files:
            local_path = self._watch_dir / (qf.relative_path or qf.filename)
            if not local_path.exists():
                logger.error("Queued file not found locally: %s", local_path)
                self._reporter.queue_event(
                    WatcherEvent(
                        event_type=EventType.ERROR,
                        message=f"Queued file missing: {qf.filename}",
                        details={"file_id": qf.id, "expected_path": str(local_path)},
                    )
                )
                self._counters.errors += 1
                continue

            self._upload_single(local_path, qf.run_id)

    # ------------------------------------------------------------------
    # Presigned PUT helper
    # ------------------------------------------------------------------

    @staticmethod
    def _put_to_presigned_url(url: str, path: Path, content_type: str | None) -> None:
        """HTTP PUT a file's bytes to a presigned S3 URL."""
        headers: dict[str, str] = {}
        if content_type:
            headers["Content-Type"] = content_type

        with open(path, "rb") as fh:
            resp = http_requests.put(url, data=fh, headers=headers, timeout=300)
        resp.raise_for_status()

    # ------------------------------------------------------------------
    # Single-file upload with retry
    # ------------------------------------------------------------------

    def _upload_single(self, path: Path, run_id: str) -> bool:
        """Upload one file via a presigned URL, notify the API, and record in StateDB.

        Returns `True` on success, `False` after all retries exhausted.
        """
        content_type = _guess_content_type(path)
        sha = file_sha256(path)
        stat = path.stat()

        # Request a presigned upload URL from the API. This also creates or
        # locates the server-side file record.
        try:
            presigned = self._client.request_upload_url(
                self._instrument_id,
                run_id,
                path.name,
                content_type=content_type,
                size_bytes=stat.st_size,
            )
        except ApiError as exc:
            logger.error("Failed to get presigned URL for %s: %s", path.name, exc.message)
            self._counters.errors += 1
            self._reporter.queue_event(
                WatcherEvent(
                    event_type=EventType.UPLOAD_FAILED,
                    message=f"Presigned URL request failed: {path.name}",
                    details={"error": exc.message},
                )
            )
            return False

        s3_key = presigned.s3_key
        s3_bucket = presigned.s3_bucket
        file_id = presigned.file_id

        if presigned.already_uploaded:
            logger.debug("Server says already uploaded, skipping: %s", path.name)
            self._state_db.record_upload(
                path.name, sha, s3_key, size_bytes=stat.st_size, mtime=stat.st_mtime
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
            self._counters.errors += 1
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
            self._counters.errors += 1
            self._reporter.queue_event(
                WatcherEvent(
                    event_type=EventType.UPLOAD_FAILED,
                    message=f"Upload notification failed: {path.name}",
                    details={"s3_key": s3_key, "file_id": file_id, "error": exc.message},
                )
            )
            return False

        self._state_db.record_upload(
            path.name, sha, s3_key, size_bytes=stat.st_size, mtime=stat.st_mtime
        )
        self._counters.files_uploaded += 1
        self._reporter.queue_event(
            WatcherEvent(
                event_type=EventType.FILE_UPLOADED,
                message=f"Uploaded {path.name}",
                details={"s3_key": s3_key, "sha256": sha},
            )
        )
        logger.info("Uploaded %s → s3://%s/%s", path.name, s3_bucket, s3_key)
        return True
