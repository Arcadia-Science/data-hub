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
import time
from unittest.mock import MagicMock, patch

import pytest

from data_hub_watcher.api_client import DEFAULT_TIMEOUT, ApiError
from data_hub_watcher.constants import SYSTEM_SHUTDOWN_HTTP_TIMEOUT
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

    def test_a_flush_without_a_deadline_keeps_the_clients_timeout(
        self, reporter: EventReporter, client: MagicMock
    ) -> None:
        reporter.queue_event(WatcherEvent(event_type=EventType.WATCHER_STARTED, message="hi"))

        reporter.flush()

        assert client.send_events.call_args.kwargs["timeout"] is None

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


# ---------------------------------------------------------------------------
# Flush with a deadline
# ---------------------------------------------------------------------------


class TestFlushWithADeadline:
    """A flush with a deadline, as when the watcher is stopping, retries only while it can.

    The usual flush retries up to three times, sleeping 1 s and 2 s between attempts and
    waiting up to 30 s for each answer. With a deadline each attempt has the client's usual
    HTTP timeout cut down to fit before it, a retry is made only if it would still have time
    to run and only after a failure that can't have left the batch stored, and none is made
    once the deadline has passed. The events route stores every batch it gets, so a retry
    after a request that was only slow would store the batch twice.
    """

    @staticmethod
    def _queue(reporter: EventReporter) -> None:
        reporter.queue_event(WatcherEvent(event_type=EventType.WATCHER_STOPPED, message="bye"))

    def test_sends_with_the_clients_usual_timeout_when_there_is_time(
        self, reporter: EventReporter, client: MagicMock
    ) -> None:
        self._queue(reporter)

        reporter.flush(deadline=time.monotonic() + 60)

        client.send_events.assert_called_once()
        assert client.send_events.call_args.kwargs["timeout"] == DEFAULT_TIMEOUT
        assert len(reporter._queue) == 0

    def test_a_server_that_answers_in_six_seconds_is_waited_for(
        self, reporter: EventReporter, client: MagicMock
    ) -> None:
        # With 20 s to the deadline the read timeout is far past the 5 s a stop used to cap
        # it at, so a slow server that does answer still gets the batch stored once.
        self._queue(reporter)

        reporter.flush(deadline=time.monotonic() + 20)

        connect, read = client.send_events.call_args.kwargs["timeout"]
        assert read > 6
        assert connect + read <= 20

    def test_the_timeout_is_capped_as_asked(
        self, reporter: EventReporter, client: MagicMock
    ) -> None:
        self._queue(reporter)

        reporter.flush(deadline=time.monotonic() + 20, timeout_cap=SYSTEM_SHUTDOWN_HTTP_TIMEOUT)

        assert client.send_events.call_args.kwargs["timeout"] == SYSTEM_SHUTDOWN_HTTP_TIMEOUT

    def test_the_timeout_shrinks_to_fit_what_is_left_of_the_deadline(
        self, reporter: EventReporter, client: MagicMock
    ) -> None:
        self._queue(reporter)

        reporter.flush(deadline=time.monotonic() + 2)

        connect, read = client.send_events.call_args.kwargs["timeout"]
        assert 0 < connect + read <= 2

    @pytest.mark.parametrize(
        "failure",
        [
            ApiError("Connection error: refused", status_code=0),
            ApiError("blip", status_code=503),
            ApiError("bad gateway", status_code=502),
        ],
        ids=["connection-error", "503", "502"],
    )
    def test_retries_after_a_failure_that_stored_nothing_while_the_deadline_allows(
        self, reporter: EventReporter, client: MagicMock, failure: ApiError
    ) -> None:
        self._queue(reporter)
        client.send_events.side_effect = [failure, None]

        with patch("data_hub_watcher.events.time.sleep") as sleep:
            reporter.flush(deadline=time.monotonic() + 20)

        assert client.send_events.call_count == 2
        sleep.assert_called_once_with(1.0)
        assert len(reporter._queue) == 0
        assert reporter._dropped_count == 0

    @pytest.mark.parametrize(
        "failure",
        [
            ApiError("Request timed out: slow", status_code=0, read_timed_out=True),
            ApiError("bad request", status_code=400),
            ApiError("too large", status_code=413),
            ValueError("the reply was not JSON"),
        ],
        ids=["read-timeout", "400", "413", "unreadable-reply"],
    )
    def test_does_not_retry_when_the_server_may_have_stored_the_batch_or_would_refuse_it(
        self, reporter: EventReporter, client: MagicMock, failure: Exception
    ) -> None:
        # A read timeout may be a server that stored the batch and is slow to say so, and an
        # error after a 2xx answer means it did store it: sending again would store it twice.
        # A 4xx fails the same way each time.
        self._queue(reporter)
        client.send_events.side_effect = failure

        with patch("data_hub_watcher.events.time.sleep") as sleep:
            reporter.flush(deadline=time.monotonic() + 60)

        assert client.send_events.call_count == 1
        sleep.assert_not_called()
        # The batch is dropped and counted, as after any failed flush.
        assert reporter._dropped_count == 1

    def test_gives_up_after_the_usual_number_of_attempts(
        self, reporter: EventReporter, client: MagicMock
    ) -> None:
        self._queue(reporter)
        client.send_events.side_effect = ApiError("dead", status_code=0)

        with patch("data_hub_watcher.events.time.sleep"):
            reporter.flush(deadline=time.monotonic() + 60)

        assert client.send_events.call_count == FLUSH_RETRY_MAX
        assert reporter._dropped_count == 1

    def test_does_not_retry_when_a_retry_would_not_have_time_to_run(
        self, reporter: EventReporter, client: MagicMock
    ) -> None:
        self._queue(reporter)
        client.send_events.side_effect = ApiError("dead", status_code=0)

        # The retry would wait 1 s and have less than a second left.
        with patch("data_hub_watcher.events.time.sleep") as sleep:
            reporter.flush(deadline=time.monotonic() + 1.5)

        assert client.send_events.call_count == 1
        sleep.assert_not_called()
        # The batch is dropped and counted, as after any failed flush.
        assert reporter._dropped_count == 1

    def test_stops_retrying_when_the_attempts_use_up_the_time(
        self, reporter: EventReporter, client: MagicMock
    ) -> None:
        # A fake clock: each attempt takes 2 s, as one that waits out its read timeout does,
        # and a sleep takes the time it is asked to.
        clock = [100.0]

        def attempt(*_args: object, **_kwargs: object) -> None:
            clock[0] += 2
            raise ApiError("timed out", status_code=0)

        def sleep(delay: float) -> None:
            clock[0] += delay

        self._queue(reporter)
        client.send_events.side_effect = attempt

        with (
            patch("data_hub_watcher.events.time.monotonic", side_effect=lambda: clock[0]),
            patch("data_hub_watcher.events.time.sleep", side_effect=sleep),
        ):
            reporter.flush(deadline=106.0)

        # 2 s, a 1 s wait, 2 s: another attempt would wait 2 s and then have under a second.
        assert client.send_events.call_count == 2
        assert reporter._dropped_count == 1

    def test_sends_nothing_once_the_deadline_has_passed(
        self, reporter: EventReporter, client: MagicMock
    ) -> None:
        self._queue(reporter)

        reporter.flush(deadline=time.monotonic() - 1)

        client.send_events.assert_not_called()
        # Not counted as dropped: a later flush could still send it.
        assert len(reporter._queue) == 1
        assert reporter._dropped_count == 0
