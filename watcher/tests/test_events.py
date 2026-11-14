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
import json
import sqlite3
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from data_hub_watcher.api_client import DEFAULT_TIMEOUT, ApiError
from data_hub_watcher.constants import SYSTEM_SHUTDOWN_HTTP_TIMEOUT
from data_hub_watcher.events import (
    FLUSH_RETRY_MAX,
    MAX_EVENTS_PER_REQUEST,
    MAX_FAILED_FLUSHES,
    EventReporter,
    EventType,
    WatcherEvent,
)
from data_hub_watcher.state import StateDB


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
        evt = reporter._queue[0].event
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
        assert [e.event.message for e in reporter._queue] == ["run-2", "run-3", "run-4"]
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

    @pytest.mark.parametrize(
        "failure",
        [
            ApiError("bad request", status_code=400),
            ApiError("forbidden", status_code=403),
            ApiError("too large", status_code=413),
            ValueError("the reply was not JSON"),
        ],
        ids=["400", "403", "413", "unreadable-reply"],
    )
    def test_a_failure_that_would_repeat_is_sent_once(
        self, reporter: EventReporter, client: MagicMock, failure: Exception
    ) -> None:
        # A 4xx fails the same way each time, and after a 2xx answer the server has the batch.
        reporter.queue_event(WatcherEvent(event_type=EventType.WATCHER_STARTED, message="hi"))
        client.send_events.side_effect = failure

        with patch("data_hub_watcher.events.time.sleep") as sleep:
            reporter.flush()

        assert client.send_events.call_count == 1
        sleep.assert_not_called()
        assert reporter._dropped_count == 1

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


# ---------------------------------------------------------------------------
# Batches of at most MAX_EVENTS_PER_REQUEST
# ---------------------------------------------------------------------------


def _event(i: int) -> WatcherEvent:
    return WatcherEvent(event_type=EventType.RUN_REPORTED, message=f"run-{i}")


def _json_of(event: WatcherEvent) -> str:
    return json.dumps(event.to_dict())


def _sent_batches(client: MagicMock) -> list[list[str]]:
    """The messages of each request, in the order they were sent."""
    return [[e["message"] for e in call.args[1]] for call in client.send_events.call_args_list]


