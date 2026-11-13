"""Unit tests for `data_hub_watcher.runtime.build_runtime` wiring invariants.

The CLI `watch` command and the Windows-service entrypoint both delegate
to `build_runtime` to assemble the long-lived object graph. A silent
regression previously broke manual-mode uploads because the service path
forgot to wire `on_tick` on the `HeartbeatLoop`. These tests lock in the
wiring contract per `upload_mode` so any future drift fails loudly:

* auto mode    -> `detector._upload_cb` is `uploader.upload_files`,
                  `heartbeat._on_tick` ticks the auto-updater only, and
                  `rt.upload_worker` polls the queue and retries pending
                  uploads at startup
* manual mode  -> `detector._upload_cb` is `None`, `heartbeat._on_tick`
                  ticks the auto-updater only (uploads now run on the
                  dedicated `UploadQueueWorker` thread, not the heartbeat),
                  and `rt.upload_worker` polls the queue only
"""

from __future__ import annotations
import json
import threading
import time
from pathlib import Path
from typing import Any, Literal
from unittest.mock import MagicMock

import pytest

from data_hub_watcher.api_client import DEFAULT_TIMEOUT, ApiError
from data_hub_watcher.constants import (
    DEFAULT_CHECK_INTERVAL_TICKS,
    DEFAULT_IDLE_TICKS_REQUIRED,
    HEARTBEAT_INTERVAL_SECONDS,
    STOP_BUDGET_SECONDS,
    STOP_FINAL_HEARTBEAT_SECONDS,
    STOP_MIN_WAIT_SECONDS,
    STOP_RESERVE_SECONDS,
    SYSTEM_SHUTDOWN_HTTP_TIMEOUT,
    SYSTEM_SHUTDOWN_JOIN_SECONDS,
    SYSTEM_SHUTDOWN_STOP_BUDGET_SECONDS,
    UPLOAD_POLL_INTERVAL_SECONDS,
)
from data_hub_watcher.events import EventType
from data_hub_watcher.heartbeat import HeartbeatLoop, WatcherCounters
from data_hub_watcher.models import InstrumentConfig, RunDetectionConfig, WatcherConfig
from data_hub_watcher.monitor import FileMonitor
from data_hub_watcher.run_detector import RunDetector
from data_hub_watcher.runtime import (
    ShutdownReason,
    WatcherRuntime,
    _summarize_worker_failure,
    build_runtime,
    classify_shutdown,
    start_runtime,
    stop_runtime,
)
from data_hub_watcher.state import StateDB
from data_hub_watcher.updater import Updater, write_upgrade_marker
from data_hub_watcher.upgrade_worker import (
    UpgradeResult,
    upgrade_result_path,
)
from data_hub_watcher.uploader import Uploader


def _make_config(
    tmp_path: Path,
    *,
    upload_mode: Literal["auto", "manual"],
    watcher_id: str | None = "w-test",
) -> WatcherConfig:
    """Build a minimal valid `WatcherConfig` rooted in *tmp_path*."""
    watch_dir = tmp_path / "data"
    watch_dir.mkdir()
    # Give the watch dir one matching file so `WatcherConfig` doesn't
    # emit the "no files match" warning during validation.
    (watch_dir / "RUN001_sample.csv").write_text("a,b\n1,2\n")
    instrument = InstrumentConfig(
        id="test-instrument",
        watch_directory=watch_dir,
        file_patterns=["*.csv"],
        upload_mode=upload_mode,
        run_detection=RunDetectionConfig(pattern=r"^([^_]+)", recursive=False),
    )
    return WatcherConfig(
        version=1,
        environment="staging",
        watcher_ids={"staging": watcher_id} if watcher_id else {},
        instrument=instrument,
    )


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "state.sqlite"


class TestBuildRuntimeAutoMode:
    """Auto mode: detector drives uploads, heartbeat does not poll."""

    def test_detector_upload_callback_is_uploader_upload_files(
        self, tmp_path: Path, db_path: Path
    ) -> None:
        cfg = _make_config(tmp_path, upload_mode="auto")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)

        try:
            # The detector must call Uploader.upload_files (bound method)
            # after reporting a run so auto-mode uploads actually fire.
            # Bound-method identity (`is`) fails because Python synthesizes
            # a fresh bound-method object on each attribute access, so
            # compare the underlying function and bound instance instead.
            cb = rt.detector._upload_cb
            assert cb is not None
            assert cb.__func__ is Uploader.upload_files  # type: ignore[union-attr]
            assert cb.__self__ is rt.uploader  # type: ignore[union-attr]
        finally:
            rt.state_db.close()

    def test_heartbeat_on_tick_only_drives_updater(self, tmp_path: Path, db_path: Path) -> None:
        cfg = _make_config(tmp_path, upload_mode="auto")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)

        try:
            # The upload worker polls the queue, but the in-process
            # updater still needs a tick on every heartbeat — it gates
            # auto-updates on the cumulative idle window across many
            # heartbeats. So the hook is non-None and ticking it must not
            # call `poll_upload_queue`.
            assert rt.heartbeat._on_tick is not None
            rt.uploader.poll_upload_queue = MagicMock()  # type: ignore[method-assign]
            rt.updater.on_tick = MagicMock(return_value=None)  # type: ignore[method-assign]
            rt.heartbeat._on_tick()
            rt.uploader.poll_upload_queue.assert_not_called()
            rt.updater.on_tick.assert_called_once_with()
        finally:
            rt.state_db.close()

    def test_auto_mode_builds_upload_worker_that_retries_pending(
        self, tmp_path: Path, db_path: Path
    ) -> None:
        cfg = _make_config(tmp_path, upload_mode="auto")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)

        try:
            # "Request upload" on the run page only reaches a watcher that
            # polls the queue, and auto mode needs the startup retry because
            # hydration treats every reported file as handled.
            assert rt.upload_worker is not None
            assert rt.upload_worker._uploader is rt.uploader
            assert rt.upload_worker._stop_event is rt.uploader._stop_event
            assert rt.upload_worker._retry_pending_on_start is True
        finally:
            rt.state_db.close()


class TestBuildRuntimeManualMode:
    """Manual mode: a dedicated worker polls the upload queue off the heartbeat."""

    def test_detector_upload_callback_is_none(self, tmp_path: Path, db_path: Path) -> None:
        cfg = _make_config(tmp_path, upload_mode="manual")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)

        try:
            # In manual mode the server decides what to upload, so the
            # detector must not eagerly hand files to the uploader.
            assert rt.detector._upload_cb is None
        finally:
            rt.state_db.close()

    def test_heartbeat_on_tick_does_not_poll_upload_queue(
        self, tmp_path: Path, db_path: Path
    ) -> None:
        cfg = _make_config(tmp_path, upload_mode="manual")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)

        try:
            # Uploads moved off the heartbeat thread onto the worker, so the
            # tick must only feed the updater — a slow upload can no longer
            # delay a heartbeat and make a busy watcher look offline.
            assert rt.heartbeat._on_tick is not None
            rt.uploader.poll_upload_queue = MagicMock()  # type: ignore[method-assign]
            rt.updater.on_tick = MagicMock(return_value=None)  # type: ignore[method-assign]
            rt.heartbeat._on_tick()
            rt.uploader.poll_upload_queue.assert_not_called()
            rt.updater.on_tick.assert_called_once_with()
        finally:
            rt.state_db.close()

    def test_manual_mode_builds_upload_worker_sharing_stop_event(
        self, tmp_path: Path, db_path: Path
    ) -> None:
        cfg = _make_config(tmp_path, upload_mode="manual")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)

        try:
            # The worker must wrap this runtime's uploader and share its stop
            # event so a shutdown can interrupt an in-flight upload.
            assert rt.upload_worker is not None
            assert rt.upload_worker._uploader is rt.uploader
            assert rt.upload_worker._stop_event is rt.uploader._stop_event
            # Manual mode only uploads what someone requested.
            assert rt.upload_worker._retry_pending_on_start is False
        finally:
            rt.state_db.close()

    def test_on_tick_swallows_updater_exceptions(self, tmp_path: Path, db_path: Path) -> None:
        """Same containment guarantee for the updater half of the hook:
        a buggy update check must not kill the heartbeat thread."""
        cfg = _make_config(tmp_path, upload_mode="auto")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)

        try:
            rt.updater.on_tick = MagicMock(  # type: ignore[method-assign]
                side_effect=RuntimeError("update broke")
            )
            assert rt.heartbeat._on_tick is not None
            rt.heartbeat._on_tick()
            rt.updater.on_tick.assert_called_once_with()
        finally:
            rt.state_db.close()


