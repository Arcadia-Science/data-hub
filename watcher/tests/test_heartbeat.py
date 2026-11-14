"""Unit tests for ``HeartbeatLoop``.

Two behaviours are exercised here:

1. The recovery path: heartbeat *failures* are by definition
   unreportable in real time (the network they depend on is down), so
   the watcher accumulates a counter and emits a
   ``kind=heartbeat_recovered`` event on the first successful
   heartbeat after one or more failures. That recovery event is the
   only signal an operator gets that the watcher went dark.

2. The startup path: ``start()`` must send a synchronous heartbeat
   *and* flush queued events before spawning the loop thread, so the
   dashboard sees the watcher come up immediately rather than after a
   full ``interval`` of silence — and, in particular, before the
   ``FileMonitor.start()`` call that runs the (potentially multi-minute)
   initial directory scan on the same thread.

3. The stop path: ``stop_loop()`` must wait for a tick that is still running
   before the final ``stopped`` heartbeat is sent, however short the
   heartbeat interval is. ``send_final_heartbeat()`` sends it, with a short
   timeout when the stop has a deadline.

4. A deregistered watcher: three heartbeats in a row that the server answers with its
   "deregistered" reply end the loop and call ``on_deregistered``, and nothing else does. The
   count is shared by every loop of the watcher.
"""

from __future__ import annotations
import itertools
import sys
import threading
import time
from typing import Any
from unittest.mock import MagicMock

import pytest

from data_hub_watcher.api_client import DEFAULT_TIMEOUT, ApiError
from data_hub_watcher.constants import (
    DEREGISTERED_HEARTBEAT_THRESHOLD,
    SYSTEM_SHUTDOWN_HTTP_TIMEOUT,
)
from data_hub_watcher.events import EventReporter
from data_hub_watcher.heartbeat import DeregisteredReplies, HeartbeatLoop, WatcherCounters
from data_hub_watcher.models import ApiErrorDetail


def _make_loop(client: MagicMock, reporter: MagicMock) -> HeartbeatLoop:
    return HeartbeatLoop(
        client=client,
        watcher_id="w-test",
        interval_seconds=60,
        event_reporter=reporter,
        instrument_id="inst-1",
        watch_directory="/tmp/watch",
        upload_mode="auto",
    )


class TestHeartbeatRecovery:
    def test_recovery_event_emitted_after_outage(self) -> None:
        client = MagicMock()
        client.send_heartbeat.side_effect = [
            ApiError("offline", status_code=0),
            ApiError("offline", status_code=0),
            None,  # recovery
        ]
        reporter = MagicMock(spec=EventReporter)
        loop = _make_loop(client, reporter)

        loop._send_heartbeat()  # fail
        loop._send_heartbeat()  # fail
        loop._send_heartbeat()  # success -> emit recovery event

        assert reporter.report_error.call_count == 1
        call = reporter.report_error.call_args
        assert call.args[0] == "heartbeat_recovered"
        assert call.kwargs["consecutive_failures"] == 2
        # gap_seconds is computed from monotonic time and should be
        # non-negative; we don't pin a precise value.
        assert call.kwargs["gap_seconds"] >= 0

    def test_no_event_when_no_failures(self) -> None:
        client = MagicMock()
        reporter = MagicMock(spec=EventReporter)
        loop = _make_loop(client, reporter)

        loop._send_heartbeat()
        loop._send_heartbeat()

        reporter.report_error.assert_not_called()

    def test_failures_alone_do_not_emit_event(self) -> None:
        """Emitting *during* an outage is pointless — the same network
        the heartbeat needs is the one we'd POST events over."""
        client = MagicMock()
        client.send_heartbeat.side_effect = ApiError("offline", status_code=0)
        reporter = MagicMock(spec=EventReporter)
        loop = _make_loop(client, reporter)

        for _ in range(5):
            loop._send_heartbeat()

        reporter.report_error.assert_not_called()


