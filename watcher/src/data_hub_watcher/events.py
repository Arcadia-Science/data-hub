"""Structured event reporting from the watcher to the Data Hub API.

The watcher's primary observability surface is the per-watcher event log
served by ``POST /watchers/:id/events``. Events are queued by the various
long-running components (uploader, run-detector, monitor, updater,
heartbeat) and flushed in batches on every heartbeat tick. The supervisor's
reporter also saves each queued event in the state database (see
:meth:`EventReporter.attach_store`), so events that were queued but not yet
sent when the watcher was killed are sent after the restart.

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
  "status_code", "error", "file_count"}``.
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
  successful batch after events were dropped: the oldest ones when the
  queue was full, or a batch that the server refused (a 4xx) or that
  wasn't saved and failed to send.
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
import itertools
import json
import logging
import sqlite3
import threading
import time
from collections import deque
from collections.abc import Iterable
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
from data_hub_watcher.state import StateDB

logger = logging.getLogger(__name__)


# Cap the event queue so a prolonged API outage can't grow it without bound. Older
# events are dropped first (FIFO) and surfaced via the synthetic
# ``kind=events_dropped`` event on the next successful flush.
MAX_QUEUE_SIZE = 500

# The most events the server takes in one request, the synthetic ``events_dropped``
# event included (`web/lib/api/openapi/schemas/watchers.ts`). A longer queue is sent
# in several requests.
MAX_EVENTS_PER_REQUEST = 100

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


@dataclass(eq=False)
class _Queued:
    """An event waiting to be sent, and where it is saved.

    `eq=False` makes two entries equal only when they are the same object, which is how the
    queue tells entries apart.
    """

    event: WatcherEvent
    # The `pending_events` row that holds the event, or `None` when it isn't saved: no store
    # was attached when it was queued, or writing it failed.
    row_id: int | None = None
    # Set when the entry is dropped from the queue (past the cap, or in a batch given up on).
    # A send that already has the entry in flight uses it to take the drop back if the server
    # then takes the entry (see `EventReporter._acknowledge`).
    dropped: bool = False


def _event_from_json(raw: str) -> WatcherEvent | None:
    """The event that `json.dumps(event.to_dict())` made *raw* from, or `None` if unreadable."""
    try:
        data = json.loads(raw)
        return WatcherEvent(
            event_type=EventType(data["event_type"]),
            message=str(data["message"]),
            details=dict(data["details"]),
            timestamp=str(data["timestamp"]),
        )
    except (ValueError, KeyError, TypeError):
        # Not JSON, a missing field, or an event type this version doesn't know.
        return None


class EventReporter:
    """Queues events and flushes them to the API in batches.

    Resilience properties:

    * Bounded queue (``MAX_QUEUE_SIZE``): on overflow the oldest queued
      event is discarded and ``_dropped_count`` is bumped.
    * Batches of at most ``MAX_EVENTS_PER_REQUEST`` events, which is what the
      server takes in one request.
    * Retry-with-backoff in :meth:`flush` (up to ``FLUSH_RETRY_MAX``
      attempts) so a single transient network blip doesn't lose the
      whole batch.
    * After any drops, the next successful flush prepends a synthetic
      ``kind=events_dropped`` event so operators can see how much
      observability data was lost and during which window.
    * With a store attached (:meth:`attach_store`), every queued event is also saved in
      the state database until the server has it. A kill, or a batch that can't be sent
      for now, loses nothing: what is saved is sent after the restart or on the next flush.

    How the queue and the store stay one list
    -----------------------------------------
    ``_queue`` is the one list of what waits to be sent, whether or not a store is attached.
    Each entry knows the store row that holds it (``row_id``). Every change to the list
    (an event queued, the oldest dropped to stay within the cap, a batch the server took, a
    batch that was given up on) updates the rows in the same hold of ``_lock``, through
    `_save` and `_delete_rows`, so the rows are the entries that have a ``row_id``. The store
    is read once, by :meth:`attach_store`. Two things break that, both in the safe direction.
    An event whose write failed has no row: this process still sends it, it just isn't saved.
    A row whose deletion failed outlives its entry, and is sent again after a restart.
    :meth:`detach_store` takes the saved entries out of the queue and leaves their rows for
    the next start.
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
        self._queue: deque[_Queued] = deque()
        # Guards `_queue`, `_store` and the drop counters. A store call is made with it
        # held, so `detach_store` returning means no thread is using the store any more.
        self._lock = threading.Lock()
        # Held for a whole flush, so two flushes never send the same events. One flush
        # takes the events it sends from the queue without removing them, which would let
        # a second one send them again.
        self._flush_lock = threading.Lock()
        self._store: StateDB | None = None
        self._max_queue_size = max_queue_size
        # Number of events dropped since the last successful flush.
        # Carried across flushes so a long outage that drops several
        # batches still surfaces as a single events_dropped event when
        # the link recovers.
        self._dropped_count = 0
        self._dropped_since: str | None = None

    def queue_event(self, event: WatcherEvent) -> None:
        with self._lock:
            self._queue.append(_Queued(event, self._save(event)))
            self._trim()

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

    # ------------------------------------------------------------------
    # the store
    # ------------------------------------------------------------------

    def attach_store(self, store: StateDB) -> None:
        """Save every queued event in *store* from now on, and take over what it holds.

        Events that an earlier process saved and never sent join the front of the queue, in
        the order they were queued, and go out with the next flush. Events saved for another
        watcher ID are deleted: one state database can serve a watcher that registered again,
        and the server would refuse them. Events queued before the attach are saved now, and
        queue behind those. Rows this version can't read are deleted.

        If the store can't be read, it stays unattached and the reporter keeps working in
        memory.

        Events are queued from many threads, and each thread has its own connection to the
        store, which takes its own write lock for every write.
        """
        with self._lock:
            if self._store is not None:
                raise RuntimeError("A store is already attached to this event reporter")
            try:
                discarded = store.delete_pending_events_of_other_watchers(self._watcher_id)
                rows = store.pending_events(self._watcher_id)
            except sqlite3.Error as exc:
                logger.warning(
                    "Could not read the saved events from the state database: %s; "
                    "queueing events in memory only",
                    exc,
                )
                return
            if discarded:
                logger.info(
                    "Dropped %d saved event(s) that belong to a different watcher", discarded
                )
            saved: list[_Queued] = []
            unreadable: list[int] = []
            for row_id, raw in rows:
                event = _event_from_json(raw)
                if event is None:
                    unreadable.append(row_id)
                else:
                    saved.append(_Queued(event, row_id))
            self._store = store
            if unreadable:
                logger.warning("Dropped %d saved event(s) that could not be read", len(unreadable))
                self._delete_rows(unreadable)
            if saved:
                logger.info(
                    "Found %d event(s) saved before the last stop; sending them", len(saved)
                )
            for entry in self._queue:
                entry.row_id = self._save(entry.event)
            self._queue = deque([*saved, *self._queue])
            self._trim()

    def detach_store(self) -> None:
        """Stop saving events, before the store is closed. Call it once nothing queues events.

        Events queued from now on stay in memory. What is saved but not yet sent stays in the
        store for the next start, and leaves the queue, so this process doesn't send it as
        well (it couldn't delete the rows afterwards, and the next start would send them
        again). Returns once no thread is inside a store call.
        """
        with self._lock:
            if self._store is None:
                return
            self._store = None
            self._queue = deque(entry for entry in self._queue if entry.row_id is None)

    def _save(self, event: WatcherEvent) -> int | None:
        """Save *event* in the store and return its row id, or `None` if it isn't saved.

        The caller holds `_lock`.
        """
        if self._store is None:
            return None
        try:
            return self._store.add_pending_event(self._watcher_id, json.dumps(event.to_dict()))
        except (sqlite3.Error, TypeError, ValueError) as exc:
            # The event is still sent by this process. A value that JSON can't hold fails
            # again when the batch is sent, as it did before events were saved.
            logger.warning("Could not save an event in the state database: %s", exc)
            return None

    def _delete_rows(self, row_ids: Iterable[int | None]) -> None:
        """Delete the saved events with these ids, if a store is attached.

        The caller holds `_lock`.
        """
        ids = [row_id for row_id in row_ids if row_id is not None]
        if not ids or self._store is None:
            return
        try:
            self._store.delete_pending_events(ids)
        except sqlite3.Error as exc:
            logger.warning(
                "Could not delete %d saved event(s) from the state database: %s", len(ids), exc
            )

    # ------------------------------------------------------------------
    # the queue
    # ------------------------------------------------------------------

    def _note_drop(self, n: int) -> None:
        """Record that *n* events were dropped (caller holds ``_lock``)."""
        if self._dropped_count == 0:
            self._dropped_since = datetime.now(timezone.utc).isoformat()
        self._dropped_count += n

    def _trim(self) -> None:
        """Drop the oldest events until the queue is within its cap (caller holds ``_lock``).

        FIFO: the freshest signal survives. The drop is counted so the next successful flush
        reports it, and the rows go with the entries.
        """
        over = len(self._queue) - self._max_queue_size
        if over <= 0:
            return
        dropped = [self._queue.popleft() for _ in range(over)]
        for entry in dropped:
            entry.dropped = True
        self._note_drop(over)
        self._delete_rows(entry.row_id for entry in dropped)

    def _remove(self, entries: Iterable[_Queued]) -> list[_Queued]:
        """Take *entries* out of the queue and return the ones that were still in it.

        The caller holds `_lock`.
        """
        gone = set(entries)
        removed = [entry for entry in self._queue if entry in gone]
        if removed:
            self._queue = deque(entry for entry in self._queue if entry not in gone)
        return removed

    # ------------------------------------------------------------------
    # flushing
    # ------------------------------------------------------------------

    def flush(
        self,
        *,
        deadline: float | None = None,
        timeout_cap: tuple[float, float] = DEFAULT_TIMEOUT,
    ) -> None:
        """Send the queued events, the oldest first, at most `MAX_EVENTS_PER_REQUEST` at a time.

        Each batch is deleted from the store once the server has taken it (a 2xx answer),
        and the next one is sent, until what was queued when the flush began has been sent
        or a batch fails. An event queued while the flush runs waits for the next one, so a
        thread that queues events as fast as they are sent can't keep a flush from ending.

        *deadline* (a `time.monotonic()` value) is for a flush that has a limited time, as
        when the watcher is stopping. Each attempt has an HTTP timeout of *timeout_cap*, the
        client's usual one unless told otherwise, cut down to fit before the deadline, so a
        server that answers slowly is still waited for. It retries as the usual flush does,
        but only after a failure that can't have left the batch stored (see
        `_safe_to_replay`: not after a read timeout), and only while the deadline still
        leaves a retry time to run. It makes no attempt once the deadline has passed, and
        waits for a flush that is running only until then.

        A batch that fails on a connection error, a read timeout or a 5xx stays queued if it
        is saved, and the next flush sends it again. Anything else is dropped and counted:
        a batch that isn't saved, one that the server refused with a 4xx, which would fail
        again and keep every later event from being sent, and one whose answer couldn't be
        read after a 2xx, which the server stored.
        """
        if deadline is not None and time.monotonic() >= deadline:
            return
        wait = -1.0 if deadline is None else max(0.0, deadline - time.monotonic())
        if not self._flush_lock.acquire(timeout=wait):
            return
        try:
            with self._lock:
                left = len(self._queue)
            while True:
                taken = self._flush_batch(left, deadline, timeout_cap)
                if taken is None:
                    return
                left -= taken
                if left <= 0 or (deadline is not None and time.monotonic() >= deadline):
                    return
        finally:
            self._flush_lock.release()

    def _flush_batch(
        self, left: int, deadline: float | None, timeout_cap: tuple[float, float]
    ) -> int | None:
        """Send the oldest of the *left* events to send, as many as fit in one request.

        Returns how many queued events the server took (0 if only the `events_dropped` event
        was sent), or `None` when there was nothing to send or the request failed.
        """
        with self._lock:
            # Capture pending drop state so the synthetic event reflects
            # exactly the window covered by this batch. Don't reset
            # ``_dropped_count`` yet — it only clears on a successful
            # POST so a failed flush leaves the loss reportable on the
            # next attempt.
            dropped_count = self._dropped_count
            dropped_since = self._dropped_since
            room = min(left, MAX_EVENTS_PER_REQUEST - (1 if dropped_count > 0 else 0))
            # Not taken out of the queue: they leave it, and the store, once the server has
            # them, so a kill or a failed request doesn't lose them.
            batch = list(itertools.islice(self._queue, room))
            if not batch and dropped_count == 0:
                return None

        events_to_send = [entry.event for entry in batch]
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

        last_exc, attempts = self._send(events_to_send, deadline, timeout_cap)
        if last_exc is None:
            with self._lock:
                self._acknowledge(batch, dropped_count)
            return len(batch)
        self._give_up_on(batch, last_exc, attempts, len(events_to_send))
        return None

    def _send(
        self,
        events: list[WatcherEvent],
        deadline: float | None,
        timeout_cap: tuple[float, float],
    ) -> tuple[Exception | None, int]:
        """Send one request with the usual retries. Returns the last error (`None` on success)
        and the number of attempts."""
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
                    [event.to_dict() for event in events],
                    timeout=None if deadline is None else timeout_until(deadline, timeout_cap),
                )
                return None, attempts
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
        return last_exc, attempts

    def _acknowledge(self, batch: list[_Queued], dropped_count: int) -> None:
        """The server took *batch*, and the `events_dropped` event for *dropped_count* drops.

        The caller holds `_lock`.
        """
        removed = self._remove(batch)
        self._delete_rows(entry.row_id for entry in removed)
        # Drops that happened while the request was in flight stay reportable, so subtract
        # rather than zero. An entry of this batch that the cap dropped meanwhile was
        # counted as dropped but has now arrived, so it is taken back.
        arrived_after_drop = sum(1 for entry in batch if entry.dropped)
        self._dropped_count -= dropped_count + arrived_after_drop
        if self._dropped_count <= 0:
            self._dropped_count = 0
            self._dropped_since = None

    def _give_up_on(self, batch: list[_Queued], exc: Exception, attempts: int, sent: int) -> None:
        """A batch failed all its attempts: keep the entries that are saved, drop the others.

        Only a failure that may pass (no answer, or a 5xx) keeps a saved entry, in the queue
        and in the store, for the next flush. The synthetic prefix isn't counted — the prior
        drops it represents are still tracked in ``_dropped_count`` and the next successful
        flush surfaces them.
        """
        may_pass = isinstance(exc, ApiError) and exc.is_transient
        with self._lock:
            doomed = [entry for entry in batch if not (may_pass and entry.row_id is not None)]
            removed = self._remove(doomed)
            for entry in removed:
                entry.dropped = True
            if removed:
                self._note_drop(len(removed))
                self._delete_rows(entry.row_id for entry in removed)
        logger.warning(
            "Failed to flush %d event(s) after %d attempt(s): %s%s",
            sent,
            attempts,
            exc,
            "; the saved ones stay queued" if len(removed) < len(batch) else "",
        )