def _runtime_of_mocks(
    *,
    monitor_stopped: bool = True,
    worker_stopped: bool = True,
    monitor_joined: bool = True,
) -> tuple[WatcherRuntime, MagicMock]:
    """A runtime whose parts are all one mock, so a test can tell the order of the calls.

    `monitor.stop` says whether the stability checker had exited by the time it returned,
    and `monitor.join` whether it had by the end of the wait that follows.
    """
    parts = MagicMock()
    parts.monitor.stop.return_value = monitor_stopped
    parts.monitor.join.return_value = monitor_joined
    parts.upload_worker.stop.return_value = worker_stopped
    rt = WatcherRuntime(
        state_db=parts.state_db,
        counters=MagicMock(),
        reporter=parts.reporter,
        uploader=parts.uploader,
        detector=MagicMock(),
        monitor=parts.monitor,
        heartbeat=parts.heartbeat,
        updater=MagicMock(),
        config_dir=Path("/tmp"),
        upload_worker=parts.upload_worker,
    )
    return rt, parts


def _steps(parts: MagicMock) -> list[str]:
    return [name for name, _args, _kwargs in parts.method_calls]


class TestStopRuntimeOrder:
    """A normal stop runs its steps in one order: no new uploads, the monitor, the worker,
    the heartbeat loop, the `watcher_stopped` event, the final heartbeat."""

    def test_the_steps_run_in_order_with_the_event_before_the_final_heartbeat(self) -> None:
        rt, parts = _runtime_of_mocks()

        stop_runtime(rt, stopped_message="Service stopped")

        # The uploader is told to stop before anything waits for the monitor, and the
        # event is flushed before the final heartbeat is sent.
        assert _steps(parts) == [
            "uploader.request_stop",
            "monitor.stop",
            "upload_worker.stop",
            "heartbeat.stop_loop",
            "reporter.queue_event",
            "reporter.flush",
            "heartbeat.send_final_heartbeat",
            "state_db.close",
        ]
        event = parts.reporter.queue_event.call_args.args[0]
        assert event.event_type is EventType.WATCHER_STOPPED
        assert event.message == "Service stopped"

    def test_the_uploader_is_told_to_stop_before_the_monitor_is_waited_for(self) -> None:
        # An auto-mode upload runs on the monitor's own thread, and the worker's stop used to
        # be what told the uploader to stop, after the wait for the monitor. Until then the
        # upload went on starting parts and files.
        rt, parts = _runtime_of_mocks(monitor_stopped=False)

        stop_runtime(rt, stopped_message="Service stopped")

        steps = _steps(parts)
        assert steps.index("uploader.request_stop") < steps.index("monitor.stop")
        assert steps.index("uploader.request_stop") < steps.index("monitor.join")
        assert "uploader.abort" not in steps[: steps.index("monitor.join")]

    def test_the_uploader_is_not_aborted_while_uploads_finish_in_time(self) -> None:
        rt, parts = _runtime_of_mocks()

        stop_runtime(rt, stopped_message="Service stopped")

        parts.uploader.abort.assert_not_called()

    def test_uploads_and_a_heartbeat_in_progress_get_until_the_reserve(self) -> None:
        rt, parts = _runtime_of_mocks()
        waits = STOP_BUDGET_SECONDS - STOP_RESERVE_SECONDS

        stop_runtime(rt, stopped_message="Service stopped")

        # Each wait is bounded by the same moment, the deadline less the reserve for the
        # event and the final heartbeat.
        assert waits - 1 < parts.upload_worker.stop.call_args.kwargs["timeout"] <= waits
        assert waits - 1 < parts.heartbeat.stop_loop.call_args.kwargs["join_timeout"] <= waits

    def test_the_event_and_the_final_heartbeat_fit_before_the_deadline(self) -> None:
        rt, parts = _runtime_of_mocks()

        before = time.monotonic()
        stop_runtime(rt, stopped_message="Service stopped")
        after = time.monotonic()

        final = parts.heartbeat.send_final_heartbeat.call_args.kwargs
        assert before + STOP_BUDGET_SECONDS <= final["deadline"] <= after + STOP_BUDGET_SECONDS
        assert final["timeout_cap"] == DEFAULT_TIMEOUT
        assert final["stop_reason"] is None
        # The event is done in time to leave the final heartbeat its share.
        flush = parts.reporter.flush.call_args.kwargs
        assert flush["timeout_cap"] == DEFAULT_TIMEOUT
        assert final["deadline"] - flush["deadline"] == pytest.approx(
            STOP_FINAL_HEARTBEAT_SECONDS, abs=1
        )

    def test_the_event_and_the_final_heartbeat_can_wait_for_a_slow_server(self) -> None:
        # A server that takes 6 s to answer is slow, not hung. With the whole budget ahead
        # of them, the two requests wait longer than that, as they did with the client's own
        # timeout before 1.4.2, and neither is cut short at 5 s (the event would be sent
        # again after that and stored twice, and the heartbeat would count as failed while
        # the server stores it).
        from data_hub_watcher.events import EventReporter

        client = MagicMock()
        reporter = EventReporter(client, "w-test")
        loop = HeartbeatLoop(
            client=client,
            watcher_id="w-test",
            interval_seconds=60,
            event_reporter=reporter,
            instrument_id="inst-1",
            watch_directory="/tmp/watch",
            upload_mode="auto",
        )
        rt, _parts = _runtime_of_mocks()
        rt.heartbeat = loop
        rt.reporter = reporter

        stop_runtime(rt, stopped_message="Service stopped")

        client.send_events.assert_called_once()
        client.send_heartbeat.assert_called_once()
        events_connect, events_read = client.send_events.call_args.kwargs["timeout"]
        final_connect, final_read = client.send_heartbeat.call_args.kwargs["timeout"]
        assert events_read > 6
        assert final_read > 6
        # The events must be done before the final heartbeat's share of the budget begins,
        # and the heartbeat by the deadline.
        events_share = STOP_BUDGET_SECONDS - STOP_FINAL_HEARTBEAT_SECONDS
        assert events_connect + events_read <= events_share
        assert final_connect + final_read <= STOP_BUDGET_SECONDS
        # Neither is longer than the client's usual timeout.
        assert events_connect <= DEFAULT_TIMEOUT[0]
        assert events_read <= DEFAULT_TIMEOUT[1]
        assert final_connect <= DEFAULT_TIMEOUT[0]
        assert final_read <= DEFAULT_TIMEOUT[1]

    def test_the_heartbeat_loop_keeps_ticking_until_the_uploads_have_stopped(self) -> None:
        # A long upload mustn't leave a gap in the heartbeats: the server would show the
        # watcher as unresponsive, and an update check is skipped. The loop is stopped after
        # the worker, and sends its `stopped` heartbeat last.
        client = MagicMock()
        sent: list[str] = []
        client.send_heartbeat.side_effect = lambda _id, payload, **_kw: sent.append(
            payload["status"]
        )
        loop = HeartbeatLoop(
            client=client,
            watcher_id="w-test",
            interval_seconds=0.02,  # type: ignore[arg-type]
            event_reporter=MagicMock(),
            instrument_id="inst-1",
            watch_directory="/tmp/watch",
            upload_mode="auto",
        )
        rt, parts = _runtime_of_mocks()
        rt.heartbeat = loop
        loop.start()
        sent.clear()

        def stop_after_an_upload(timeout: float) -> bool:
            time.sleep(0.3)
            sent.append("worker stopped")
            return True

        parts.upload_worker.stop.side_effect = stop_after_an_upload

        stop_runtime(rt, stopped_message="Service stopped")

        assert sent.index("worker stopped") > 0, "no heartbeat was sent while the upload ran"
        assert set(sent[: sent.index("worker stopped")]) == {"watching"}
        assert sent[-1] == "stopped"

    def test_an_upload_still_running_at_the_deadline_is_cut_off(self) -> None:
        # The worker is still uploading when its wait ends, and exits once it is cut off.
        rt, parts = _runtime_of_mocks()
        parts.upload_worker.stop.side_effect = [False, True]

        stop_runtime(rt, stopped_message="Service stopped")

        assert _steps(parts)[:5] == [
            "uploader.request_stop",
            "monitor.stop",
            "upload_worker.stop",
            "uploader.abort",
            "upload_worker.stop",
        ]
        assert 0 <= parts.upload_worker.stop.call_args.kwargs["timeout"] <= STOP_MIN_WAIT_SECONDS
        # It did exit, so the state DB is closed, and the event and the heartbeat go out.
        parts.state_db.close.assert_called_once_with()
        parts.heartbeat.send_final_heartbeat.assert_called_once()

    def test_a_monitor_still_uploading_at_the_deadline_is_cut_off(self) -> None:
        rt, parts = _runtime_of_mocks(monitor_stopped=False)
        # It exits after the cut-off: the first wait for it, to the deadline, says no, and the
        # second says yes.
        parts.monitor.join.side_effect = [False, True]

        stop_runtime(rt, stopped_message="Service stopped")

        steps = _steps(parts)
        # One wait for it before the cut-off, one after, and both before the heartbeat loop.
        assert steps.count("monitor.join") == 2
        abort = steps.index("uploader.abort")
        assert steps.index("monitor.join") < abort < steps.index("monitor.join", abort)
        assert steps.index("monitor.join", abort) < steps.index("heartbeat.stop_loop")
        parts.state_db.close.assert_called_once_with()

    @pytest.mark.parametrize(
        ("monitor_exits", "worker_exits"),
        [(True, False), (False, True), (False, False)],
        ids=["worker-never-exits", "monitor-never-exits", "neither-exits"],
    )
    def test_a_thread_that_does_not_exit_even_when_cut_off_leaves_the_state_db_open(
        self, monitor_exits: bool, worker_exits: bool
    ) -> None:
        rt, parts = _runtime_of_mocks(
            monitor_stopped=monitor_exits, worker_stopped=worker_exits, monitor_joined=monitor_exits
        )

        stop_runtime(rt, stopped_message="Service stopped")

        # The process ends with the thread, so the DB is left open rather than closed under
        # an upload that is writing to it. The stop still reports.
        parts.state_db.close.assert_not_called()
        parts.reporter.flush.assert_called_once()
        parts.heartbeat.send_final_heartbeat.assert_called_once()

    def test_a_stop_without_an_upload_worker_still_stops_the_uploader_and_the_monitor(
        self,
    ) -> None:
        rt, parts = _runtime_of_mocks()
        rt.upload_worker = None

        stop_runtime(rt, stopped_message="Service stopped")

        assert _steps(parts)[:3] == ["uploader.request_stop", "monitor.stop", "heartbeat.stop_loop"]
        parts.state_db.close.assert_called_once_with()