class TestBatches:
    def test_the_server_takes_at_most_100_events_per_request(self) -> None:
        # `web/lib/api/openapi/schemas/watchers.ts` has `.max(100)`: a longer request is refused.
        assert MAX_EVENTS_PER_REQUEST == 100

    def test_a_long_queue_goes_out_in_requests_of_at_most_100_in_order(
        self, reporter: EventReporter, client: MagicMock
    ) -> None:
        for i in range(250):
            reporter.queue_event(_event(i))

        reporter.flush()

        batches = _sent_batches(client)
        assert [len(b) for b in batches] == [100, 100, 50]
        assert [m for b in batches for m in b] == [f"run-{i}" for i in range(250)]
        assert len(reporter._queue) == 0

    def test_the_events_dropped_event_counts_towards_the_limit(self, client: MagicMock) -> None:
        reporter = EventReporter(client, watcher_id="w-test", max_queue_size=150)
        for i in range(151):  # one drop
            reporter.queue_event(_event(i))

        reporter.flush()

        batches = _sent_batches(client)
        assert [len(b) for b in batches] == [100, 51]
        assert batches[0][0].startswith("Dropped 1 watcher event(s)")
        assert [m for b in batches for m in b][1:] == [f"run-{i}" for i in range(1, 151)]
        assert reporter._dropped_count == 0

    def test_a_batch_that_fails_ends_the_flush_and_the_ones_before_it_are_gone(
        self, reporter: EventReporter, client: MagicMock
    ) -> None:
        for i in range(150):
            reporter.queue_event(_event(i))
        client.send_events.side_effect = [None] + [ApiError("down", status_code=503)] * 3

        with patch("data_hub_watcher.events.time.sleep"):
            reporter.flush()

        # The 100 that were taken stay taken; the later 50 were tried, then dropped (this
        # reporter saves nothing) and counted. No request was made after the failure.
        assert client.send_events.call_count == 1 + FLUSH_RETRY_MAX
        assert len(reporter._queue) == 0
        assert reporter._dropped_count == 50

    def test_a_flush_with_a_deadline_stops_sending_batches_when_it_passes(
        self, reporter: EventReporter, client: MagicMock
    ) -> None:
        for i in range(250):
            reporter.queue_event(_event(i))
        deadline = time.monotonic() + 60

        def first_batch_uses_up_the_time(*_args: Any, **_kwargs: Any) -> None:
            patched_now.return_value = deadline + 1

        with patch("data_hub_watcher.events.time.monotonic") as patched_now:
            patched_now.return_value = deadline - 30
            client.send_events.side_effect = first_batch_uses_up_the_time
            reporter.flush(deadline=deadline)

        assert client.send_events.call_count == 1
        # What wasn't reached is still queued for a later flush.
        assert len(reporter._queue) == 150
        assert reporter._dropped_count == 0

    def test_events_the_cap_dropped_during_a_send_are_not_reported_as_lost(
        self, client: MagicMock
    ) -> None:
        # The oldest events are the ones being sent. If a burst of new ones pushes them out of
        # the queue while the request is in flight, they were counted as dropped, but the
        # server did take them.
        reporter = EventReporter(client, watcher_id="w-test", max_queue_size=3)
        for i in range(3):
            reporter.queue_event(_event(i))

        def burst(*_args: Any, **_kwargs: Any) -> None:
            reporter.queue_event(_event(3))
            reporter.queue_event(_event(4))

        client.send_events.side_effect = burst
        reporter.flush()

        assert [e.event.message for e in reporter._queue] == ["run-3", "run-4"]
        assert reporter._dropped_count == 0

    def test_events_queued_during_a_flush_wait_for_the_next_one(
        self, reporter: EventReporter, client: MagicMock
    ) -> None:
        # A thread that queues an event for every request that is sent would otherwise keep
        # the flush, and the heartbeat tick that runs it, from ever finishing.
        reporter.queue_event(_event(0))
        client.send_events.side_effect = lambda *_a, **_k: reporter.queue_event(_event(1))

        reporter.flush()

        assert client.send_events.call_count == 1
        assert [e.event.message for e in reporter._queue] == ["run-1"]

    def test_two_flushes_at_once_do_not_send_the_same_events_twice(
        self, reporter: EventReporter, client: MagicMock
    ) -> None:
        reporter.queue_event(_event(0))
        in_request = threading.Event()
        release = threading.Event()

        def slow(*_args: Any, **_kwargs: Any) -> None:
            in_request.set()
            release.wait(5)

        client.send_events.side_effect = slow
        first = threading.Thread(target=reporter.flush)
        first.start()
        assert in_request.wait(5)

        # A flush with a deadline gives up on the lock when the deadline comes.
        reporter.flush(deadline=time.monotonic() + 0.2)
        release.set()
        first.join(5)

        assert client.send_events.call_count == 1


# ---------------------------------------------------------------------------
# Events saved in the state database
# ---------------------------------------------------------------------------


@pytest.fixture()
def state(tmp_path: Path) -> Iterator[StateDB]:
    db = StateDB(tmp_path / "state.db")
    yield db
    db.close()


@pytest.fixture()
def saving(client: MagicMock, state: StateDB) -> EventReporter:
    """A reporter that has the state database attached, as the supervisor's has."""
    reporter = EventReporter(client, watcher_id="w-test")
    reporter.attach_store(state)
    return reporter


def _saved(state: StateDB, watcher_id: str = "w-test") -> list[str]:
    """The event messages saved for *watcher_id*, oldest first."""
    return [json.loads(raw)["message"] for _id, raw in state.pending_events(watcher_id)]


