"""S3 upload with retry, API notification, and local state recording.

``Uploader`` handles both auto-mode (immediate upload after run detection)
and manual-mode (poll the server's upload queue on heartbeat ticks).
"""

from __future__ import annotations
import logging
import time
from pathlib import Path

from data_hub_shared.s3_utils import S3Client, get_content_type, get_s3_client, upload_file
from data_hub_watcher.api_client import ApiError, DataHubClient
from data_hub_watcher.constants import (
    S3_BUCKET_TEMPLATE,
    UPLOAD_RETRY_BASE_DELAY,
    UPLOAD_RETRY_MAX,
)
from data_hub_watcher.events import EventReporter, EventType, WatcherEvent
from data_hub_watcher.heartbeat import WatcherCounters
from data_hub_watcher.monitor import file_sha256
from data_hub_watcher.run_detector import FileInfo
from data_hub_watcher.state import StateDB

logger = logging.getLogger(__name__)


class Uploader:
    """Uploads files to S3 and notifies the Data Hub API.

    Parameters
    ----------
    client:
        API client for ``PATCH /files/{id}`` calls.
    state_db:
        Local SQLite DB for deduplication.
    event_reporter:
        For queuing upload events.
    counters:
        Heartbeat counters incremented on each upload.
    instrument_id:
        Used to construct S3 keys.
    watcher_id:
        Watcher identity for queue polling.
    environment:
        ``"staging"`` or ``"production"`` — determines the S3 bucket name.
    watch_directory:
        Root watch directory for resolving relative paths in queue mode.
    s3_client:
        Optional pre-built boto3 S3 client.  Created lazily if ``None``.
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
        environment: str,
        watch_directory: Path,
        s3_client: S3Client | None = None,
    ) -> None:
        self._client = client
        self._state_db = state_db
        self._reporter = event_reporter
        self._counters = counters
        self._instrument_id = instrument_id
        self._watcher_id = watcher_id
        self._s3_bucket = S3_BUCKET_TEMPLATE.format(environment=environment)
        self._watch_dir = watch_directory
        self._s3_client = s3_client

    def _get_s3_client(self) -> S3Client:
        if self._s3_client is None:
            self._s3_client = get_s3_client()
        return self._s3_client

    # ------------------------------------------------------------------
    # Auto-mode: upload a batch of files for a reported run
    # ------------------------------------------------------------------

    def upload_files(self, run_id: str, files: list[FileInfo]) -> None:
        """Upload every file in *files* for the given *run_id*.

        Called by ``RunDetector`` immediately after a successful run report
        (auto mode only).
        """
        for info in files:
            self._upload_single(info.path, run_id, file_id=None)

        self._state_db.record_run_uploaded(run_id)

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

            self._upload_single(local_path, qf.run_id, file_id=qf.id)

    # ------------------------------------------------------------------
    # Single-file upload with retry
    # ------------------------------------------------------------------

    def _upload_single(self, path: Path, run_id: str, *, file_id: int | None) -> bool:
        """Upload one file to S3, notify the API, and record in StateDB.

        Returns ``True`` on success, ``False`` after all retries exhausted.

        ``file_id`` is ``None`` in auto mode (file records are created
        server-side during run reporting) and set in manual mode (the server
        already has a file record and expects a PATCH with S3 metadata).
        """
        s3_key = f"{self._instrument_id}/{run_id}/{path.name}"
        s3_uri = f"s3://{self._s3_bucket}/{s3_key}"
        sha = file_sha256(path)

        if self._state_db.is_uploaded(path.name, sha):
            logger.debug("Skipping already-uploaded file: %s", path.name)
            return True

        client = self._get_s3_client()
        last_exc: Exception | None = None

        # Exponential backoff: 1s, 2s, 4s. Retries protect against transient
        # S3 errors or brief network blips that are common on lab-PC networks.
        for attempt in range(UPLOAD_RETRY_MAX):
            try:
                upload_file(path, s3_uri, s3_client=client)
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

        # Notify API
        if file_id is not None:
            content_type = get_content_type(path)
            try:
                self._client.mark_file_uploaded(
                    file_id,
                    {
                        "s3_bucket": self._s3_bucket,
                        "s3_key": s3_key,
                        "content_type": content_type,
                        "status": "uploaded",
                    },
                )
            except ApiError as exc:
                logger.warning("PATCH /files/%d failed: %s", file_id, exc.message)

        self._state_db.record_upload(path.name, sha, s3_key)
        self._counters.files_uploaded += 1
        self._reporter.queue_event(
            WatcherEvent(
                event_type=EventType.FILE_UPLOADED,
                message=f"Uploaded {path.name}",
                details={"s3_key": s3_key, "sha256": sha},
            )
        )
        logger.info("Uploaded %s → %s", path.name, s3_uri)
        return True