class _HungServer:
    """A server that has stopped answering: a request waits out its timeout, then fails.

    A request with no timeout of its own (the periodic heartbeat's) waits until `release`
    is set, as one stuck on the client's 30 s read timeout would.
    """

    def __init__(self) -> None:
        self.release = threading.Event()
        # (kind, status or "") of each request, in the order they were made.
        self.calls: list[tuple[str, str]] = []

    def _hang(self, kind: str, status: str, timeout: tuple[float, float] | None) -> None:
        self.calls.append((kind, status))
        if timeout is None:
            self.release.wait(timeout=60)
        else:
            time.sleep(sum(timeout))
        raise ApiError("Request timed out", read_timed_out=True)

    def send_heartbeat(
        self, watcher_id: str, payload: dict[str, Any], timeout: tuple[float, float] | None = None
    ) -> None:
        self._hang("heartbeat", payload["status"], timeout)

    def send_events(
        self,
        watcher_id: str,
        events: list[dict[str, Any]],
        timeout: tuple[float, float] | None = None,
    ) -> None:
        self._hang("events", "", timeout)


class TestStopRuntimeAgainstAServerThatStopsAnswering:
    """With every request hung, a stop still ends within its budget, and the event is tried
    before the final heartbeat. The budget is made small so the test is short."""

    def test_the_stop_finishes_within_the_budget(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from data_hub_watcher import runtime as runtime_module
        from data_hub_watcher.events import EventReporter

        budget, reserve, final_share = 3.0, 1.5, 0.75
        monkeypatch.setattr(runtime_module, "STOP_BUDGET_SECONDS", budget)
        monkeypatch.setattr(runtime_module, "STOP_RESERVE_SECONDS", reserve)
        monkeypatch.setattr(runtime_module, "STOP_FINAL_HEARTBEAT_SECONDS", final_share)
        server = _HungServer()
        reporter = EventReporter(server, "w-test")  # type: ignore[arg-type]
        loop = HeartbeatLoop(
            client=server,  # type: ignore[arg-type]
            watcher_id="w-test",
            interval_seconds=0,
            event_reporter=reporter,
            instrument_id="inst-1",
            watch_directory="/tmp/watch",
            upload_mode="auto",
        )
        rt, parts = _runtime_of_mocks()
        rt.heartbeat = loop
        rt.reporter = reporter
        # A tick that is stuck on its heartbeat request when the stop begins.
        loop._thread = threading.Thread(target=loop._run, daemon=True)
        loop._thread.start()
        started_waiting = time.monotonic()
        while not server.calls and time.monotonic() - started_waiting < 5:
            time.sleep(0.01)
        assert server.calls, "the tick never sent its heartbeat"

        began = time.monotonic()
        try:
            stop_runtime(rt, stopped_message="Service stopped")
            took = time.monotonic() - began
        finally:
            server.release.set()

        # The stuck tick was waited for until the reserve, and then left behind.
        assert budget - reserve <= took < budget + 0.5
        sent = server.calls[1:]
        assert sent[0] == ("events", "")
        assert sent[-1] == ("heartbeat", "stopped")
        # The event request timed out after it was sent, so the server may have stored the
        # batch: it is not sent again.
        assert [call for call in sent if call[0] == "events"] == [("events", "")]
        parts.state_db.close.assert_called_once_with()


class TestStopRuntimeUploadWorkerOrdering:
    """`stop_runtime` must stop the upload worker before closing the state DB.

    Regression guard for the prod "Cannot operate on a closed database" race:
    a still-running upload wrote to the DB after `close()` because teardown
    didn't wait for the upload thread.
    """

    def test_closes_db_when_worker_stops_cleanly(self) -> None:
        rt, parts = _runtime_of_mocks()

        stop_runtime(rt, stopped_message="Watcher stopped")

        parts.upload_worker.stop.assert_called_once()
        parts.state_db.close.assert_called_once_with()

    def test_skips_close_when_worker_still_running(self) -> None:
        # A large PUT outliving the join must not have the DB yanked out from
        # under it; teardown leaves the connection open and lets the OS reap it.
        rt, parts = _runtime_of_mocks(worker_stopped=False)

        stop_runtime(rt, stopped_message="Watcher stopped")

        # Once to wait for it, and once more after the uploads are cut off.
        assert parts.upload_worker.stop.call_count == 2
        parts.state_db.close.assert_not_called()

    def test_closes_db_without_worker(self) -> None:
        rt, parts = _runtime_of_mocks()
        rt.upload_worker = None

        stop_runtime(rt, stopped_message="Watcher stopped")

        parts.state_db.close.assert_called_once_with()


class TestStopRuntimeForASystemShutdown:
    """A stop for Windows shutting down is limited to about 7 s, where any other stop has 25.

    Windows ends the service when its preshutdown timeout passes, 10 s on current builds, so
    a restart with an upload in flight must not outlast it. The tests record every call on
    the runtime's parts in one mock, so they can tell the order of the steps.
    """

    def test_a_shutdown_cuts_uploads_off_first_and_keeps_every_wait_short(self) -> None:
        rt, parts = _runtime_of_mocks()

        before = time.monotonic()
        stop_runtime(rt, stopped_message="Service stopped", system_shutdown=True)
        after = time.monotonic()

        # The uploads are told to stop before anything waits for them, and the event
        # reaches the server before the final heartbeat, as in any stop.
        assert _steps(parts) == [
            "uploader.abort",
            "monitor.stop",
            "upload_worker.stop",
            "heartbeat.stop_loop",
            "reporter.queue_event",
            "reporter.flush",
            "heartbeat.send_final_heartbeat",
            "state_db.close",
        ]
        parts.monitor.stop.assert_called_once_with(
            timeout=SYSTEM_SHUTDOWN_JOIN_SECONDS, observer_timeout=SYSTEM_SHUTDOWN_JOIN_SECONDS
        )
        parts.upload_worker.stop.assert_called_once_with(timeout=SYSTEM_SHUTDOWN_JOIN_SECONDS)
        parts.heartbeat.stop_loop.assert_called_once_with(join_timeout=SYSTEM_SHUTDOWN_JOIN_SECONDS)
        # The final heartbeat is marked, and it and the flush have the budget from when the
        # stop began, with short HTTP timeouts.
        final = parts.heartbeat.send_final_heartbeat.call_args.kwargs
        assert final["stop_reason"] == "system_shutdown"
        assert final["timeout_cap"] == SYSTEM_SHUTDOWN_HTTP_TIMEOUT
        deadline = final["deadline"]
        assert before + SYSTEM_SHUTDOWN_STOP_BUDGET_SECONDS <= deadline
        assert deadline <= after + SYSTEM_SHUTDOWN_STOP_BUDGET_SECONDS
        flush = parts.reporter.flush.call_args.kwargs
        assert flush["timeout_cap"] == SYSTEM_SHUTDOWN_HTTP_TIMEOUT
        # The final heartbeat has a share of what is left, and the event is done before it.
        assert before < flush["deadline"] < deadline

    @pytest.mark.parametrize(
        ("monitor_stopped", "worker_stopped", "closed"),
        [(True, True, True), (False, True, False), (True, False, False)],
        ids=["both-stopped", "monitor-still-running", "worker-still-running"],
    )
    def test_a_shutdown_leaves_the_state_db_open_while_an_upload_thread_runs(
        self, monitor_stopped: bool, worker_stopped: bool, closed: bool
    ) -> None:
        # With joins this short, a thread can still be running at the end. It is told to
        # stop and the process ends with it, so the state DB is left open rather than closed
        # under it. The final heartbeat is sent either way.
        rt, parts = _runtime_of_mocks(
            monitor_stopped=monitor_stopped, worker_stopped=worker_stopped
        )

        stop_runtime(rt, stopped_message="Service stopped", system_shutdown=True)

        assert parts.state_db.close.called is closed
        parts.heartbeat.send_final_heartbeat.assert_called_once()

    def test_a_shutdown_does_not_wait_again_for_a_thread_that_is_still_running(self) -> None:
        # The uploads were cut off before the joins, so a join that comes back empty ends the
        # wait: there is no second one, as in a stop with time to spare.
        rt, parts = _runtime_of_mocks(monitor_stopped=False, worker_stopped=False)

        stop_runtime(rt, stopped_message="Service stopped", system_shutdown=True)

        parts.monitor.join.assert_not_called()
        parts.upload_worker.stop.assert_called_once()
        parts.uploader.abort.assert_called_once_with()

    def test_the_final_heartbeat_is_marked_only_for_a_system_shutdown(self) -> None:
        shutdown_rt, shutdown_parts = _runtime_of_mocks()
        other_rt, other_parts = _runtime_of_mocks()

        stop_runtime(shutdown_rt, stopped_message="Service stopped", system_shutdown=True)
        stop_runtime(other_rt, stopped_message="Service stopped")

        shutdown_final = shutdown_parts.heartbeat.send_final_heartbeat.call_args.kwargs
        other_final = other_parts.heartbeat.send_final_heartbeat.call_args.kwargs
        assert shutdown_final["stop_reason"] == "system_shutdown"
        assert other_final["stop_reason"] is None

    def test_the_final_heartbeat_carries_the_reason_it_is_given(self) -> None:
        rt, parts = _runtime_of_mocks()

        before = time.monotonic()
        stop_runtime(rt, stopped_message="Service stopped", stop_reason="auto_update")
        after = time.monotonic()

        final = parts.heartbeat.send_final_heartbeat.call_args.kwargs
        assert final["stop_reason"] == "auto_update"
        # A stop for an update is not a shutdown: no abort, and the usual budget and
        # HTTP timeout, not the short ones.
        assert "uploader.abort" not in _steps(parts)
        assert before + STOP_BUDGET_SECONDS <= final["deadline"] <= after + STOP_BUDGET_SECONDS
        assert final["timeout_cap"] == DEFAULT_TIMEOUT

    def test_a_system_shutdown_wins_over_a_reason_it_is_given(self) -> None:
        rt, parts = _runtime_of_mocks()

        stop_runtime(
            rt, stopped_message="Service stopped", system_shutdown=True, stop_reason="auto_update"
        )

        final = parts.heartbeat.send_final_heartbeat.call_args.kwargs
        assert final["stop_reason"] == "system_shutdown"
        assert final["timeout_cap"] == SYSTEM_SHUTDOWN_HTTP_TIMEOUT

    def test_a_shutdown_without_an_upload_worker_is_still_limited(self) -> None:
        rt, parts = _runtime_of_mocks()
        rt.upload_worker = None

        stop_runtime(rt, stopped_message="Service stopped", system_shutdown=True)

        assert _steps(parts)[:2] == ["uploader.abort", "monitor.stop"]
        assert parts.heartbeat.send_final_heartbeat.call_args.kwargs["deadline"] is not None


class TestBuildRuntimeSharedDependencies:
    """Cross-object wiring invariants that apply to both upload modes."""

    @pytest.mark.parametrize("upload_mode", ["auto", "manual"])
    def test_runtime_fields_have_expected_types(
        self, tmp_path: Path, db_path: Path, upload_mode: Literal["auto", "manual"]
    ) -> None:
        cfg = _make_config(tmp_path, upload_mode=upload_mode)
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)

        try:
            assert isinstance(rt.state_db, StateDB)
            assert isinstance(rt.counters, WatcherCounters)
            assert isinstance(rt.uploader, Uploader)
            assert isinstance(rt.detector, RunDetector)
            assert isinstance(rt.monitor, FileMonitor)
            assert isinstance(rt.heartbeat, HeartbeatLoop)
            assert isinstance(rt.updater, Updater)
        finally:
            rt.state_db.close()

    @pytest.mark.parametrize("upload_mode", ["auto", "manual"])
    def test_counters_are_shared_across_components(
        self, tmp_path: Path, db_path: Path, upload_mode: Literal["auto", "manual"]
    ) -> None:
        """Uploader, detector, and heartbeat must share a single
        `WatcherCounters` so the heartbeat actually sees increments."""
        cfg = _make_config(tmp_path, upload_mode=upload_mode)
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)

        try:
            assert rt.uploader._counters is rt.counters
            assert rt.detector._counters is rt.counters
            assert rt.heartbeat.counters is rt.counters
        finally:
            rt.state_db.close()

    @pytest.mark.parametrize("upload_mode", ["auto", "manual"])
    def test_heartbeat_reflects_upload_mode(
        self, tmp_path: Path, db_path: Path, upload_mode: Literal["auto", "manual"]
    ) -> None:
        cfg = _make_config(tmp_path, upload_mode=upload_mode)
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)

        try:
            assert rt.heartbeat._upload_mode == upload_mode
            assert rt.heartbeat._interval == HEARTBEAT_INTERVAL_SECONDS
            assert rt.heartbeat._watcher_id == "w-test"
            assert rt.heartbeat._instrument_id == cfg.instrument.id
        finally:
            rt.state_db.close()


