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
  ``/instruments/:id/runs[/:run_id]`` failed. Everything except a 4xx is
  retried until it succeeds, so only the first of a row of such failures
  is emitted; a 4xx is emitted every time because it is not retried.
  ``status_code`` is 0 when no HTTP status came back.
  ``details = {"kind", "run_id", "operation": "create"|"update",
  "status_code", "error", "file_count"}``. A 409 that says the run was deleted
  on Data Hub is emitted once per run per process, not for every file, and
  also carries ``"reason": "run_deleted"``. When the uploader meets that
  refusal first, it queues an ``upload_failed`` event with the same reason
  instead.
* ``state_write_failed`` -- the server accepted a run report, but writing it
  to the state database failed (a full disk, say). The watcher retries the
  write on the backoff of a failed report, and uploads nothing and sends
  nothing more for the run until it works.
  Only the first of a row of failed writes for a run is emitted.
  ``details = {"kind", "run_id", "error", "file_count"}``.
* ``config_sync_failed`` -- the startup ``PUT /watchers/:id/config``
  call raised ``ApiError``. ``details = {"kind", "checksum", "error"}``.
* ``stability_timeout`` -- a file kept changing past the configured
  ``max_stability_wait_seconds`` (default ``MAX_STABILITY_WAIT_SECONDS``)
  and was abandoned.
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
  failed. Emitted on the 1st failure and every 10th repeat so a
  sustained outage isn't silent.
  ``details = {"kind", "error", "consecutive_failures"}``.
* ``update_check_failed`` -- ``GET /watchers/:id/update-check`` failed.
  Emitted only after 3 consecutive failures so we don't alert on a
  single hourly blip. ``details = {"kind", "error", "consecutive_failures"}``.
* ``queued_file_missing`` -- an upload-queue file was not found on disk
  at its resolved path. Emitted once per file id (throttled across
  polls). ``details = {"kind", "file_id", "expected_path"}``.
* ``upload_request_cancelled`` -- the watcher gave up on a queued file
  after ``MAX_QUEUE_FILE_ATTEMPTS`` failed polls (missing or upload error)
  and reverted it to ``detected`` server-side so it leaves the queue.
  ``details = {"kind", "file_id", "attempts", "reason"}``.
* ``upload_retries_exhausted`` -- an auto-mode upload still failed after
  ``MAX_PENDING_UPLOAD_ATTEMPTS`` watcher starts, so it is no longer
  retried. ``details = {"kind", "relative_path", "run_id", "attempts"}``.
* ``pending_upload_missing`` -- an auto-mode upload waiting for a retry
  was no longer on disk at startup, so the retry was dropped.
  ``details = {"kind", "relative_path", "run_id"}``.
* ``watch_directory_unavailable`` -- the watch folder was missing or
  unreadable, so the watcher entered its waiting state (heartbeats only).
  ``details = {"kind", "watch_directory", "reason"}``.

Results of config revisions from the web app are not reported here: the
server writes those events itself when the watcher posts the result.
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

from data_hub_watcher.api_client import (
    DEFAULT_TIMEOUT,
    ApiError,
    DataHubClient,
    timeout_until,
)

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
# A flush with a deadline retries only if the retry would still have this long to run
# once it has waited its delay.
FLUSH_RETRY_MIN_SECONDS = 1.0


def _safe_to_replay(exc: Exception | None) -> bool:
    """Whether a failed events request can be sent again without the server storing it twice.

    The events route inserts every batch as it comes, with nothing to recognise a repeat.
    A connection error (nothing reached the server) and a 5xx (it failed) are safe to
    replay. A read timeout is not: the server may have stored the batch and only been
    slow to answer. Neither is a 4xx, which would fail again, or an error raised after a
    2xx answer, which means the server did store it.
    """
    return isinstance(exc, ApiError) and not exc.read_timed_out and exc.is_transient


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

    def flush(
        self,
        *,
        deadline: float | None = None,
        timeout_cap: tuple[float, float] = DEFAULT_TIMEOUT,
    ) -> None:
        """Send the queued events.

        *deadline* (a `time.monotonic()` value) is for a flush that has a limited time, as
        when the watcher is stopping. Each attempt has an HTTP timeout of *timeout_cap*, the
        client's usual one unless told otherwise, cut down to fit before the deadline, so a
        server that answers slowly is still waited for. It retries as the usual flush does,
        but only after a failure that can't have left the batch stored (see
        `_safe_to_replay`: not after a read timeout), and only while the deadline still
        leaves a retry time to run. It makes no attempt once the deadline has passed. The
        events that couldn't be sent are dropped as after any failed flush.
        """
        if deadline is not None and time.monotonic() >= deadline:
            return
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
        attempts = 0
        while True:
            attempts += 1
            try:
                self._client.send_events(
                    self._watcher_id,
                    [e.to_dict() for e in events_to_send],
                    timeout=None if deadline is None else timeout_until(deadline, timeout_cap),
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
            if attempts >= FLUSH_RETRY_MAX:
                break
            if deadline is not None and not _safe_to_replay(last_exc):
                break
            delay = FLUSH_RETRY_BASE_DELAY * (2 ** (attempts - 1))
            retry_ends_by = time.monotonic() + delay + FLUSH_RETRY_MIN_SECONDS
            if deadline is not None and retry_ends_by > deadline:
                break
            logger.warning(
                "Event flush attempt %d/%d failed: %s (retry in %.1fs)",
                attempts,
                FLUSH_RETRY_MAX,
                last_exc,
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
            "Failed to flush %d event(s) after %d attempt(s): %s",
            len(events_to_send),
            attempts,
            last_exc,
        )