class TestHeartbeatStartupBeat:
    """``start()`` must send an immediate heartbeat + flush before looping.

    The runtime calls ``HeartbeatLoop.start()`` *just before*
    ``FileMonitor.start()``, which runs the synchronous initial
    directory scan. On large or networked watch volumes that scan can
    block the main thread for several minutes. Without a synchronous
    startup beat the dashboard sees no liveness signal — and the
    ``WATCHER_STARTED`` event the runtime queued moments earlier
    doesn't get flushed — for that whole window, which is
    indistinguishable from a hung process.
    """

    def _stop(self, loop: HeartbeatLoop) -> None:
        """Tear down the daemon thread spawned by ``start()``.

        ``HeartbeatLoop.stop()`` would also send a final ``status=stopped``
        heartbeat, which would muddy the assertions in these tests. We
        only need the loop thread to exit so the test process doesn't
        leak threads, so we set the stop event and join directly.
        """
        loop._stop_event.set()
        if loop._thread is not None:
            loop._thread.join(timeout=5)

    def test_start_sends_immediate_watching_heartbeat(self) -> None:
        client = MagicMock()
        reporter = MagicMock(spec=EventReporter)
        loop = _make_loop(client, reporter)

        loop.start()
        try:
            assert client.send_heartbeat.call_count >= 1
            first_call = client.send_heartbeat.call_args_list[0]
            assert first_call.args[0] == "w-test"
            payload = first_call.args[1]
            assert payload["status"] == "watching"
            assert payload["instrument_id"] == "inst-1"
            assert payload["watch_directory"] == "/tmp/watch"
        finally:
            self._stop(loop)

    def test_start_flushes_event_reporter_before_loop_thread(self) -> None:
        """The flush must run before the loop thread is spawned, so
        ``WATCHER_STARTED`` (queued by the runtime moments earlier)
        reaches the dashboard before any long-running initial scan
        starts on the main thread.
        """
        client = MagicMock()
        reporter = MagicMock(spec=EventReporter)
        # Capture the live thread state at the moment ``flush`` runs so
        # we can prove the call originates from the main thread, not
        # from the loop thread that ``start()`` spawns afterwards.
        flush_thread_names: list[str] = []
        flush_called_before_thread_alive: list[bool] = []

        def _record_flush() -> None:
            flush_thread_names.append(threading.current_thread().name)
            flush_called_before_thread_alive.append(
                loop._thread is None or not loop._thread.is_alive()
            )

        reporter.flush.side_effect = _record_flush
        loop = _make_loop(client, reporter)

        loop.start()
        try:
            assert reporter.flush.call_count >= 1
            assert flush_thread_names[0] == threading.current_thread().name
            assert flush_called_before_thread_alive[0] is True
        finally:
            self._stop(loop)

    def test_start_proceeds_when_initial_heartbeat_fails(self) -> None:
        """A startup-time API outage must not prevent the loop from running.

        ``_send_heartbeat`` already swallows ``ApiError``/``Exception``
        and bumps the consecutive-failure counter; ``flush`` likewise
        retries internally and re-queues on failure. ``start()`` must
        therefore still spawn the loop thread so subsequent ticks can
        recover and emit the standard ``heartbeat_recovered`` event.
        """
        client = MagicMock()
        client.send_heartbeat.side_effect = ApiError("offline", status_code=0)
        reporter = MagicMock(spec=EventReporter)
        loop = _make_loop(client, reporter)

        loop.start()
        try:
            assert loop._thread is not None
            assert loop._thread.is_alive()
            # The failed startup beat must have been recorded so the
            # next successful tick emits ``heartbeat_recovered``.
            assert loop._consecutive_heartbeat_failures >= 1
        finally:
            self._stop(loop)

    def test_startup_beat_fires_before_loop_would_have(self) -> None:
        """End-to-end timing guard: the first heartbeat must land
        well before the configured ``interval``. With the old
        loop-only behaviour the first beat was deferred by the full
        interval, so this test would fail (or hang) without the
        synchronous startup beat. We use a generous 1 s interval and
        a 100 ms ceiling so the assertion is robust against CI
        scheduling jitter.
        """
        client = MagicMock()
        reporter = MagicMock(spec=EventReporter)
        loop = HeartbeatLoop(
            client=client,
            watcher_id="w-test",
            # 1 s is plenty long enough that a loop-driven first beat
            # would not have fired by the time we measure.
            interval_seconds=1,
            event_reporter=reporter,
            instrument_id="inst-1",
            watch_directory="/tmp/watch",
            upload_mode="auto",
        )

        before = time.monotonic()
        loop.start()
        try:
            elapsed = time.monotonic() - before
            assert client.send_heartbeat.call_count >= 1
            assert elapsed < 0.1, (
                f"Startup heartbeat took {elapsed:.3f}s — must fire "
                "synchronously, not via the loop's interval wait."
            )
        finally:
            self._stop(loop)


class TestHeartbeatStop:
    """``stop_loop()`` joins the loop thread, and ``stop()`` does it before ``status=stopped``.

    One tick is a heartbeat request (which can run for tens of seconds), an event flush and an
    update check. If a stop gave up on the thread early, that tick's ``watching`` heartbeat
    could land after the ``stopped`` one and the server would end on ``watching``. A test can
    shorten the interval to a second, so the wait must not be derived from the interval alone.
    """

    @staticmethod
    def _loop_with_a_tick_in_progress(
        client: MagicMock, interval: int = 60
    ) -> tuple[HeartbeatLoop, MagicMock]:
        loop = HeartbeatLoop(
            client=client,
            watcher_id="w-test",
            interval_seconds=interval,
            event_reporter=MagicMock(spec=EventReporter),
            instrument_id="inst-1",
            watch_directory="/tmp/watch",
            upload_mode="auto",
        )
        thread = MagicMock(spec=threading.Thread)
        thread.is_alive.return_value = True
        loop._thread = thread
        return loop, thread

    @pytest.mark.parametrize(
        ("interval", "expected_wait"),
        [
            pytest.param(1, 65, id="short-override-keeps-the-production-wait"),
            pytest.param(60, 65, id="production-interval"),
            pytest.param(600, 605, id="longer-interval-waits-longer"),
        ],
    )
    def test_waits_for_a_tick_in_progress(self, interval: int, expected_wait: int) -> None:
        loop, thread = self._loop_with_a_tick_in_progress(MagicMock(), interval)

        loop.stop()

        thread.join.assert_called_once_with(timeout=expected_wait)

    def test_stop_loop_waits_as_long_as_it_is_told(self) -> None:
        loop, thread = self._loop_with_a_tick_in_progress(MagicMock())

        loop.stop_loop(join_timeout=12.5)

        thread.join.assert_called_once_with(timeout=12.5)
        assert loop._stop_event.is_set()

    def test_stop_loop_sends_nothing(self) -> None:
        client = MagicMock()
        loop, _thread = self._loop_with_a_tick_in_progress(client)

        loop.stop_loop(join_timeout=1)

        client.send_heartbeat.assert_not_called()

    def test_stop_loop_without_a_running_thread_does_not_wait(self) -> None:
        client = MagicMock()
        loop = _make_loop(client, MagicMock(spec=EventReporter))

        loop.stop_loop(join_timeout=1)

        assert loop._stop_event.is_set()

    def test_stop_loop_says_whether_the_thread_has_exited(self) -> None:
        loop, thread = self._loop_with_a_tick_in_progress(MagicMock())

        # A tick that outlasts the wait is left behind, which the move to the waiting state
        # needs to know before it closes the state database.
        assert loop.stop_loop(join_timeout=1) is False
        assert loop.has_exited() is False

        thread.is_alive.return_value = False
        assert loop.stop_loop(join_timeout=1) is True
        assert loop.has_exited() is True

    def test_a_loop_that_never_ran_has_exited(self) -> None:
        loop = _make_loop(MagicMock(), MagicMock(spec=EventReporter))

        assert loop.has_exited() is True
        assert loop.stop_loop(join_timeout=1) is True

    def test_stop_without_the_final_heartbeat_is_for_a_rebuild(self) -> None:
        # The config rebuild stops the loop and starts a new one: the watcher never stops.
        client = MagicMock()
        loop, thread = self._loop_with_a_tick_in_progress(client)

        loop.stop(send_stopped=False)

        thread.join.assert_called_once_with(timeout=65)
        client.send_heartbeat.assert_not_called()


