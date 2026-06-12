"""Structured event reporting from the watcher to the Data Hub API.

The watcher's primary observability surface is the per-watcher event log
served by ``POST /watchers/:id/events``. Events are queued in memory by
the various long-running components (uploader, run-detector, monitor,
updater, heartbeat) and flushed in batches on every heartbeat tick.

Event taxonomy
--------------
The Postgres ``watcher_event_type`` enum is intentionally small. Many
distinct failure modes share the ``EventType.ERROR`` bucket and are
distinguished by ``details.kind`` so we can add new categories without
a database migration. Known ``kind`` values, with their per-kind
``details`` schemas:

* ``run_report_failed`` -- POST/PATCH against
  ``/instruments/:id/runs[/:run_id]`` raised ``ApiError``.
  ``details = {"kind", "run_id", "operation": "create"|"update",
  "status_code", "error", "file_count"}``.
* ``config_sync_failed`` -- the startup ``PUT /watchers/:id/config``
  call raised ``ApiError``. ``details = {"kind", "checksum", "error"}``.
* ``stability_timeout`` -- a file kept changing past
  ``MAX_STABILITY_WAIT_SECONDS`` and was abandoned.
  ``details = {"kind", "path", "max_wait_seconds"}``.
* ``stable_callback_failed`` -- the on-stable-file callback raised.
  ``details = {"kind", "path", "error"}``.
* ``pattern_mismatch`` -- a file inside the watch directory did not
  match the configured ``run_detection.pattern``. Throttled to one
  emission per parent directory per process so a misconfigured pattern
  doesn't flood the queue. ``details = {"kind", "relative_path"}``.
* ``events_dropped`` -- synthetic event prepended to the next
  successful batch after one or more prior batches were dropped.
  ``details = {"kind", "dropped_count", "since"}``.
* ``heartbeat_recovered`` -- emitted on the first successful heartbeat
  after one or more consecutive failures.
  ``details = {"kind", "consecutive_failures", "gap_seconds"}``.
* ``upload_queue_poll_failed`` -- ``GET /watchers/:id/upload-queue``
  failed in manual mode. Emitted on the 1st failure and every 10th
  repeat so a sustained outage isn't silent.
  ``details = {"kind", "error", "consecutive_failures"}``.
* ``update_check_failed`` -- ``GET /watchers/:id/update-check`` failed.
  Emitted only after 3 consecutive failures so we don't alert on a
  single hourly blip. ``details = {"kind", "error", "consecutive_failures"}``.
* ``queued_file_missing`` -- a manual-mode upload-queue file was not found
  on disk at its resolved path. Emitted once per file id (throttled across
  heartbeat polls). ``details = {"kind", "file_id", "expected_path"}``.
* ``upload_request_cancelled`` -- the watcher gave up on a queued file
  after ``MAX_QUEUE_FILE_ATTEMPTS`` failed polls (missing or upload error)
  and reverted it to ``detected`` server-side so it leaves the queue.
  ``details = {"kind", "file_id", "attempts", "reason"}``.
"""

from __future__ import annotations
import logging
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any

from data_hub_watcher.api_client import ApiError, DataHubClient

logger = logging.getLogger(__name__)


# Cap the in-memory event queue so a prolonged API outage can't grow it
# without bound. Older events are dropped first (FIFO) and surfaced via
# the synthetic ``kind=events_dropped`` event on the next successful flush.
MAX_QUEUE_SIZE = 500

# Per-attempt retry profile for the events POST. Total wall-clock is
# 1 + 2 + 4 = 7 s in the worst case, well under the 60 s heartbeat
# interval, so an inline retry doesn't risk wedging the heartbeat thread.
FLUSH_RETRY_MAX = 3
FLUSH_RETRY_BASE_DELAY = 1.0


class EventType(str, Enum):
    WATCHER_STARTED = "watcher_started"
    WATCHER_STOPPED = "watcher_stopped"
    FILE_UPLOADED = "file_uploaded"
    UPLOAD_FAILED = "upload_failed"
    RUN_REPORTED = "run_reported"
    CONFIG_SYNCED = "config_synced"
    ERROR = "error"
    # Auto-update lifecycle. UPDATE_STARTED is emitted when the in-process
    # updater begins running the upgrade subprocess; UPDATE_SUCCEEDED /
    # UPDATE_FAILED are emitted after the new version starts up (or
    # doesn't), keyed off the on-disk upgrade marker.
    UPDATE_STARTED = "update_started"
    UPDATE_SUCCEEDED = "update_succeeded"
    UPDATE_FAILED = "update_failed"


@dataclass
class WatcherEvent:
    event_type: EventType
    message: str
    details: dict[str, Any] = field(default_factory=dict)
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict[str, Any]:
        return {
            "event_type": self.event_type.value,
            "timestamp": self.timestamp,
            "message": self.message,
            "details": self.details,
        }