class TestBuildRuntimeTestOnlyOverrides:
    """`build_runtime` reads the test-only timer overrides when it is called.

    The end-to-end suite sets these so the real watcher ticks in seconds. They
    are read here, not at import, so the Windows service sees the values in its
    registered env file.
    """

    def test_unset_leaves_the_production_timers(self, tmp_path: Path, db_path: Path) -> None:
        cfg = _make_config(tmp_path, upload_mode="auto")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)

        try:
            assert rt.heartbeat._interval == HEARTBEAT_INTERVAL_SECONDS == 60
            assert rt.upload_worker is not None
            assert rt.upload_worker._interval == UPLOAD_POLL_INTERVAL_SECONDS == 60
            assert rt.updater._check_interval_ticks == DEFAULT_CHECK_INTERVAL_TICKS == 60
            assert rt.updater._idle_ticks_required == DEFAULT_IDLE_TICKS_REQUIRED == 5
        finally:
            rt.state_db.close()

    @pytest.mark.parametrize("upload_mode", ["auto", "manual"])
    def test_overrides_reach_the_heartbeat_upload_worker_and_updater(
        self,
        tmp_path: Path,
        db_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        upload_mode: Literal["auto", "manual"],
    ) -> None:
        # Set after this module (and `runtime`) was imported.
        monkeypatch.setenv("DATA_HUB_WATCHER_HEARTBEAT_INTERVAL_SECONDS", "7")
        monkeypatch.setenv("DATA_HUB_WATCHER_UPLOAD_POLL_INTERVAL_SECONDS", "11")
        monkeypatch.setenv("DATA_HUB_WATCHER_UPDATE_CHECK_INTERVAL_TICKS", "3")
        monkeypatch.setenv("DATA_HUB_WATCHER_UPDATE_IDLE_TICKS", "2")
        cfg = _make_config(tmp_path, upload_mode=upload_mode)
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)

        try:
            assert rt.heartbeat._interval == 7
            assert rt.upload_worker is not None
            assert rt.upload_worker._interval == 11
            assert rt.updater._check_interval_ticks == 3
            assert rt.updater._idle_ticks_required == 2
        finally:
            rt.state_db.close()

    def test_each_override_changes_only_its_own_timer(
        self, tmp_path: Path, db_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("DATA_HUB_WATCHER_UPLOAD_POLL_INTERVAL_SECONDS", "11")
        cfg = _make_config(tmp_path, upload_mode="auto")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)

        try:
            assert rt.upload_worker is not None
            assert rt.upload_worker._interval == 11
            assert rt.heartbeat._interval == HEARTBEAT_INTERVAL_SECONDS
            assert rt.updater._check_interval_ticks == DEFAULT_CHECK_INTERVAL_TICKS
            assert rt.updater._idle_ticks_required == DEFAULT_IDLE_TICKS_REQUIRED
        finally:
            rt.state_db.close()

    def test_bad_values_fall_back_to_the_defaults_instead_of_failing_the_build(
        self, tmp_path: Path, db_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("DATA_HUB_WATCHER_HEARTBEAT_INTERVAL_SECONDS", "0")
        monkeypatch.setenv("DATA_HUB_WATCHER_UPLOAD_POLL_INTERVAL_SECONDS", "soon")
        monkeypatch.setenv("DATA_HUB_WATCHER_UPDATE_CHECK_INTERVAL_TICKS", "-4")
        monkeypatch.setenv("DATA_HUB_WATCHER_UPDATE_IDLE_TICKS", "1.5")
        cfg = _make_config(tmp_path, upload_mode="auto")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)

        try:
            assert rt.heartbeat._interval == HEARTBEAT_INTERVAL_SECONDS
            assert rt.upload_worker is not None
            assert rt.upload_worker._interval == UPLOAD_POLL_INTERVAL_SECONDS
            assert rt.updater._check_interval_ticks == DEFAULT_CHECK_INTERVAL_TICKS
            assert rt.updater._idle_ticks_required == DEFAULT_IDLE_TICKS_REQUIRED
        finally:
            rt.state_db.close()

    def test_a_rebuild_picks_up_a_changed_value(
        self, tmp_path: Path, db_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Each build reads the environment again; nothing is cached.
        monkeypatch.setenv("DATA_HUB_WATCHER_HEARTBEAT_INTERVAL_SECONDS", "2")
        cfg = _make_config(tmp_path, upload_mode="auto")
        first = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)
        first.state_db.close()
        monkeypatch.setenv("DATA_HUB_WATCHER_HEARTBEAT_INTERVAL_SECONDS", "5")
        second = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)

        try:
            assert first.heartbeat._interval == 2
            assert second.heartbeat._interval == 5
        finally:
            second.state_db.close()