class TestTickDuringAStop:
    """A tick whose heartbeat is still in flight when a stop gives up on it ends there.

    The stop sends the events and the final heartbeat itself. If the tick went on to flush,
    it could send `watcher_stopped` out of order with no deadline, or lose it when the process
    exits, and it would run the updater against a state database the stop may have closed, or
    start an update in the middle of a stop.
    """

    @staticmethod
    def _loop(client: MagicMock, reporter: MagicMock, on_tick: MagicMock) -> HeartbeatLoop:
        return HeartbeatLoop(
            client=client,
            watcher_id="w-test",
            interval_seconds=0.02,  # type: ignore[arg-type]
            event_reporter=reporter,
            instrument_id="inst-1",
            watch_directory="/tmp/watch",
            upload_mode="auto",
            on_tick=on_tick,
        )

    def test_a_tick_without_a_stop_flushes_and_runs_the_updater(self) -> None:
        reporter = MagicMock(spec=EventReporter)
        on_tick = MagicMock()
        loop = self._loop(MagicMock(), reporter, on_tick)

        loop._tick()

        reporter.flush.assert_called_once_with()
        on_tick.assert_called_once_with()

    def test_a_tick_that_a_stop_left_behind_sends_and_runs_nothing_after_its_heartbeat(
        self,
    ) -> None:
        client = MagicMock()
        reporter = MagicMock(spec=EventReporter)
        on_tick = MagicMock()
        in_flight = threading.Event()
        release = threading.Event()
        statuses: list[str] = []

        def send_heartbeat(_watcher_id: str, payload: dict[str, object], **_kw: object) -> None:
            statuses.append(str(payload["status"]))
            # The first is the startup beat. The second is the tick's, held in flight.
            if len(statuses) == 2:
                in_flight.set()
                assert release.wait(10)

        client.send_heartbeat.side_effect = send_heartbeat
        loop = self._loop(client, reporter, on_tick)
        loop.start()
        try:
            assert in_flight.wait(10), "the tick never sent its heartbeat"
            reporter.flush.reset_mock()  # The startup beat flushed too.

            # The stop gives up on the tick, which is still waiting for its answer.
            loop.stop_loop(join_timeout=0.05)
            assert loop._thread is not None and loop._thread.is_alive()
        finally:
            release.set()
        loop._thread.join(10)

        assert not loop._thread.is_alive()
        reporter.flush.assert_not_called()
        on_tick.assert_not_called()


class TestSendFinalHeartbeat:
    """A stop with a deadline can't wait for the client's 30 s read timeout.

    The final heartbeat has a short HTTP timeout that fits before the deadline. Without a
    deadline the client's own timeout applies.
    """

    def test_the_timeout_is_the_clients_usual_one_when_there_is_time(self) -> None:
        client = MagicMock()
        loop = _make_loop(client, MagicMock(spec=EventReporter))

        loop.send_final_heartbeat(deadline=time.monotonic() + 60)

        assert client.send_heartbeat.call_args.kwargs["timeout"] == DEFAULT_TIMEOUT
        assert client.send_heartbeat.call_args.args[1]["status"] == "stopped"

    def test_a_server_that_answers_in_six_seconds_is_waited_for(self) -> None:
        client = MagicMock()
        loop = _make_loop(client, MagicMock(spec=EventReporter))

        loop.send_final_heartbeat(deadline=time.monotonic() + 20)

        connect, read = client.send_heartbeat.call_args.kwargs["timeout"]
        assert read > 6
        assert connect + read <= 20

    def test_the_cap_can_be_the_shorter_one_for_a_windows_shutdown(self) -> None:
        client = MagicMock()
        loop = _make_loop(client, MagicMock(spec=EventReporter))

        loop.send_final_heartbeat(
            stop_reason="system_shutdown",
            deadline=time.monotonic() + 20,
            timeout_cap=SYSTEM_SHUTDOWN_HTTP_TIMEOUT,
        )

        assert client.send_heartbeat.call_args.kwargs["timeout"] == SYSTEM_SHUTDOWN_HTTP_TIMEOUT

    def test_the_timeout_shrinks_to_fit_what_is_left_of_the_deadline(self) -> None:
        client = MagicMock()
        loop = _make_loop(client, MagicMock(spec=EventReporter))

        loop.send_final_heartbeat(deadline=time.monotonic() + 1)

        connect, read = client.send_heartbeat.call_args.kwargs["timeout"]
        assert connect + read <= 1

    def test_the_final_heartbeat_is_still_sent_when_the_deadline_has_passed(self) -> None:
        # It is the one request that matters, so a deadline that has gone by only makes it
        # short, not skipped.
        client = MagicMock()
        loop = _make_loop(client, MagicMock(spec=EventReporter))

        loop.send_final_heartbeat(deadline=time.monotonic() - 5)

        client.send_heartbeat.assert_called_once()
        connect, read = client.send_heartbeat.call_args.kwargs["timeout"]
        assert 0 < connect + read <= 1

    def test_without_a_deadline_the_clients_timeout_applies(self) -> None:
        client = MagicMock()
        loop = _make_loop(client, MagicMock(spec=EventReporter))

        loop.send_final_heartbeat()

        assert client.send_heartbeat.call_args.kwargs["timeout"] is None


