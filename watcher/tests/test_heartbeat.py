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
"""

from __future__ import annotations
import threading
import time
from unittest.mock import MagicMock

import pytest

from data_hub_watcher.api_client import DEFAULT_TIMEOUT, ApiError
from data_hub_watcher.constants import SYSTEM_SHUTDOWN_HTTP_TIMEOUT
from data_hub_watcher.events import EventReporter
from data_hub_watcher.heartbeat import HeartbeatLoop


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