class TestBuildRuntimeErrors:
    def test_missing_watcher_id_raises(self, tmp_path: Path, db_path: Path) -> None:
        cfg = _make_config(tmp_path, upload_mode="auto", watcher_id=None)
        with pytest.raises(ValueError, match="watcher_id"):
            build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)


class TestBuildRuntimeBaselineSeeding:
    """Baseline seeding gating: only `new-only` envs with no history seed."""

    def _cfg(
        self,
        tmp_path: Path,
        *,
        environment: str,
        initial_scan: Literal["full", "new-only"] | None = None,
    ) -> WatcherConfig:
        watch_dir = tmp_path / "data"
        watch_dir.mkdir(exist_ok=True)
        (watch_dir / "RUN001_sample.csv").write_text("a,b\n1,2\n")
        return WatcherConfig(
            version=1,
            environment=environment,  # type: ignore[arg-type]
            api_base_urls={environment: "https://x.example/api/v1"}
            if environment == "preview"
            else {},
            watcher_ids={environment: "w-test"},
            initial_scan=initial_scan,
            instrument=InstrumentConfig(
                id="test-instrument",
                watch_directory=watch_dir,
                file_patterns=["*.csv"],
                run_detection=RunDetectionConfig(pattern=r"^([^_]+)", recursive=False),
            ),
        )

    def test_new_only_env_enables_baseline_seeding(self, tmp_path: Path, db_path: Path) -> None:
        # Seeding itself happens in the monitor's initial scan; `build_runtime`
        # only decides whether to arm it. The scan effect is covered by
        # `test_monitor_initial_scan.TestSeedBaselineScan`.
        cfg = self._cfg(tmp_path, environment="staging")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)
        try:
            assert rt.monitor._seed_baseline is True
        finally:
            rt.state_db.close()

    def test_production_does_not_seed_baseline(self, tmp_path: Path, db_path: Path) -> None:
        cfg = self._cfg(tmp_path, environment="production")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)
        try:
            assert rt.monitor._seed_baseline is False
        finally:
            rt.state_db.close()

    def test_does_not_reseed_when_history_exists(self, tmp_path: Path, db_path: Path) -> None:
        # An existing upload row means this environment already has real
        # state; reseeding would wrongly mark genuinely-new files as backlog.
        pre = StateDB(db_path)
        pre.record_upload(
            "old.csv", "sha", "s3/old.csv", relative_path="old.csv", size_bytes=1, mtime=1.0
        )
        pre.close()

        cfg = self._cfg(tmp_path, environment="staging")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)
        try:
            assert rt.monitor._seed_baseline is False
        finally:
            rt.state_db.close()

    def test_explicit_full_override_skips_seeding(self, tmp_path: Path, db_path: Path) -> None:
        cfg = self._cfg(tmp_path, environment="staging", initial_scan="full")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)
        try:
            assert rt.monitor._seed_baseline is False
        finally:
            rt.state_db.close()

    def test_seeded_history_disarms_seeding_on_next_build(
        self, tmp_path: Path, db_path: Path
    ) -> None:
        # First start seeds (and marks the sentinel) via the monitor scan; a
        # later `build_runtime` against the same DB must not re-arm seeding,
        # even for an empty dir where the sentinel is the only signal.
        cfg = self._cfg(tmp_path, environment="staging")
        (tmp_path / "data" / "RUN001_sample.csv").unlink()

        first = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)
        try:
            assert first.monitor._seed_baseline is True
            first.monitor._initial_scan()
            assert first.state_db.baseline_established() is True
        finally:
            first.state_db.close()

        second = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)
        try:
            assert second.monitor._seed_baseline is False
        finally:
            second.state_db.close()