class TestFinalHeartbeatReason:
    """The final ``stopped`` heartbeat says when the watcher stops to come back.

    The server keeps the instrument's requested uploads queued for a ``stopped``
    heartbeat with ``status_reason: system_shutdown`` (Windows shutting down) or
    ``auto_update`` (an update being installed), and cancels them for any other
    ``stopped`` heartbeat. The values are the contract with the server, so the
    tests spell them out.
    """

    @staticmethod
    def _final_payload(stop_reason: str | None = None) -> dict[str, object]:
        client = MagicMock()
        loop = _make_loop(client, MagicMock(spec=EventReporter))

        loop.send_final_heartbeat(stop_reason=stop_reason)

        client.send_heartbeat.assert_called_once()
        return client.send_heartbeat.call_args.args[1]

    def test_a_stop_caused_by_a_system_shutdown_carries_the_reason(self) -> None:
        payload = self._final_payload("system_shutdown")

        assert payload["status"] == "stopped"
        assert payload["status_reason"] == "system_shutdown"

    def test_a_stop_for_an_update_carries_the_reason(self) -> None:
        payload = self._final_payload("auto_update")

        assert payload["status"] == "stopped"
        assert payload["status_reason"] == "auto_update"

    def test_any_other_stop_carries_no_reason(self) -> None:
        payload = self._final_payload()

        assert payload["status"] == "stopped"
        assert "status_reason" not in payload

    @pytest.mark.parametrize("reason", ["system_shutdown", "auto_update"])
    def test_stop_sends_the_reason_with_the_final_heartbeat(self, reason: str) -> None:
        client = MagicMock()
        loop = _make_loop(client, MagicMock(spec=EventReporter))

        loop.stop(stop_reason=reason)

        client.send_heartbeat.assert_called_once()
        payload = client.send_heartbeat.call_args.args[1]
        assert payload["status"] == "stopped"
        assert payload["status_reason"] == reason

    @pytest.mark.parametrize("reason", ["system_shutdown", "auto_update"])
    def test_a_heartbeat_that_is_not_the_final_one_never_carries_it(self, reason: str) -> None:
        client = MagicMock()
        loop = _make_loop(client, MagicMock(spec=EventReporter))

        loop._send_heartbeat(status="watching", stop_reason=reason)

        assert "status_reason" not in client.send_heartbeat.call_args.args[1]


def _deregistered() -> ApiError:
    """The server's reply to a heartbeat of a watcher whose registration was deleted."""
    return ApiError(
        "Watcher 'w-test' was deregistered",
        status_code=404,
        detail=ApiErrorDetail(
            code="WATCHER_DEREGISTERED", message="Watcher 'w-test' was deregistered"
        ),
    )


def _plain_not_found() -> ApiError:
    """The server's reply for a watcher ID it has no row for: not a deregistration."""
    return ApiError(
        "Watcher 'w-test' not found",
        status_code=404,
        detail=ApiErrorDetail(code="NOT_FOUND", message="Watcher 'w-test' not found"),
    )


def _html_404() -> ApiError:
    """A 404 page from a proxy or a deploy that is gone: no JSON error, so no `detail`."""
    return ApiError("<html>404 Not Found</html>", status_code=404)


def _other_error_code_404() -> ApiError:
    return ApiError(
        "no such route",
        status_code=404,
        detail=ApiErrorDetail(code="ROUTE_NOT_FOUND", message="no such route"),
    )


def _server_error() -> ApiError:
    # Even with the deregistered code in its body, a 503 says nothing about the registration.
    return ApiError(
        "boom",
        status_code=503,
        detail=ApiErrorDetail(code="WATCHER_DEREGISTERED", message="boom"),
    )


def _network_error() -> ApiError:
    return ApiError("Connection error: refused", status_code=0)


# A success, as `send_heartbeat` returns it.
_OK = object()