class TestSavedEvents:
    def test_a_queued_event_is_saved_until_the_server_has_it(
        self, saving: EventReporter, client: MagicMock, state: StateDB
    ) -> None:
        saving.queue_event(_event(1))
        saving.report_error("some_kind", "boom", n=2)
        assert _saved(state) == ["run-1", "boom"]

        saving.flush()

        assert _sent_batches(client) == [["run-1", "boom"]]
        assert _saved(state) == []
        assert len(saving._queue) == 0

    def test_events_survive_a_kill_and_are_sent_by_the_next_process(
        self, tmp_path: Path, client: MagicMock
    ) -> None:
        path = tmp_path / "state.db"
        before = StateDB(path)
        first = EventReporter(client, watcher_id="w-test")
        first.attach_store(before)
        for i in range(3):
            first.queue_event(_event(i))
        # The process dies here: nothing was flushed and nothing was closed properly.
        before.close()
        client.send_events.assert_not_called()

        after = StateDB(path)
        try:
            second = EventReporter(client, watcher_id="w-test")
            second.attach_store(after)
            second.queue_event(_event(3))
            second.flush()

            # The saved events go first, in the order they were queued, then the new one.
            assert _sent_batches(client) == [["run-0", "run-1", "run-2", "run-3"]]
            assert after.pending_events("w-test") == []
        finally:
            after.close()

    def test_event_details_and_timestamp_come_back_as_they_were_queued(
        self, tmp_path: Path, client: MagicMock
    ) -> None:
        path = tmp_path / "state.db"
        before = StateDB(path)
        first = EventReporter(client, watcher_id="w-test")
        first.attach_store(before)
        event = WatcherEvent(
            event_type=EventType.FILE_UPLOADED,
            message="uploaded",
            details={"s3_key": "a/b.csv", "size_bytes": 3, "nested": {"k": [1, 2]}},
            timestamp="2026-01-02T03:04:05+00:00",
        )
        first.queue_event(event)
        before.close()

        after = StateDB(path)
        try:
            second = EventReporter(client, watcher_id="w-test")
            second.attach_store(after)
            second.flush()
        finally:
            after.close()

        assert client.send_events.call_args.args[1] == [event.to_dict()]

    def test_events_queued_before_the_store_is_attached_are_saved_behind_the_saved_ones(
        self, client: MagicMock, state: StateDB
    ) -> None:
        earlier = EventReporter(client, watcher_id="w-test")
        earlier.attach_store(state)
        earlier.queue_event(_event(0))

        reporter = EventReporter(client, watcher_id="w-test")
        reporter.queue_event(_event(1))
        assert _saved(state) == ["run-0"]
        reporter.attach_store(state)

        assert _saved(state) == ["run-0", "run-1"]
        reporter.flush()
        assert _sent_batches(client) == [["run-0", "run-1"]]
        assert _saved(state) == []

    def test_a_saved_batch_goes_out_in_requests_of_at_most_100_and_is_deleted_as_it_is_taken(
        self, saving: EventReporter, client: MagicMock, state: StateDB
    ) -> None:
        for i in range(250):
            saving.queue_event(_event(i))
        left_during_each_request: list[int] = []

        def take(*_args: Any, **_kwargs: Any) -> None:
            left_during_each_request.append(len(state.pending_events("w-test")))

        client.send_events.side_effect = take
        saving.flush()

        assert [len(b) for b in _sent_batches(client)] == [100, 100, 50]
        # Each request is made while its events are still saved, so a kill during it loses
        # nothing. They are deleted when the server has answered.
        assert left_during_each_request == [250, 150, 50]
        assert _saved(state) == []

    def test_a_batch_that_fails_to_send_stays_saved_and_the_next_flush_sends_it(
        self, saving: EventReporter, client: MagicMock, state: StateDB
    ) -> None:
        saving.queue_event(_event(1))
        saving.queue_event(_event(2))
        client.send_events.side_effect = ApiError("down", status_code=503)

        with patch("data_hub_watcher.events.time.sleep"):
            saving.flush()

        assert client.send_events.call_count == FLUSH_RETRY_MAX
        assert _saved(state) == ["run-1", "run-2"]
        assert saving._dropped_count == 0

        client.send_events.reset_mock(side_effect=True)
        saving.queue_event(_event(3))
        saving.flush()

        assert _sent_batches(client) == [["run-1", "run-2", "run-3"]]
        assert _saved(state) == []

    @pytest.mark.parametrize(
        "failure",
        [
            ApiError("Connection error: refused", status_code=0),
            ApiError("bad gateway", status_code=502),
            ApiError("unavailable", status_code=503),
            ApiError("gateway timeout", status_code=504),
        ],
        ids=["connection-error", "502", "503", "504"],
    )
    def test_a_batch_is_kept_for_as_long_as_nothing_reaches_the_server(
        self, saving: EventReporter, client: MagicMock, state: StateDB, failure: ApiError
    ) -> None:
        saving.queue_event(_event(1))
        client.send_events.side_effect = failure

        with patch("data_hub_watcher.events.time.sleep"):
            for _ in range(5 * MAX_FAILED_FLUSHES):
                saving.flush()

        # Nothing was stored, so no number of failed flushes can store it twice, or drop it.
        assert client.send_events.call_count == 5 * MAX_FAILED_FLUSHES * FLUSH_RETRY_MAX
        assert _saved(state) == ["run-1"]
        assert len(saving._queue) == 1
        assert saving._dropped_count == 0

        # It is delivered, once, when the server is back.
        client.send_events.reset_mock(side_effect=True)
        saving.flush()
        assert _sent_batches(client) == [["run-1"]]
        assert _saved(state) == []
        assert saving._dropped_count == 0

    def test_a_batch_kept_across_a_restart_is_delivered_when_the_server_is_back(
        self, tmp_path: Path, client: MagicMock
    ) -> None:
        path = tmp_path / "state.db"
        client.send_events.side_effect = ApiError("Connection error: refused", status_code=0)
        for start in range(3):  # three starts of the watcher, with the server down at each
            db = StateDB(path)
            try:
                reporter = EventReporter(client, watcher_id="w-test")
                reporter.attach_store(db)
                reporter.queue_event(_event(start))
                with patch("data_hub_watcher.events.time.sleep"):
                    for _ in range(2 * MAX_FAILED_FLUSHES):
                        reporter.flush()
                reporter.detach_store()
            finally:
                db.close()

        client.send_events.reset_mock(side_effect=True)
        db = StateDB(path)
        try:
            reporter = EventReporter(client, watcher_id="w-test")
            reporter.attach_store(db)
            reporter.flush()
            assert _sent_batches(client) == [["run-0", "run-1", "run-2"]]
            assert db.pending_events("w-test") == []
        finally:
            db.close()

    @pytest.mark.parametrize(
        "failure",
        [
            ApiError("internal error", status_code=500),
            ApiError("not implemented", status_code=501),
            ApiError("Request timed out", status_code=0, read_timed_out=True),
        ],
        ids=["500", "501", "read-timeout"],
    )
    def test_a_batch_that_may_have_reached_the_server_is_kept_for_a_few_flushes_then_dropped(
        self, saving: EventReporter, client: MagicMock, state: StateDB, failure: ApiError
    ) -> None:
        saving.queue_event(_event(1))
        client.send_events.side_effect = failure

        with patch("data_hub_watcher.events.time.sleep"):
            for _ in range(MAX_FAILED_FLUSHES - 1):
                saving.flush()
                assert _saved(state) == ["run-1"]
                assert saving._dropped_count == 0
            saving.flush()

        assert _saved(state) == []
        assert len(saving._queue) == 0
        assert saving._dropped_count == 1

    def test_a_batch_that_gets_a_500_every_time_does_not_hold_up_the_events_after_it(
        self, saving: EventReporter, client: MagicMock, state: StateDB
    ) -> None:
        # The server fails whenever one event is in the batch (a value that the database
        # refuses, say) and stores any other batch. The poison event is the oldest, with 129
        # events behind it: the first request holds it and 99 of them.
        stored: list[str] = []

        def server(_watcher_id: str, events: list[dict[str, Any]], **_kwargs: Any) -> None:
            if any(e["message"] == "POISON" for e in events):
                raise ApiError("Internal server error", status_code=500)
            stored.extend(e["message"] for e in events)

        client.send_events.side_effect = server
        saving.queue_event(WatcherEvent(event_type=EventType.ERROR, message="POISON"))
        for i in range(129):
            saving.queue_event(_event(i))

        with patch("data_hub_watcher.events.time.sleep"):
            for flushes in range(1, MAX_FAILED_FLUSHES):
                saving.flush()
                assert len(_saved(state)) == 130, f"dropped too early, after {flushes}"
            saving.flush()
            # The batch of 100 is dropped and counted. The 30 behind it are untouched.
            assert len(_saved(state)) == 30
            assert saving._dropped_count == 100
            assert stored == []

            saving.flush()

        assert stored[0].startswith("Dropped 100 watcher event(s)")
        assert stored[1:] == [f"run-{i}" for i in range(99, 129)]
        assert _saved(state) == []
        assert len(saving._queue) == 0
        assert saving._dropped_count == 0

    def test_failed_flushes_are_counted_per_event_and_not_forgotten_by_a_gateway_error(
        self, saving: EventReporter, client: MagicMock, state: StateDB
    ) -> None:
        saving.queue_event(_event(1))
        server_error = ApiError("internal error", status_code=500)
        unavailable = ApiError("unavailable", status_code=503)
        # Three flushes that may have reached the server, with some that didn't between them.
        outcomes = [server_error, unavailable, unavailable, server_error, unavailable]

        with patch("data_hub_watcher.events.time.sleep"):
            for failure in outcomes:
                client.send_events.side_effect = failure
                saving.flush()
            assert _saved(state) == ["run-1"]
            assert saving._dropped_count == 0

            client.send_events.side_effect = server_error
            saving.flush()

        assert _saved(state) == []
        assert saving._dropped_count == 1

    def test_an_event_that_arrives_after_a_failed_flush_has_its_own_count(
        self, saving: EventReporter, client: MagicMock, state: StateDB
    ) -> None:
        # The count is the event's own, not the batch's: the first event has been in one
        # failed flush when the second is queued, so it is in three by the end and the second
        # in two.
        saving.queue_event(_event(1))
        client.send_events.side_effect = ApiError("internal error", status_code=500)
        with patch("data_hub_watcher.events.time.sleep"):
            saving.flush()
            saving.queue_event(_event(2))
            for _ in range(MAX_FAILED_FLUSHES - 1):
                saving.flush()
            assert _saved(state) == ["run-2"]

            client.send_events.side_effect = None
            saving.flush()

        assert _sent_batches(client)[-1][0].startswith("Dropped 1 watcher event(s)")
        assert _sent_batches(client)[-1][1:] == ["run-2"]
        assert _saved(state) == []

    def test_a_batch_that_times_out_every_time_is_sent_a_bounded_number_of_times(
        self, saving: EventReporter, client: MagicMock, state: StateDB
    ) -> None:
        # A slow server that stores each request it gets and answers after the timeout. Each
        # flush without a deadline sends the batch `FLUSH_RETRY_MAX` times, and the batch is
        # dropped after `MAX_FAILED_FLUSHES` flushes. It used to be sent again at every tick.
        stored: list[str] = []

        def slow_but_saving(_watcher_id: str, events: list[dict[str, Any]], **_kwargs: Any) -> None:
            stored.extend(e["message"] for e in events)
            raise ApiError("Request timed out", status_code=0, read_timed_out=True)

        client.send_events.side_effect = slow_but_saving
        saving.queue_event(_event(1))

        with patch("data_hub_watcher.events.time.sleep"):
            for _ in range(MAX_FAILED_FLUSHES):
                saving.flush()

        assert stored == ["run-1"] * (MAX_FAILED_FLUSHES * FLUSH_RETRY_MAX)
        assert _saved(state) == []
        assert saving._dropped_count == 1

        # The server answers in time again: only the report of the drop is left to send.
        stored.clear()
        client.send_events.side_effect = lambda _w, events, **_k: stored.extend(
            e["message"] for e in events
        )
        saving.flush()
        saving.flush()
        assert stored == ["Dropped 1 watcher event(s) due to API errors"]

    def test_a_flush_with_a_deadline_sends_a_batch_that_times_out_once(
        self, saving: EventReporter, client: MagicMock, state: StateDB
    ) -> None:
        # The stop's flush: no retry after a read timeout, and the batch waits for the next start.
        saving.queue_event(_event(1))
        client.send_events.side_effect = ApiError("timed out", status_code=0, read_timed_out=True)

        with patch("data_hub_watcher.events.time.sleep"):
            saving.flush(deadline=time.monotonic() + 60)

        assert client.send_events.call_count == 1
        assert _saved(state) == ["run-1"]

    def test_the_failed_flush_count_is_not_saved_across_a_restart(
        self, tmp_path: Path, client: MagicMock
    ) -> None:
        path = tmp_path / "state.db"
        client.send_events.side_effect = ApiError("internal error", status_code=500)
        for _ in range(3):
            db = StateDB(path)
            try:
                reporter = EventReporter(client, watcher_id="w-test")
                reporter.attach_store(db)
                if not db.pending_events("w-test"):
                    reporter.queue_event(_event(1))
                with patch("data_hub_watcher.events.time.sleep"):
                    for _ in range(MAX_FAILED_FLUSHES - 1):
                        reporter.flush()
                reporter.detach_store()
                # Still saved: each process makes only two failed flushes of three.
                assert len(db.pending_events("w-test")) == 1
            finally:
                db.close()

    @pytest.mark.parametrize(
        "failure",
        [
            ApiError("bad request", status_code=400),
            ApiError("forbidden", status_code=403),
            ValueError("the reply was not JSON"),
        ],
        ids=["400", "403", "unreadable-reply"],
    )
    def test_a_batch_the_server_refuses_is_dropped_and_counted_so_it_cannot_block_the_rest(
        self, saving: EventReporter, client: MagicMock, state: StateDB, failure: Exception
    ) -> None:
        # Sending it again would fail the same way, or store it twice, and every later event
        # would wait behind it.
        saving.queue_event(_event(1))
        client.send_events.side_effect = failure

        with patch("data_hub_watcher.events.time.sleep"):
            saving.flush()

        assert _saved(state) == []
        assert len(saving._queue) == 0
        assert saving._dropped_count == 1

    def test_only_the_batch_that_failed_stays_saved(
        self, saving: EventReporter, client: MagicMock, state: StateDB
    ) -> None:
        for i in range(150):
            saving.queue_event(_event(i))
        client.send_events.side_effect = [None] + [ApiError("down", status_code=503)] * 3

        with patch("data_hub_watcher.events.time.sleep"):
            saving.flush()

        assert _saved(state) == [f"run-{i}" for i in range(100, 150)]

    def test_the_queue_is_capped_in_the_database_too(
        self, client: MagicMock, state: StateDB
    ) -> None:
        reporter = EventReporter(client, watcher_id="w-test", max_queue_size=3)
        reporter.attach_store(state)

        for i in range(5):
            reporter.queue_event(_event(i))

        assert _saved(state) == ["run-2", "run-3", "run-4"]
        assert [e.event.message for e in reporter._queue] == ["run-2", "run-3", "run-4"]
        assert reporter._dropped_count == 2
        reporter.flush()
        assert _sent_batches(client)[0][0].startswith("Dropped 2 watcher event(s)")

    def test_more_saved_events_than_the_cap_are_trimmed_when_the_store_is_attached(
        self, client: MagicMock, state: StateDB
    ) -> None:
        for i in range(5):
            state.add_pending_event("w-test", _json_of(_event(i)))
        reporter = EventReporter(client, watcher_id="w-test", max_queue_size=3)

        reporter.attach_store(state)

        assert _saved(state) == ["run-2", "run-3", "run-4"]
        assert reporter._dropped_count == 2

    def test_events_saved_for_another_watcher_are_discarded_and_never_sent(
        self, client: MagicMock, state: StateDB
    ) -> None:
        # The file served a watcher that was deregistered and registered again.
        state.add_pending_event("w-old", _json_of(_event(0)))
        state.add_pending_event("w-test", _json_of(_event(1)))
        reporter = EventReporter(client, watcher_id="w-test")

        reporter.attach_store(state)
        reporter.flush()

        assert _sent_batches(client) == [["run-1"]]
        assert state.pending_events("w-old") == []

    def test_saved_events_this_version_cannot_read_are_discarded(
        self, client: MagicMock, state: StateDB
    ) -> None:
        state.add_pending_event("w-test", "not json")
        state.add_pending_event("w-test", _json_of(_event(1)))
        state.add_pending_event(
            "w-test",
            json.dumps(
                {
                    "event_type": "from_a_newer_version",
                    "message": "m",
                    "details": {},
                    "timestamp": "t",
                }
            ),
        )
        state.add_pending_event("w-test", '{"message": "no type"}')
        reporter = EventReporter(client, watcher_id="w-test")

        reporter.attach_store(state)
        reporter.flush()

        assert _sent_batches(client) == [["run-1"]]
        assert state.pending_events("w-test") == []

    def test_a_reporter_takes_one_store_only(self, saving: EventReporter, state: StateDB) -> None:
        with pytest.raises(RuntimeError):
            saving.attach_store(state)

    def test_after_the_store_is_detached_events_stay_in_memory(
        self, saving: EventReporter, client: MagicMock, state: StateDB
    ) -> None:
        saving.queue_event(_event(1))
        saving.detach_store()
        state.close()  # as the supervisor does next. A write now would open it again.

        saving.queue_event(_event(2))
        saving.report_error("late", "from a tick that was left running")
        saving.flush()

        # The event that was saved isn't sent by this process: the next start sends it, and
        # this one couldn't delete the row afterwards. The late ones go out from memory.
        assert _sent_batches(client) == [["run-2", "from a tick that was left running"]]
        reopened = StateDB(state._db_path)
        try:
            assert _saved(reopened) == ["run-1"]
        finally:
            reopened.close()

    def test_detaching_without_a_store_does_nothing(self, reporter: EventReporter) -> None:
        reporter.queue_event(_event(1))
        reporter.detach_store()
        assert len(reporter._queue) == 1

    def test_an_event_that_cannot_be_saved_is_still_sent_by_this_process(
        self, saving: EventReporter, client: MagicMock, state: StateDB
    ) -> None:
        # A full disk, say. It is the case that `state_write_failed` events are about.
        with patch.object(
            state, "add_pending_event", side_effect=sqlite3.OperationalError("disk is full")
        ):
            saving.report_error("state_write_failed", "disk is full")
        saving.queue_event(_event(2))

        saving.flush()

        assert _sent_batches(client) == [["disk is full", "run-2"]]
        assert _saved(state) == []

    def test_an_event_that_cannot_be_saved_is_dropped_after_a_failed_send(
        self, saving: EventReporter, client: MagicMock, state: StateDB
    ) -> None:
        with patch.object(state, "add_pending_event", side_effect=sqlite3.OperationalError("full")):
            saving.queue_event(_event(1))
        saving.queue_event(_event(2))
        client.send_events.side_effect = ApiError("down", status_code=503)

        with patch("data_hub_watcher.events.time.sleep"):
            saving.flush()

        # Only the one that is saved is kept for the next flush.
        assert [e.event.message for e in saving._queue] == ["run-2"]
        assert _saved(state) == ["run-2"]
        assert saving._dropped_count == 1

    def test_a_row_that_cannot_be_deleted_does_not_stop_the_flush(
        self, saving: EventReporter, client: MagicMock, state: StateDB
    ) -> None:
        saving.queue_event(_event(1))

        with patch.object(
            state, "delete_pending_events", side_effect=sqlite3.OperationalError("locked")
        ):
            saving.flush()

        assert len(saving._queue) == 0
        # The row stays and is sent again after a restart: the rare duplicate that is accepted.
        assert _saved(state) == ["run-1"]

    def test_a_store_that_cannot_be_read_leaves_the_reporter_working_in_memory(
        self, client: MagicMock, state: StateDB
    ) -> None:
        reporter = EventReporter(client, watcher_id="w-test")
        reporter.queue_event(_event(1))

        with patch.object(state, "pending_events", side_effect=sqlite3.DatabaseError("malformed")):
            reporter.attach_store(state)
        reporter.queue_event(_event(2))
        reporter.flush()

        assert _sent_batches(client) == [["run-1", "run-2"]]
        assert _saved(state) == []

    def test_events_queued_from_many_threads_are_all_saved_and_sent_once(
        self, saving: EventReporter, client: MagicMock, state: StateDB
    ) -> None:
        def queue(thread: int) -> None:
            for i in range(30):
                saving.queue_event(_event(thread * 100 + i))

        threads = [threading.Thread(target=queue, args=(n,)) for n in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        assert len(_saved(state)) == 240

        saving.flush()

        sent = [m for batch in _sent_batches(client) for m in batch]
        assert sorted(sent) == sorted(f"run-{n * 100 + i}" for n in range(8) for i in range(30))
        assert _saved(state) == []

    def test_a_reporter_without_a_store_never_touches_a_database(
        self, reporter: EventReporter, client: MagicMock
    ) -> None:
        # The environment switch and the `upload` command report this way.
        reporter.queue_event(_event(1))
        client.send_events.side_effect = ApiError("down", status_code=503)

        with patch("data_hub_watcher.events.time.sleep"):
            reporter.flush()

        assert reporter._store is None
        # Memory only, so a batch that can't be sent is dropped and counted, as it always was.
        assert len(reporter._queue) == 0
        assert reporter._dropped_count == 1

    def test_the_log_says_how_many_saved_events_stay_queued(
        self,
        saving: EventReporter,
        client: MagicMock,
        state: StateDB,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        with patch.object(state, "add_pending_event", side_effect=sqlite3.OperationalError("full")):
            saving.queue_event(_event(1))  # not saved, so dropped
        saving.queue_event(_event(2))
        saving.queue_event(_event(3))
        client.send_events.side_effect = ApiError("down", status_code=503)

        with patch("data_hub_watcher.events.time.sleep"), caplog.at_level("WARNING"):
            saving.flush()

        assert "; 2 saved event(s) stay queued" in caplog.text

    def test_the_log_does_not_say_events_stay_queued_when_the_cap_dropped_them_meanwhile(
        self,
        client: MagicMock,
        state: StateDB,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        # The server refuses a batch of three while a burst pushes two of its events out of
        # the queue. Only one of the three was still queued to be dropped, and none is kept.
        reporter = EventReporter(client, watcher_id="w-test", max_queue_size=3)
        reporter.attach_store(state)
        for i in range(3):
            reporter.queue_event(_event(i))

        def refuse_after_a_burst(*_args: Any, **_kwargs: Any) -> None:
            reporter.queue_event(_event(3))
            reporter.queue_event(_event(4))
            raise ApiError("bad request", status_code=400)

        client.send_events.side_effect = refuse_after_a_burst

        with caplog.at_level("WARNING"):
            reporter.flush()

        assert "stay queued" not in caplog.text
        assert _saved(state) == ["run-3", "run-4"]
        assert [e.event.message for e in reporter._queue] == ["run-3", "run-4"]


class TestDetachingWhileAFlushRuns:
    """A heartbeat tick that a stop gave up on can still be sending a batch when the store is
    detached. If the server takes it, the flush has to delete its rows before the store goes,
    or the next start sends the batch again.
    """

    @staticmethod
    def _flush_in_a_thread(
        saving: EventReporter, client: MagicMock
    ) -> tuple[threading.Thread, threading.Event, list[str]]:
        """Start a flush whose request waits for the returned event, then stores the batch."""
        stored: list[str] = []
        in_request = threading.Event()
        release = threading.Event()

        def slow(_watcher_id: str, events: list[dict[str, Any]], **_kwargs: Any) -> None:
            in_request.set()
            release.wait(10)
            stored.extend(e["message"] for e in events)

        client.send_events.side_effect = slow
        thread = threading.Thread(target=saving.flush)
        thread.start()
        assert in_request.wait(5)
        return thread, release, stored

    def test_a_flush_that_ends_in_time_deletes_its_rows_before_the_store_is_detached(
        self, saving: EventReporter, client: MagicMock, state: StateDB
    ) -> None:
        saving.queue_event(_event(1))
        tick, release, stored = self._flush_in_a_thread(saving, client)
        # The stop's own flush gave up on the lock at its deadline.
        saving.flush(deadline=time.monotonic() + 0.1)
        threading.Timer(0.2, release.set).start()

        saving.detach_store(wait_for_flush=5)
        tick.join(5)

        assert stored == ["run-1"]
        assert _saved(state) == []
        assert saving._store is None

    def test_a_flush_that_is_still_running_when_the_wait_ends_leaves_its_rows_for_the_next_start(
        self, saving: EventReporter, client: MagicMock, state: StateDB
    ) -> None:
        # What is left of the problem: the request outlasts the stop. The server takes the
        # batch and the next start sends it again, a duplicate that is accepted.
        saving.queue_event(_event(1))
        tick, release, stored = self._flush_in_a_thread(saving, client)

        began = time.monotonic()
        saving.detach_store(wait_for_flush=0.1)
        assert time.monotonic() - began < 2
        release.set()
        tick.join(5)

        assert stored == ["run-1"]
        assert _saved(state) == ["run-1"]
        assert len(saving._queue) == 0

    def test_detaching_without_a_wait_does_not_wait_for_a_flush(
        self, saving: EventReporter, client: MagicMock, state: StateDB
    ) -> None:
        saving.queue_event(_event(1))
        tick, release, _stored = self._flush_in_a_thread(saving, client)

        began = time.monotonic()
        saving.detach_store()
        elapsed = time.monotonic() - began
        release.set()
        tick.join(5)

        assert elapsed < 1
        assert saving._store is None

    def test_a_flush_that_starts_after_the_detach_sends_from_memory(
        self, saving: EventReporter, client: MagicMock, state: StateDB
    ) -> None:
        saving.queue_event(_event(1))
        saving.detach_store(wait_for_flush=1)
        saving.queue_event(_event(2))

        saving.flush()

        assert _sent_batches(client) == [["run-2"]]
        assert _saved(state) == ["run-1"]