class TestBuildRuntimeConfigDir:
    """Plumbing of the explicit ``config_dir`` parameter through the runtime.

    Regression guard for the auto-update silent no-op on Windows: the
    Windows service runs as LocalSystem (so ``Path("~/.data-hub")``
    inside the service process resolves to the SYSTEM profile, not
    the operator's profile) but the upgrade worker has its sentinel
    paths baked in at install time under the operator's profile.
    Letting the running service fall back to ``DEFAULT_CONFIG_DIR``
    rather than the registry-resolved directory caused the service to
    write the request sentinel into a directory the worker never
    reads from, so every auto-update tick fired ``update_started``
    and the worker logged "no request sentinel" without doing
    anything.
    """

    def test_explicit_config_dir_overrides_default(
        self, tmp_path: Path, db_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Patch DEFAULT_CONFIG_DIR to a *different* path so we can
        # tell apart "fell back to the default" from "honoured the
        # explicit argument".
        import data_hub_watcher.runtime as rt_module

        wrong_dir = tmp_path / "system-profile"
        right_dir = tmp_path / "operator-profile"
        wrong_dir.mkdir()
        right_dir.mkdir()
        monkeypatch.setattr(rt_module, "DEFAULT_CONFIG_DIR", wrong_dir)

        cfg = _make_config(tmp_path, upload_mode="auto")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path, config_dir=right_dir)
        try:
            assert rt.config_dir == right_dir
            # The Updater MUST receive the same dir we passed in;
            # this is what makes ``write_upgrade_request`` land in
            # the directory the SYSTEM-owned worker reads from.
            assert rt.updater._config_dir == right_dir
        finally:
            rt.state_db.close()

    def test_omitted_config_dir_falls_back_to_module_default(
        self, tmp_path: Path, db_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The CLI ``watch`` command relies on this fallback: it runs
        # as the operator user, so ``DEFAULT_CONFIG_DIR`` resolves
        # correctly and the CLI doesn't need to thread the argument
        # through. Pin the behaviour so a future refactor doesn't
        # silently make the argument required.
        import data_hub_watcher.runtime as rt_module

        fake_default = tmp_path / "operator-profile"
        fake_default.mkdir()
        monkeypatch.setattr(rt_module, "DEFAULT_CONFIG_DIR", fake_default)

        cfg = _make_config(tmp_path, upload_mode="auto")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)
        try:
            assert rt.config_dir == fake_default
            assert rt.updater._config_dir == fake_default
        finally:
            rt.state_db.close()


class TestClassifyShutdown:
    """Pin the WATCHER_STOPPED message text shared by the CLI ``watch``
    command and the Windows service. Both call sites used to hard-code
    their own strings, which made the service path's WATCHER_STOPPED
    indistinguishable from a normal stop on auto-update restarts —
    breaking dashboard correlation with the matching ``update_started``
    event.
    """

    def test_normal_stop_uses_role_stopped(self, tmp_path: Path, db_path: Path) -> None:
        cfg = _make_config(tmp_path, upload_mode="auto")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)
        try:
            decision = classify_shutdown(rt, role="Watcher")
            assert decision == ShutdownReason(
                is_upgrade_restart=False,
                stopped_message="Watcher stopped",
            )
        finally:
            rt.state_db.close()

    def test_upgrade_restart_uses_role_specific_message(
        self, tmp_path: Path, db_path: Path
    ) -> None:
        cfg = _make_config(tmp_path, upload_mode="auto")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)
        try:
            rt.upgrade_restart_event.set()
            decision = classify_shutdown(rt, role="Service")
            assert decision.is_upgrade_restart is True
            # The message is keyed on the *role* so the CLI and the
            # service produce naturally-readable but distinct text in
            # the events stream — a single "Watcher restarting…" log
            # would look weird on Windows where the dashboard already
            # shows the watcher's host as a service.
            assert decision.stopped_message == "Service restarting for auto-update"
        finally:
            rt.state_db.close()

    def test_role_is_substituted_into_both_messages(self, tmp_path: Path, db_path: Path) -> None:
        cfg = _make_config(tmp_path, upload_mode="auto")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)
        try:
            assert classify_shutdown(rt, role="Watcher").stopped_message == "Watcher stopped"
            rt.upgrade_restart_event.set()
            assert (
                classify_shutdown(rt, role="Watcher").stopped_message
                == "Watcher restarting for auto-update"
            )
        finally:
            rt.state_db.close()