class TestDeregistered:
    """The watcher stops after `DEREGISTERED_HEARTBEAT_THRESHOLD` (3) deregistered replies in a row.

    One such reply could come from a broken deploy, so any other result, a success or any other
    error, starts the count again. A reply counts only when it is the server's "deregistered"
    reply: a 404 with the JSON error code `WATCHER_DEREGISTERED`. A plain `NOT_FOUND` is a
    watcher ID the server has no row for, which says nothing about the registration.
    """

    @staticmethod
    def _loop(
        replies: list[object], on_deregistered: MagicMock | None = None, **kwargs: object
    ) -> tuple[HeartbeatLoop, MagicMock, MagicMock]:
        client = MagicMock()
        # An exception in the list is raised and anything else is returned, as a success.
        client.send_heartbeat.side_effect = replies
        reporter = MagicMock(spec=EventReporter)
        on_deregistered = on_deregistered if on_deregistered is not None else MagicMock()
        loop = HeartbeatLoop(
            client=client,
            watcher_id="w-test",
            interval_seconds=60,
            event_reporter=reporter,
            instrument_id="inst-1",
            watch_directory="/tmp/watch",
            upload_mode="auto",
            on_deregistered=on_deregistered,
            **kwargs,  # type: ignore[arg-type]
        )
        return loop, on_deregistered, reporter

    def test_three_deregistered_replies_in_a_row_stop_the_watcher(self) -> None:
        loop, on_deregistered, _reporter = self._loop(
            [_deregistered(), _deregistered(), _deregistered()]
        )

        loop._send_heartbeat()
        loop._send_heartbeat()
        on_deregistered.assert_not_called()
        loop._send_heartbeat()

        on_deregistered.assert_called_once_with()

    def test_two_deregistered_replies_then_a_success_do_not_stop_it(self) -> None:
        loop, on_deregistered, _reporter = self._loop(
            [_deregistered(), _deregistered(), _OK, _deregistered(), _deregistered()]
        )

        for _ in range(5):
            loop._send_heartbeat()

        # The success started the count again: two after it are not three.
        on_deregistered.assert_not_called()
        assert not loop._stop_event.is_set()

    def test_the_count_after_a_success_starts_from_zero(self) -> None:
        loop, on_deregistered, _reporter = self._loop(
            [
                _deregistered(),
                _deregistered(),
                _OK,
                _deregistered(),
                _deregistered(),
                _deregistered(),
            ]
        )

        for _ in range(5):
            loop._send_heartbeat()
        on_deregistered.assert_not_called()
        loop._send_heartbeat()

        on_deregistered.assert_called_once_with()

    @pytest.mark.parametrize(
        "other",
        [_plain_not_found, _html_404, _other_error_code_404, _server_error, _network_error],
        ids=["plain-not-found", "html-404", "other-code-404", "5xx", "network"],
    )
    def test_another_failure_starts_the_count_again(self, other: object) -> None:
        loop, on_deregistered, _reporter = self._loop(
            [_deregistered(), _deregistered(), other(), _deregistered(), _deregistered()]  # type: ignore[operator]
        )

        for _ in range(5):
            loop._send_heartbeat()

        on_deregistered.assert_not_called()
        assert not loop._stop_event.is_set()

    @pytest.mark.parametrize(
        "other",
        [_plain_not_found, _html_404, _other_error_code_404, _server_error, _network_error],
        ids=["plain-not-found", "html-404", "other-code-404", "5xx", "network"],
    )
    def test_failures_that_are_not_the_deregistered_reply_never_stop_it(
        self, other: object
    ) -> None:
        loop, on_deregistered, _reporter = self._loop([other() for _ in range(10)])  # type: ignore[operator]

        for _ in range(10):
            loop._send_heartbeat()

        on_deregistered.assert_not_called()
        assert not loop._stop_event.is_set()

    def test_three_plain_not_found_replies_in_a_row_do_not_stop_the_watcher(self) -> None:
        # A watcher ID the server has no row for, such as after its database was restored to an
        # older point, is not a deregistration.
        loop, on_deregistered, _reporter = self._loop([_plain_not_found()] * 5)

        for _ in range(5):
            loop._send_heartbeat()

        on_deregistered.assert_not_called()
        assert not loop._stop_event.is_set()

    def test_a_plain_not_found_between_deregistered_replies_starts_the_count_again(self) -> None:
        loop, on_deregistered, _reporter = self._loop(
            [
                _deregistered(),
                _deregistered(),
                _plain_not_found(),
                _deregistered(),
                _deregistered(),
                _deregistered(),
            ]
        )

        for _ in range(5):
            loop._send_heartbeat()
        on_deregistered.assert_not_called()
        loop._send_heartbeat()

        # Three after the plain `NOT_FOUND`, not five in all.
        on_deregistered.assert_called_once_with()

    def test_the_loop_ends_itself_and_calls_the_callback_once(self) -> None:
        loop, on_deregistered, _reporter = self._loop([_deregistered()] * 5)

        for _ in range(5):
            loop._send_heartbeat()

        on_deregistered.assert_called_once_with()
        assert loop._stop_event.is_set()

    def test_a_callback_that_raises_does_not_break_the_heartbeat(self) -> None:
        on_deregistered = MagicMock(side_effect=RuntimeError("boom"))
        loop, _unused, _reporter = self._loop([_deregistered()] * 3, on_deregistered)

        for _ in range(3):
            loop._send_heartbeat()

        on_deregistered.assert_called_once_with()
        assert loop._stop_event.is_set()

    def test_without_a_callback_nothing_breaks(self) -> None:
        client = MagicMock()
        client.send_heartbeat.side_effect = _deregistered()
        loop = _make_loop(client, MagicMock(spec=EventReporter))

        for _ in range(4):
            loop._send_heartbeat()

        assert loop._stop_event.is_set()

    def test_a_waiting_watcher_counts_too(self) -> None:
        loop, on_deregistered, _reporter = self._loop(
            [_deregistered()] * 3, status="waiting", status_reason="watch_directory not found: X"
        )

        for _ in range(3):
            loop._send_heartbeat("waiting")

        on_deregistered.assert_called_once_with()

    def test_the_tick_that_sees_the_third_reply_flushes_no_events_and_runs_no_updater(
        self,
    ) -> None:
        on_tick = MagicMock()
        loop, on_deregistered, reporter = self._loop(
            [_deregistered(), _deregistered(), _deregistered()], on_tick=on_tick
        )

        loop._tick()
        loop._tick()
        # The first two ticks are ordinary ones: events are flushed, the updater runs.
        assert reporter.flush.call_count == 2
        assert on_tick.call_count == 2
        on_deregistered.assert_not_called()
        loop._tick()

        # The third would get the same 404 for its flush, and the updater must not start an
        # update for a watcher that can't report it.
        assert reporter.flush.call_count == 2
        assert on_tick.call_count == 2
        on_deregistered.assert_called_once_with()

    def test_a_startup_beat_that_is_the_third_reply_flushes_nothing_and_starts_no_thread(
        self,
    ) -> None:
        # The count is shared with the loops before this one, so a new loop's synchronous
        # startup beat can be the third reply in a row.
        shared = DeregisteredReplies()
        shared.add()
        shared.add()
        loop, on_deregistered, reporter = self._loop([_deregistered()], deregistered_replies=shared)

        loop.start()

        on_deregistered.assert_called_once_with()
        assert loop._stop_event.is_set()
        # The events would get the same 404, and nothing may run after the stop was asked for.
        reporter.flush.assert_not_called()
        assert loop._thread is None

    def test_a_startup_beat_that_is_not_the_third_reply_starts_the_loop_as_usual(self) -> None:
        shared = DeregisteredReplies()
        shared.add()
        loop, on_deregistered, reporter = self._loop([_deregistered()], deregistered_replies=shared)

        loop.start()
        try:
            on_deregistered.assert_not_called()
            reporter.flush.assert_called_once_with()
            assert loop._thread is not None and loop._thread.is_alive()
        finally:
            loop._stop_event.set()
            loop._thread.join(5)  # type: ignore[union-attr]

    def test_the_final_heartbeat_does_not_count_and_does_not_reset(self) -> None:
        loop, on_deregistered, _reporter = self._loop(
            [_deregistered(), _deregistered(), _deregistered(), _deregistered()]
        )

        loop._send_heartbeat()
        loop._send_heartbeat()
        # A final "stopped" heartbeat that gets the same 404 is not the third in a row.
        loop.send_final_heartbeat()
        on_deregistered.assert_not_called()
        loop._send_heartbeat()

        on_deregistered.assert_called_once_with()

    def test_loops_that_share_the_count_stop_on_the_third_reply_in_a_row_across_them(self) -> None:
        # A config rebuild or a switch between watching and waiting builds a new loop. The
        # supervisor gives each the same count, so the new loop's first reply is the third.
        shared = DeregisteredReplies()
        first, first_called, _ = self._loop(
            [_deregistered(), _deregistered()], deregistered_replies=shared
        )
        second, second_called, _ = self._loop([_deregistered()], deregistered_replies=shared)

        first._send_heartbeat()
        first._send_heartbeat()
        second._send_heartbeat()

        first_called.assert_not_called()
        second_called.assert_called_once_with()
        assert second._stop_event.is_set()
        assert shared.count == 3

    def test_a_watcher_that_builds_a_new_loop_for_every_heartbeat_still_stops(self) -> None:
        # No loop sees three replies, as when a network share drops out and comes back every
        # couple of minutes and each change builds a loop. The shared count still reaches 3.
        shared = DeregisteredReplies()
        called = MagicMock()

        for _ in range(2):
            loop, _unused, _ = self._loop([_deregistered()], called, deregistered_replies=shared)
            loop._send_heartbeat()
        called.assert_not_called()
        last, _unused, _ = self._loop([_deregistered()], called, deregistered_replies=shared)
        last._send_heartbeat()

        called.assert_called_once_with()

    def test_a_success_in_one_loop_starts_the_count_again_for_the_next(self) -> None:
        shared = DeregisteredReplies()
        first, _, _ = self._loop(
            [_deregistered(), _deregistered(), _OK], deregistered_replies=shared
        )
        second, second_called, _ = self._loop(
            [_deregistered(), _deregistered()], deregistered_replies=shared
        )

        for _ in range(3):
            first._send_heartbeat()
        second._send_heartbeat()
        second._send_heartbeat()

        second_called.assert_not_called()
        assert shared.count == 2

    def test_loops_without_a_shared_count_count_on_their_own(self) -> None:
        first, first_called, _ = self._loop([_deregistered(), _deregistered()])
        second, second_called, _ = self._loop([_deregistered()])

        first._send_heartbeat()
        first._send_heartbeat()
        second._send_heartbeat()

        first_called.assert_not_called()
        second_called.assert_not_called()

    def test_the_running_loop_stops_after_the_third_reply_and_sends_no_more(self) -> None:
        client = MagicMock()
        client.send_heartbeat.side_effect = _deregistered()
        reporter = MagicMock(spec=EventReporter)
        called = threading.Event()
        loop = HeartbeatLoop(
            client=client,
            watcher_id="w-test",
            interval_seconds=0.01,  # type: ignore[arg-type]
            event_reporter=reporter,
            instrument_id="inst-1",
            watch_directory="/tmp/watch",
            upload_mode="auto",
            on_deregistered=called.set,
        )

        loop.start()
        assert called.wait(10), "the loop never reported that the watcher was deregistered"
        assert loop._thread is not None
        loop._thread.join(10)
        sent = client.send_heartbeat.call_count

        assert not loop._thread.is_alive()
        # The startup beat and two ticks. A loop that went on would have sent more by now.
        assert sent == 3
        time.sleep(0.1)
        assert client.send_heartbeat.call_count == sent


