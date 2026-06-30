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
"""

from __future__ import annotations
import threading
import time
from unittest.mock import MagicMock

from data_hub_watcher.api_client import ApiError
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
