"""Unit tests for `data_hub_watcher.events`.

Covers the three resilience properties added to ``EventReporter``:

* The structured ``report_error(kind, ...)`` helper queues an
  ``EventType.ERROR`` with the ``kind`` discriminator copied into
  ``details``.
* ``MAX_QUEUE_SIZE`` bounds the in-memory queue so a prolonged outage
  can't grow it without limit; the oldest events are dropped first.
* ``flush()`` retries up to ``FLUSH_RETRY_MAX`` with backoff, and a
  recovery flush after one or more drops prepends a synthetic
  ``kind=events_dropped`` event so the loss is visible in the
  dashboard.
"""

from __future__ import annotations
from unittest.mock import MagicMock, patch

import pytest

from data_hub_watcher.api_client import ApiError
from data_hub_watcher.events import (
    FLUSH_RETRY_MAX,
    EventReporter,
    EventType,
    WatcherEvent,
)


@pytest.fixture()
def client() -> MagicMock:
    return MagicMock()


@pytest.fixture()
def reporter(client: MagicMock) -> EventReporter:
    return EventReporter(client, watcher_id="w-test")


# ---------------------------------------------------------------------------
# report_error helper
# ---------------------------------------------------------------------------


class TestReportError:
    def test_queues_error_event_with_kind_in_details(self, reporter: EventReporter) -> None:
        reporter.report_error("run_report_failed", "boom", run_id="RUN-1", status_code=500)

        assert len(reporter._queue) == 1
        evt = reporter._queue[0]
        assert evt.event_type is EventType.ERROR
        assert evt.message == "boom"
        assert evt.details == {
            "kind": "run_report_failed",
            "run_id": "RUN-1",
            "status_code": 500,
        }


# ---------------------------------------------------------------------------
# Bounded queue
# ---------------------------------------------------------------------------


class TestBoundedQueue:
    def test_drops_oldest_when_queue_full(self, client: MagicMock) -> None:
        reporter = EventReporter(client, watcher_id="w-test", max_queue_size=3)

        for i in range(5):
            reporter.queue_event(
                WatcherEvent(event_type=EventType.RUN_REPORTED, message=f"run-{i}")
            )

        # Only the 3 freshest events survive; the 2 oldest were dropped.
        assert len(reporter._queue) == 3
        assert [e.message for e in reporter._queue] == ["run-2", "run-3", "run-4"]
        # And the drop is tracked so the next flush surfaces it.
        assert reporter._dropped_count == 2
        assert reporter._dropped_since is not None

    def test_drop_metadata_resets_after_successful_flush(self, client: MagicMock) -> None:
        reporter = EventReporter(client, watcher_id="w-test", max_queue_size=2)
        for i in range(3):  # one drop
            reporter.queue_event(
                WatcherEvent(event_type=EventType.RUN_REPORTED, message=f"run-{i}")
            )

        with patch("data_hub_watcher.events.time.sleep"):
            reporter.flush()

        assert reporter._dropped_count == 0
        assert reporter._dropped_since is None


# ---------------------------------------------------------------------------
# Flush retry-with-backoff
# ---------------------------------------------------------------------------


class TestFlushRetry:
    def test_succeeds_on_first_attempt(self, reporter: EventReporter, client: MagicMock) -> None:
        reporter.queue_event(WatcherEvent(event_type=EventType.WATCHER_STARTED, message="hi"))
        reporter.flush()
        assert client.send_events.call_count == 1
        assert len(reporter._queue) == 0

    def test_retries_then_succeeds(self, reporter: EventReporter, client: MagicMock) -> None:
        reporter.queue_event(WatcherEvent(event_type=EventType.WATCHER_STARTED, message="hi"))
        client.send_events.side_effect = [
            ApiError("transient", status_code=502),
            None,
        ]
        with patch("data_hub_watcher.events.time.sleep"):
            reporter.flush()
        assert client.send_events.call_count == 2
        # The successful retry must clear pending-drop tracking too.
        assert reporter._dropped_count == 0

    def test_drops_batch_after_exhausting_retries(
        self, reporter: EventReporter, client: MagicMock
    ) -> None:
        reporter.queue_event(WatcherEvent(event_type=EventType.WATCHER_STARTED, message="hi"))
        reporter.queue_event(WatcherEvent(event_type=EventType.WATCHER_STARTED, message="hi2"))
        client.send_events.side_effect = ApiError("dead", status_code=500)

        with patch("data_hub_watcher.events.time.sleep"):
            reporter.flush()

        # All FLUSH_RETRY_MAX attempts were made and the batch is gone.
        assert client.send_events.call_count == FLUSH_RETRY_MAX
        # The 2 real events became drops; the synthetic prefix isn't
        # double-counted.
        assert reporter._dropped_count == 2
        assert reporter._dropped_since is not None

    def test_recovery_flush_prepends_events_dropped_event(
        self, reporter: EventReporter, client: MagicMock
    ) -> None:
        # First batch fails completely so we accumulate drops.
        reporter.queue_event(WatcherEvent(event_type=EventType.WATCHER_STARTED, message="lost-1"))
        client.send_events.side_effect = ApiError("dead", status_code=500)
        with patch("data_hub_watcher.events.time.sleep"):
            reporter.flush()
        assert reporter._dropped_count == 1

        # Second batch succeeds — the synthetic events_dropped event
        # must be prepended to whatever else is in the queue.
        client.send_events.side_effect = None
        reporter.queue_event(WatcherEvent(event_type=EventType.RUN_REPORTED, message="run-1"))
        with patch("data_hub_watcher.events.time.sleep"):
            reporter.flush()

        # send_events was called twice (1 failure batch counts as
        # FLUSH_RETRY_MAX attempts, then 1 success).
        sent_payloads = [call.args[1] for call in client.send_events.call_args_list]
        last_batch = sent_payloads[-1]
        assert last_batch[0]["event_type"] == "error"
        assert last_batch[0]["details"]["kind"] == "events_dropped"
        assert last_batch[0]["details"]["dropped_count"] == 1
        # The real event is still present, after the synthetic prefix.
        assert last_batch[1]["message"] == "run-1"
        assert reporter._dropped_count == 0