class TestDeregisteredReplies:
    def test_it_counts_and_starts_again(self) -> None:
        replies = DeregisteredReplies()
        assert replies.count == 0

        assert replies.add() == 1
        assert replies.add() == 2
        assert replies.count == 2
        replies.reset()

        assert replies.count == 0
        assert replies.add() == 1

    def test_threads_that_add_at_once_lose_no_count(self) -> None:
        replies = DeregisteredReplies()
        threads_count, adds_each = 8, 500
        start = threading.Barrier(threads_count)

        def add_many() -> None:
            start.wait()
            for _ in range(adds_each):
                replies.add()

        threads = [threading.Thread(target=add_many) for _ in range(threads_count)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(10)

        assert replies.count == threads_count * adds_each


class TestHeartbeatCounts:
    """The counts a heartbeat reports are never lost and never reported twice.

    A heartbeat takes the counts it sends out of `WatcherCounters`, and gives them back if
    the request fails. So a failed heartbeat's counts go out with the next one, a count added
    while a request is in flight goes out with the one after it, and two heartbeats that
    overlap can't both report the same count.
    """

    @staticmethod
    def _loop(client: MagicMock, counters: WatcherCounters) -> HeartbeatLoop:
        return HeartbeatLoop(
            client=client,
            watcher_id="w-test",
            interval_seconds=60,
            event_reporter=MagicMock(spec=EventReporter),
            instrument_id="inst-1",
            watch_directory="/tmp/watch",
            upload_mode="auto",
            counters=counters,
        )

    @staticmethod
    def _counts(call: Any) -> tuple[int, int, int]:
        payload = call.args[1]
        return (
            payload["files_uploaded_since_last_heartbeat"],
            payload["runs_reported_since_last_heartbeat"],
            payload["errors_since_last_heartbeat"],
        )

    def test_the_counts_are_reported_once_and_the_next_heartbeat_starts_from_zero(self) -> None:
        client = MagicMock()
        counters = WatcherCounters()
        loop = self._loop(client, counters)
        counters.add_files_uploaded(2)
        counters.add_runs_reported()
        counters.add_errors(3)

        loop._send_heartbeat()
        loop._send_heartbeat()

        assert [self._counts(c) for c in client.send_heartbeat.call_args_list] == [
            (2, 1, 3),
            (0, 0, 0),
        ]

    def test_the_counts_of_a_heartbeat_that_failed_go_out_with_the_next_one(self) -> None:
        client = MagicMock()
        counters = WatcherCounters()
        loop = self._loop(client, counters)
        counters.add_files_uploaded(2)
        counters.add_runs_reported()
        counters.add_errors()
        client.send_heartbeat.side_effect = [
            ApiError("down", status_code=503),
            ApiError("offline", status_code=0),
            None,
            None,
        ]

        loop._send_heartbeat()
        counters.add_files_uploaded()  # More work while the server is unreachable.
        loop._send_heartbeat()
        loop._send_heartbeat()
        loop._send_heartbeat()

        counts = [self._counts(c) for c in client.send_heartbeat.call_args_list]
        # The first two were refused. The third is the first that got through, and it carries
        # everything that was counted since the first one. The fourth has nothing left.
        assert counts == [(2, 1, 1), (3, 1, 1), (3, 1, 1), (0, 0, 0)]

    @pytest.mark.parametrize(
        "failure",
        [
            ApiError("down", status_code=503),
            ApiError("refused", status_code=400),
            ApiError("slow", status_code=0, read_timed_out=True),
            ValueError("a reply that is not JSON"),
        ],
        ids=["503", "400", "read-timeout", "unreadable-reply"],
    )
    def test_whatever_makes_a_heartbeat_fail_gives_its_counts_back(
        self, failure: Exception
    ) -> None:
        client = MagicMock()
        counters = WatcherCounters()
        loop = self._loop(client, counters)
        counters.add_files_uploaded(4)
        client.send_heartbeat.side_effect = failure

        loop._send_heartbeat()

        assert (counters.files_uploaded, counters.runs_reported, counters.errors) == (4, 0, 0)

    def test_a_deregistered_reply_gives_its_counts_back_and_still_counts_toward_the_stop(
        self,
    ) -> None:
        client = MagicMock()
        counters = WatcherCounters()
        on_deregistered = MagicMock()
        loop = HeartbeatLoop(
            client=client,
            watcher_id="w-test",
            interval_seconds=60,
            event_reporter=MagicMock(spec=EventReporter),
            instrument_id="inst-1",
            watch_directory="/tmp/watch",
            upload_mode="auto",
            counters=counters,
            on_deregistered=on_deregistered,
            deregistered_replies=DeregisteredReplies(),
        )
        counters.add_files_uploaded(4)
        client.send_heartbeat.side_effect = _deregistered()

        for _ in range(DEREGISTERED_HEARTBEAT_THRESHOLD - 1):
            loop._send_heartbeat()
        on_deregistered.assert_not_called()
        # The final heartbeat that gets the same reply gives its counts back too, and is not
        # the third reply in a row.
        loop.send_final_heartbeat()
        on_deregistered.assert_not_called()
        loop._send_heartbeat()

        on_deregistered.assert_called_once_with()
        assert (counters.files_uploaded, counters.runs_reported, counters.errors) == (4, 0, 0)

    def test_a_count_added_while_a_heartbeat_is_in_flight_goes_out_with_the_next_one(self) -> None:
        client = MagicMock()
        counters = WatcherCounters()
        loop = self._loop(client, counters)
        counters.add_runs_reported()
        requests = 0

        def send_heartbeat(*_args: object, **_kwargs: object) -> None:
            nonlocal requests
            requests += 1
            if requests == 1:
                # The first payload was built before this. These are counted while the
                # request is in flight, and the old code reset them when it returned.
                counters.add_files_uploaded()
                counters.add_runs_reported()
                counters.add_errors()

        client.send_heartbeat.side_effect = send_heartbeat

        loop._send_heartbeat()
        loop._send_heartbeat()

        assert [self._counts(c) for c in client.send_heartbeat.call_args_list] == [
            (0, 1, 0),
            (1, 1, 1),
        ]

    def test_a_count_added_while_a_heartbeat_is_in_flight_survives_when_that_one_fails(
        self,
    ) -> None:
        client = MagicMock()
        counters = WatcherCounters()
        loop = self._loop(client, counters)
        counters.add_files_uploaded()

        def fails_after_a_count_arrives(*_args: object, **_kwargs: object) -> None:
            counters.add_files_uploaded()
            raise ApiError("down", status_code=503)

        client.send_heartbeat.side_effect = fails_after_a_count_arrives
        loop._send_heartbeat()

        assert counters.files_uploaded == 2

    def test_a_tick_that_a_stop_left_running_and_the_final_heartbeat_do_not_report_a_count_twice(
        self,
    ) -> None:
        client = MagicMock()
        counters = WatcherCounters()
        loop = self._loop(client, counters)
        counters.add_files_uploaded(5)
        in_flight = threading.Event()
        release = threading.Event()
        sent: list[tuple[str, int]] = []

        def send_heartbeat(_watcher_id: str, payload: dict[str, Any], **_kw: object) -> None:
            sent.append((payload["status"], payload["files_uploaded_since_last_heartbeat"]))
            if payload["status"] == "watching":
                in_flight.set()
                assert release.wait(10)

        client.send_heartbeat.side_effect = send_heartbeat
        tick = threading.Thread(target=loop._send_heartbeat)
        tick.start()
        try:
            assert in_flight.wait(10), "the tick never sent its heartbeat"
            # The stop gave up on the tick and sends the final heartbeat while it is running.
            loop.send_final_heartbeat()
        finally:
            release.set()
        tick.join(10)

        assert sorted(sent) == [("stopped", 0), ("watching", 5)]

    def test_the_final_heartbeat_reports_what_was_counted_since_the_last_one(self) -> None:
        client = MagicMock()
        counters = WatcherCounters()
        loop = self._loop(client, counters)
        counters.add_files_uploaded(2)

        loop.stop()

        assert self._counts(client.send_heartbeat.call_args) == (2, 0, 0)

    def test_counts_added_from_many_threads_while_heartbeats_fail_and_succeed_are_reported_once(
        self,
    ) -> None:
        client = MagicMock()
        counters = WatcherCounters()
        loop = self._loop(client, counters)
        delivered = [0, 0, 0]
        requests = itertools.count(1)

        def send_heartbeat(_watcher_id: str, payload: dict[str, Any], **_kw: object) -> None:
            # Every third request fails, so counts are given back and taken again.
            if next(requests) % 3 == 0:
                raise ApiError("down", status_code=503)
            delivered[0] += payload["files_uploaded_since_last_heartbeat"]
            delivered[1] += payload["runs_reported_since_last_heartbeat"]
            delivered[2] += payload["errors_since_last_heartbeat"]

        client.send_heartbeat.side_effect = send_heartbeat
        stop = threading.Event()

        def work() -> None:
            for _ in range(2000):
                counters.add_files_uploaded()
                counters.add_runs_reported()
                counters.add_errors()

        def beat() -> None:
            while not stop.is_set():
                loop._send_heartbeat()

        workers = [threading.Thread(target=work) for _ in range(8)]
        beater = threading.Thread(target=beat)
        beater.start()
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join()
        stop.set()
        beater.join()
        # What a request that failed last gave back goes out with one that gets through.
        for _ in range(3):
            loop._send_heartbeat()

        assert delivered == [16000, 16000, 16000]
        assert (counters.files_uploaded, counters.runs_reported, counters.errors) == (0, 0, 0)

    def test_the_last_fields_count_only_what_was_added_since_the_previous_heartbeat(self) -> None:
        # The updater reads `last_files_uploaded` after a tick to see whether the interval was
        # idle. Counts a failed heartbeat gave back and that are sent again are not activity
        # of the new interval.
        client = MagicMock()
        counters = WatcherCounters()
        loop = self._loop(client, counters)
        counters.add_files_uploaded(3)
        counters.add_errors()
        client.send_heartbeat.side_effect = [ApiError("down", status_code=503), None, None]

        loop._send_heartbeat()
        assert (counters.last_files_uploaded, counters.last_errors) == (3, 1)

        loop._send_heartbeat()  # Reports the 3 and the 1 that were given back.
        assert self._counts(client.send_heartbeat.call_args) == (3, 0, 1)
        assert (counters.last_files_uploaded, counters.last_errors) == (0, 0)

        counters.add_files_uploaded()
        loop._send_heartbeat()
        assert counters.last_files_uploaded == 1

    def test_counts_added_while_others_are_taken_are_never_lost_or_taken_twice(self) -> None:
        # Switch threads far more often than usual, so that a count added between the two
        # halves of an unlocked take would be lost within a few thousand tries.
        counters = WatcherCounters()
        taken = [0, 0, 0]
        stop = threading.Event()

        def work() -> None:
            for _ in range(20000):
                counters.add_files_uploaded()
                counters.add_runs_reported()
                counters.add_errors()

        def take_and_sometimes_give_back() -> None:
            n = 0
            while not stop.is_set():
                n += 1
                counts = counters.take()
                if n % 4 == 0:
                    counters.restore(counts)
                else:
                    taken[0] += counts.files_uploaded
                    taken[1] += counts.runs_reported
                    taken[2] += counts.errors

        previous = sys.getswitchinterval()
        sys.setswitchinterval(1e-6)
        try:
            workers = [threading.Thread(target=work) for _ in range(4)]
            taker = threading.Thread(target=take_and_sometimes_give_back)
            taker.start()
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join()
            stop.set()
            taker.join()
        finally:
            sys.setswitchinterval(previous)

        left = counters.take()
        assert taken[0] + left.files_uploaded == 80000
        assert taken[1] + left.runs_reported == 80000
        assert taken[2] + left.errors == 80000

    def test_taking_and_restoring_counts_is_the_only_way_a_heartbeat_changes_them(self) -> None:
        counters = WatcherCounters()
        counters.add_files_uploaded(2)
        counters.add_runs_reported(3)
        counters.add_errors(4)

        taken = counters.take()
        assert (taken.files_uploaded, taken.runs_reported, taken.errors) == (2, 3, 4)
        assert (counters.files_uploaded, counters.runs_reported, counters.errors) == (0, 0, 0)

        counters.add_files_uploaded()
        counters.restore(taken)
        assert (counters.files_uploaded, counters.runs_reported, counters.errors) == (3, 3, 4)