class TestStartRuntimePostUpgradeMerge:
    """Post-restart event evaluation merges the worker's result sentinel.

    The Windows uv-tool worker writes ``.upgrade-result.json`` with the
    captured ``uv`` stdout/stderr/returncode. ``start_runtime`` reads
    both the marker AND the result, merging the worker fields into the
    emitted ``UPDATE_SUCCEEDED`` / ``UPDATE_FAILED`` event so the
    dashboard sees the same level of detail it used to get from the
    in-process subprocess.
    """

    def _make_runtime_with_reporter(self, tmp_path: Path) -> tuple[Any, MagicMock]:
        cfg = _make_config(tmp_path, upload_mode="auto")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=tmp_path / "state.sqlite")
        # Replace the real reporter with a mock so we can inspect
        # which events were queued without round-tripping the API
        # client.
        mock_reporter = MagicMock()
        rt.reporter = mock_reporter
        # Stop monitor + heartbeat from really starting since this
        # test only cares about the pre-startup event evaluation.
        rt.monitor = MagicMock()
        rt.heartbeat = MagicMock()
        rt.detector = MagicMock()
        return rt, mock_reporter

    def _patch_default_config_dir(self, monkeypatch: pytest.MonkeyPatch, target: Path) -> None:
        import data_hub_watcher.runtime as rt_module

        monkeypatch.setattr(rt_module, "DEFAULT_CONFIG_DIR", target)

    def test_success_merges_worker_result_into_event(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Pretend we just restarted into the upgraded version:
        # write the marker, drop a successful result sentinel,
        # invoke start_runtime, and assert the emitted event
        # carries the worker fields.
        config_dir = tmp_path / ".data-hub"
        config_dir.mkdir()
        self._patch_default_config_dir(monkeypatch, config_dir)
        # Pretend we're on Windows so the "result missing" branch
        # behaves correctly even though that branch is exercised in
        # a separate test.
        monkeypatch.setattr("data_hub_watcher.runtime.sys.platform", "win32")

        # Marker says "we asked for 9.9.9". The current version
        # comes from importlib.metadata; pin both ends to the same
        # value so evaluate_upgrade_marker classifies it as success.
        from data_hub_watcher.constants import WATCHER_VERSION

        write_upgrade_marker(
            config_dir,
            target_version=WATCHER_VERSION,
            previous_version="0.1.4",
        )
        # Worker drops the result sentinel after `uv` exits.
        result = UpgradeResult(
            request_id="abcd-1234",
            target_version=WATCHER_VERSION,
            succeeded=True,
            returncode=0,
            stdout_tail="installed 17 packages",
            stderr_tail="",
            finished_at="2026-05-04T22:30:00+00:00",
            error=None,
        )
        upgrade_result_path(config_dir).write_text(json.dumps(result.to_dict()), encoding="utf-8")

        rt, mock_reporter = self._make_runtime_with_reporter(tmp_path)
        try:
            start_runtime(rt, started_message="Watcher started on test")

            queued = [c.args[0] for c in mock_reporter.queue_event.call_args_list]
            update_events = [e for e in queued if e.event_type is EventType.UPDATE_SUCCEEDED]
            assert len(update_events) == 1
            details = update_events[0].details
            assert details["target_version"] == WATCHER_VERSION
            assert details["previous_version"] == "0.1.4"
            assert details["via_worker"] is True
            assert details["worker_returncode"] == 0
            assert details["worker_stdout_tail"] == "installed 17 packages"
            assert details["worker_request_id"] == "abcd-1234"
        finally:
            rt.state_db.close()

        # Sentinel must have been consumed so the next restart
        # doesn't re-emit it.
        assert not upgrade_result_path(config_dir).exists()

    def test_failure_with_worker_result_carries_returncode_and_stderr(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        config_dir = tmp_path / ".data-hub"
        config_dir.mkdir()
        self._patch_default_config_dir(monkeypatch, config_dir)

        # Marker says we tried to install 99.99.99 but the running
        # version is whatever WATCHER_VERSION resolves to — that
        # mismatch is what makes evaluate_upgrade_marker classify
        # this as a failure.
        write_upgrade_marker(
            config_dir,
            target_version="99.99.99",
            previous_version="0.1.4",
        )
        result = UpgradeResult(
            request_id="abcd",
            target_version="99.99.99",
            succeeded=False,
            returncode=2,
            stdout_tail="",
            stderr_tail="error: Access is denied. (os error 5)",
            finished_at="2026-05-04T22:30:00+00:00",
            error=None,
        )
        upgrade_result_path(config_dir).write_text(json.dumps(result.to_dict()), encoding="utf-8")

        rt, mock_reporter = self._make_runtime_with_reporter(tmp_path)
        try:
            start_runtime(rt, started_message="Watcher started on test")

            queued = [c.args[0] for c in mock_reporter.queue_event.call_args_list]
            failures = [e for e in queued if e.event_type is EventType.UPDATE_FAILED]
            assert len(failures) == 1
            details = failures[0].details
            assert details["target_version"] == "99.99.99"
            assert details["worker_returncode"] == 2
            assert "Access is denied" in details["worker_stderr_tail"]
            assert details["via_worker"] is True
            # `worker_result_missing` must NOT be set when we have
            # a real result sentinel — that flag is only for the
            # "worker crashed before writing" case.
            assert "worker_result_missing" not in details
        finally:
            rt.state_db.close()

    def test_worker_failure_overrides_apparent_marker_success(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The most important regression guard: a partial install where
        # uv exits non-zero AFTER updating enough Python source to
        # fool the marker version comparison must STILL surface as
        # UPDATE_FAILED with the actual installer error. Historically
        # this masqueraded as success because we trusted the marker
        # version comparison alone.
        from data_hub_watcher.constants import WATCHER_VERSION

        config_dir = tmp_path / ".data-hub"
        config_dir.mkdir()
        self._patch_default_config_dir(monkeypatch, config_dir)

        # Marker says success (version comparison would match).
        write_upgrade_marker(
            config_dir,
            target_version=WATCHER_VERSION,
            previous_version="0.1.4",
        )
        # But the worker reports failure with a real uv error message.
        result = UpgradeResult(
            request_id="abcd",
            target_version=WATCHER_VERSION,
            succeeded=False,
            returncode=2,
            stdout_tail="Installed 17 packages",
            stderr_tail=(
                "error: failed to remove directory `C:\\...\\Scripts`: "
                "Access is denied. (os error 5)"
            ),
            finished_at="2026-05-04T22:30:00+00:00",
            error=None,
        )
        upgrade_result_path(config_dir).write_text(json.dumps(result.to_dict()), encoding="utf-8")

        rt, mock_reporter = self._make_runtime_with_reporter(tmp_path)
        try:
            start_runtime(rt, started_message="Watcher started on test")

            queued = [c.args[0] for c in mock_reporter.queue_event.call_args_list]
            # Must emit UPDATE_FAILED, NOT UPDATE_SUCCEEDED, even
            # though the version comparison would have said success.
            failures = [e for e in queued if e.event_type is EventType.UPDATE_FAILED]
            successes = [e for e in queued if e.event_type is EventType.UPDATE_SUCCEEDED]
            assert len(failures) == 1
            assert len(successes) == 0
            details = failures[0].details
            # The reason should be derived from the worker's
            # stderr — the actual uv error, not the generic marker
            # classification.
            assert "Access is denied" in details["reason"] or "denied" in details["reason"].lower()
            assert details["worker_returncode"] == 2
            assert "Access is denied" in details["worker_stderr_tail"]
            # The marker's own classification is preserved so the
            # dashboard can show both signals when they disagree.
            assert details["marker_succeeded"] is True
            assert "marker_reason" in details
        finally:
            rt.state_db.close()

    def test_worker_warning_flag_set_when_success_with_dirty_stderr(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # uv occasionally prints deprecation/info warnings to stderr
        # even on a clean install. The worker reports success in that
        # case but we still want the dashboard to flag the event so
        # an operator can investigate the warning text.
        from data_hub_watcher.constants import WATCHER_VERSION

        config_dir = tmp_path / ".data-hub"
        config_dir.mkdir()
        self._patch_default_config_dir(monkeypatch, config_dir)

        write_upgrade_marker(
            config_dir,
            target_version=WATCHER_VERSION,
            previous_version="0.1.4",
        )
        result = UpgradeResult(
            request_id="abcd",
            target_version=WATCHER_VERSION,
            succeeded=True,
            returncode=3,  # non-zero but worker overrode succeeded=True
            stdout_tail="installed",
            stderr_tail="warning: deprecated index format",
            finished_at="2026-05-04T22:30:00+00:00",
            error=None,
        )
        upgrade_result_path(config_dir).write_text(json.dumps(result.to_dict()), encoding="utf-8")

        rt, mock_reporter = self._make_runtime_with_reporter(tmp_path)
        try:
            start_runtime(rt, started_message="Watcher started on test")
            queued = [c.args[0] for c in mock_reporter.queue_event.call_args_list]
            successes = [e for e in queued if e.event_type is EventType.UPDATE_SUCCEEDED]
            assert len(successes) == 1
            details = successes[0].details
            # Soft warning flag so the dashboard can surface "look
            # at this even though it succeeded".
            assert details.get("worker_warning") is True
            assert "deprecated" in details["worker_stderr_tail"]
        finally:
            rt.state_db.close()

    def test_failure_without_worker_result_flags_missing_on_windows(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Worker crashed between Stop-Service and writing the result
        # sentinel — the marker is on disk but no result. On Windows
        # this should set `worker_result_missing=True` so the
        # operator knows to look at the upgrade-worker log, not at
        # the in-process subprocess output (which doesn't exist).
        config_dir = tmp_path / ".data-hub"
        config_dir.mkdir()
        self._patch_default_config_dir(monkeypatch, config_dir)
        monkeypatch.setattr("data_hub_watcher.runtime.sys.platform", "win32")

        write_upgrade_marker(
            config_dir,
            target_version="99.99.99",
            previous_version="0.1.4",
        )
        # No result sentinel.

        rt, mock_reporter = self._make_runtime_with_reporter(tmp_path)
        try:
            start_runtime(rt, started_message="Watcher started on test")

            queued = [c.args[0] for c in mock_reporter.queue_event.call_args_list]
            failures = [e for e in queued if e.event_type is EventType.UPDATE_FAILED]
            assert len(failures) == 1
            details = failures[0].details
            assert details.get("worker_result_missing") is True
            # No worker fields since there's no sentinel to merge from.
            assert "worker_returncode" not in details
        finally:
            rt.state_db.close()

    def test_post_restart_inspection_uses_runtime_config_dir_not_default(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Regression guard for the Windows-service silent no-op:
        # under LocalSystem ``DEFAULT_CONFIG_DIR`` resolves to the
        # SYSTEM profile, but the upgrade marker / result / request
        # all live in the operator's profile (where the worker reads
        # from). ``start_runtime`` MUST consult ``rt.config_dir`` —
        # not the module-level ``DEFAULT_CONFIG_DIR`` — so a service
        # that's been threaded the right directory at construction
        # time picks up its own marker.
        from data_hub_watcher.constants import WATCHER_VERSION

        wrong_dir = tmp_path / "system-profile-data-hub"
        right_dir = tmp_path / "operator-profile-data-hub"
        wrong_dir.mkdir()
        right_dir.mkdir()

        # Marker + result land in the *right* (registry-resolved)
        # directory, mirroring what the running service writes when
        # it calls ``write_upgrade_marker(rt.config_dir, ...)``.
        write_upgrade_marker(
            right_dir,
            target_version=WATCHER_VERSION,
            previous_version="0.1.4",
        )
        result = UpgradeResult(
            request_id="rid",
            target_version=WATCHER_VERSION,
            succeeded=True,
            returncode=0,
            stdout_tail="installed 17 packages",
            stderr_tail="",
            finished_at="2026-05-06T11:54:22+00:00",
            error=None,
        )
        upgrade_result_path(right_dir).write_text(json.dumps(result.to_dict()), encoding="utf-8")

        # Patch ``DEFAULT_CONFIG_DIR`` to the *wrong* directory so
        # an accidental fallback would silently miss the marker
        # and emit no UPDATE_SUCCEEDED event at all.
        self._patch_default_config_dir(monkeypatch, wrong_dir)
        monkeypatch.setattr("data_hub_watcher.runtime.sys.platform", "win32")

        cfg = _make_config(tmp_path, upload_mode="auto")
        rt = build_runtime(
            client=MagicMock(),
            cfg=cfg,
            db_path=tmp_path / "state.sqlite",
            config_dir=right_dir,
        )
        mock_reporter = MagicMock()
        rt.reporter = mock_reporter
        rt.monitor = MagicMock()
        rt.heartbeat = MagicMock()
        rt.detector = MagicMock()
        try:
            start_runtime(rt, started_message="Service started on test")

            queued = [c.args[0] for c in mock_reporter.queue_event.call_args_list]
            successes = [e for e in queued if e.event_type is EventType.UPDATE_SUCCEEDED]
            assert len(successes) == 1, (
                "start_runtime fell back to DEFAULT_CONFIG_DIR — the marker in "
                "the registry-resolved config_dir was missed entirely."
            )
            details = successes[0].details
            assert details["worker_request_id"] == "rid"
            assert details["worker_stdout_tail"] == "installed 17 packages"
        finally:
            rt.state_db.close()

        # Sentinel must be consumed from the *right* directory; the
        # wrong directory is irrelevant and unchanged.
        assert not upgrade_result_path(right_dir).exists()


class TestSummarizeWorkerFailure:
    """Direct coverage for the dashboard-headline picker.

    The full stderr_tail is always preserved on the event details, so
    this helper only chooses the one-liner reason. The selection
    priority is:

    1. The first ``error: <msg>`` (uv's own convention).
    2. The first stderr line containing ``error`` / ``failed`` /
       ``denied`` (covers tools that don't follow uv's convention,
       e.g. PowerShell traps echoed to stderr by the worker).
    3. The worker's PowerShell-trap ``error`` field.
    4. ``uv exited <N>`` if all we have is a non-zero returncode.
    """

    def _result(
        self,
        *,
        stderr: str = "",
        returncode: int | None = 1,
        error: str | None = None,
    ) -> UpgradeResult:
        return UpgradeResult(
            request_id="rid",
            target_version="9.9.9",
            succeeded=False,
            returncode=returncode,
            stdout_tail="",
            stderr_tail=stderr,
            finished_at="2026-05-04T22:30:00+00:00",
            error=error,
        )

    def test_picks_uv_error_prefix_line(self) -> None:
        # uv's actual headline lives behind the ``error:`` prefix.
        # We must surface it verbatim (truncated to 200) rather than
        # the surrounding informational chatter.
        result = self._result(
            stderr=(
                "Resolved 17 packages in 12ms\n"
                "Prepared 17 packages in 800ms\n"
                "error: failed to remove directory `C:\\...\\Scripts`: "
                "Access is denied. (os error 5)\n"
                "Suggestion: stop the service and retry.\n"
            )
        )
        assert _summarize_worker_failure(result) == (
            "error: failed to remove directory `C:\\...\\Scripts`: Access is denied. (os error 5)"
        )

    def test_uv_error_prefix_takes_priority_over_substring_match(self) -> None:
        # Without the prefix-anchoring, the historical substring
        # heuristic would pick "Resolution failed for 17 packages"
        # because it appears first and contains "failed". The
        # ``error:`` line further down is the actual diagnostic and
        # must win.
        result = self._result(
            stderr=(
                "Resolution failed for 17 packages (this is informational)\n"
                "error: HTTP 503 from upstream index\n"
            )
        )
        assert _summarize_worker_failure(result) == "error: HTTP 503 from upstream index"

    def test_falls_back_to_substring_when_no_uv_error_prefix(self) -> None:
        # Worker captured a PowerShell trap or Windows API error that
        # didn't go through uv's `error:` formatter. The historical
        # heuristic still fires so we don't fall through to the
        # generic "uv exited N" message.
        result = self._result(
            stderr="Stop-Service : Access is denied (CategoryInfo: PermissionDenied)\n"
        )
        assert _summarize_worker_failure(result).startswith("Stop-Service")
        assert "Access is denied" in _summarize_worker_failure(result)

    def test_skips_innocuous_substring_match_when_better_line_follows(self) -> None:
        # An informational line that mentions "no errors so far" must
        # NOT be picked as the headline when a real ``error:`` line
        # is also present. This is the regression the prefix-anchor
        # exists to prevent.
        result = self._result(
            stderr=("Pre-flight: no errors so far\nerror: PyPI returned 503 Service Unavailable\n")
        )
        assert _summarize_worker_failure(result) == ("error: PyPI returned 503 Service Unavailable")

    def test_caps_long_lines_at_200_chars(self) -> None:
        long_msg = "x" * 500
        result = self._result(stderr=f"error: {long_msg}\n")
        summary = _summarize_worker_failure(result)
        # Cap is enforced so the dashboard one-liner doesn't blow
        # up; the full 500-char tail is still on the event details.
        assert len(summary) == 200
        assert summary.startswith("error: ")

    def test_uses_worker_exception_field_when_stderr_empty(self) -> None:
        # PowerShell trapped before uv could even start (e.g. ENOENT
        # on the binary). The worker stamps the exception text into
        # `error` and we surface that as the headline.
        result = self._result(stderr="", error="Cannot find path 'uv.exe'")
        assert _summarize_worker_failure(result) == ("worker exception: Cannot find path 'uv.exe'")

    def test_falls_back_to_returncode_when_no_other_signal(self) -> None:
        result = self._result(stderr="", returncode=137)
        assert _summarize_worker_failure(result) == "uv exited 137"

    def test_returns_generic_text_when_all_signals_empty(self) -> None:
        # No stderr, no error, returncode is 0 (worker reported
        # failure with succeeded=False but no useful diagnostics).
        # We still need *some* string for the dashboard message.
        result = self._result(stderr="", returncode=0, error=None)
        assert _summarize_worker_failure(result) == "worker reported failure"

    def test_non_upgrade_result_returns_generic_text(self) -> None:
        # Defensive: callers shouldn't pass non-UpgradeResult values,
        # but the helper must not raise when they do.
        assert _summarize_worker_failure(object()) == "worker reported failure"