class EventReporter:
    """Accumulates events in memory and flushes them to the API in batches.

    Resilience properties:

    * Bounded queue (``MAX_QUEUE_SIZE``): on overflow the oldest queued
      event is discarded and ``_dropped_count`` is bumped.
    * Retry-with-backoff in :meth:`flush` (up to ``FLUSH_RETRY_MAX``
      attempts) so a single transient network blip doesn't lose the
      whole batch.
    * After any drops, the next successful flush prepends a synthetic
      ``kind=events_dropped`` event so operators can see how much
      observability data was lost and during which window.
    """

    def __init__(
        self,
        client: DataHubClient,
        watcher_id: str,
        *,
        max_queue_size: int = MAX_QUEUE_SIZE,
    ) -> None:
        self._client = client
        self._watcher_id = watcher_id
        self._queue: deque[WatcherEvent] = deque(maxlen=max_queue_size)
        self._lock = threading.Lock()
        self._max_queue_size = max_queue_size
        # Number of events dropped since the last successful flush.
        # Carried across flushes so a long outage that drops several
        # batches still surfaces as a single events_dropped event when
        # the link recovers.
        self._dropped_count = 0
        self._dropped_since: str | None = None

    def queue_event(self, event: WatcherEvent) -> None:
        with self._lock:
            if len(self._queue) >= self._max_queue_size:
                # FIFO: drop the oldest event so the freshest signal
                # survives. ``deque(maxlen=...)`` would do this for us
                # but we want to track the drop explicitly.
                self._queue.popleft()
                self._note_drop(1)
            self._queue.append(event)

    def report_error(self, kind: str, message: str, **details: Any) -> None:
        """Queue a structured ``EventType.ERROR`` with a ``kind`` discriminator.

        Convenience wrapper used at every "currently silent" failure
        site in the watcher. The ``kind`` value selects the per-event
        schema documented at the top of this module.
        """
        payload: dict[str, Any] = {"kind": kind}
        payload.update(details)
        self.queue_event(
            WatcherEvent(
                event_type=EventType.ERROR,
                message=message,
                details=payload,
            )
        )

    def _note_drop(self, n: int) -> None:
        """Record that *n* events were dropped (caller holds ``_lock``)."""
        if self._dropped_count == 0:
            self._dropped_since = datetime.now(timezone.utc).isoformat()
        self._dropped_count += n

    def flush(self) -> None:
        with self._lock:
            if not self._queue and self._dropped_count == 0:
                return
            # Snapshot and clear atomically so events queued from other
            # threads during the network call aren't lost.
            queue_snapshot = list(self._queue)
            self._queue.clear()
            # Capture pending drop state so the synthetic event reflects
            # exactly the window covered by this batch. Don't reset
            # ``_dropped_count`` yet — it only clears on a successful
            # POST so a failed flush leaves the loss reportable on the
            # next attempt.
            dropped_count = self._dropped_count
            dropped_since = self._dropped_since

        events_to_send = list(queue_snapshot)
        if dropped_count > 0:
            # Prepend a synthetic event so the dashboard sees the gap
            # before any of the events in this batch.
            events_to_send.insert(
                0,
                WatcherEvent(
                    event_type=EventType.ERROR,
                    message=f"Dropped {dropped_count} watcher event(s) due to API errors",
                    details={
                        "kind": "events_dropped",
                        "dropped_count": dropped_count,
                        "since": dropped_since,
                    },
                ),
            )

        # Inline retry-with-backoff. Total worst-case wall clock is
        # ~7 s for FLUSH_RETRY_MAX=3 — well under the heartbeat
        # interval, so we keep this on the heartbeat thread for
        # simplicity. Switch to a worker thread if this ever needs to
        # exceed half the heartbeat period.
        last_exc: Exception | None = None
        for attempt in range(FLUSH_RETRY_MAX):
            try:
                self._client.send_events(
                    self._watcher_id,
                    [e.to_dict() for e in events_to_send],
                )
                # Success — clear the pending-drop counter we just
                # surfaced. New drops may have accumulated concurrently
                # while we were blocked on the network; subtract rather
                # than zero so those remain reportable.
                with self._lock:
                    self._dropped_count -= dropped_count
                    if self._dropped_count <= 0:
                        self._dropped_count = 0
                        self._dropped_since = None
                return
            except (ApiError, Exception) as exc:
                last_exc = exc
                if attempt < FLUSH_RETRY_MAX - 1:
                    delay = FLUSH_RETRY_BASE_DELAY * (2**attempt)
                    logger.warning(
                        "Event flush attempt %d/%d failed: %s (retry in %.1fs)",
                        attempt + 1,
                        FLUSH_RETRY_MAX,
                        exc,
                        delay,
                    )
                    time.sleep(delay)

        # All retries exhausted. Drop the real events (the synthetic
        # prefix isn't counted — the prior drops it represents are
        # still tracked in ``_dropped_count``) and let the next
        # successful flush surface the loss.
        with self._lock:
            self._note_drop(len(queue_snapshot))
        logger.warning(
            "Failed to flush %d event(s) after %d attempts: %s",
            len(events_to_send),
            FLUSH_RETRY_MAX,
            last_exc,
        )
