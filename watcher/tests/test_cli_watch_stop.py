"""Tests for how `data-hub-watcher watch` stops its supervisor.

A stop for an in-process update is marked `auto_update` on the final heartbeat, which
`WatcherSupervisor.stop` decides itself. A stop the operator asked for, with Ctrl+C or
SIGTERM, is never marked, even with an update under way, so the command has to say so.
A stop that arrives during start-up is acted on once `start` returns, the same way, and the
supervisor's one stop signal, `request_stop`, also ends the start-up scan early.
"""

from __future__ import annotations
import signal
import threading
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest
from click.testing import CliRunner, Result

from data_hub_watcher import cli as cli_module
from data_hub_watcher.config_io import save_config
from data_hub_watcher.models import (
    ConfigChecksumResponse,
    HeartbeatResponse,
    InstrumentConfig,
    RunDetectionConfig,
    WatcherConfig,
)
from data_hub_watcher.runtime import ShutdownReason, WatcherSupervisor


class _FakeSupervisor:
    """Stands in for `WatcherSupervisor`: records how it is stopped and asked to stop."""

    upgrade_restart = False
    instances: list[_FakeSupervisor] = []
    # For the tests that send a signal during `start`: the handlers `watch` installed, and
    # the signal to send. Other tests never send one.
    signal_handlers: dict[int, Callable[[int, Any], None]] = {}
    signal_during_start: int | None = None

    def __init__(self, **kwargs: Any) -> None:
        self.cfg: WatcherConfig = kwargs["cfg"]
        self.waiting_reason: str | None = None
        self.stops: list[dict[str, Any]] = []
        self.stop_requested = threading.Event()
        self.request_stops = 0
        self.signal_handlers_installed: set[int] = set()
        _FakeSupervisor.instances.append(self)

    def start(self) -> None:
        self.signal_handlers_installed = set(_FakeSupervisor.signal_handlers)
        if _FakeSupervisor.signal_during_start is not None:
            signum = _FakeSupervisor.signal_during_start
            _FakeSupervisor.signal_handlers[signum](signum, None)

    def request_stop(self) -> None:
        self.request_stops += 1
        self.stop_requested.set()

    def classify_shutdown(self) -> ShutdownReason:
        return ShutdownReason(
            is_upgrade_restart=self.upgrade_restart,
            stopped_message="Watcher restarting for auto-update"
            if self.upgrade_restart
            else "Watcher stopped",
        )

    def stop(self, **kwargs: Any) -> None:
        self.stops.append(kwargs)


class _SignalDuringStart(WatcherSupervisor):
    """A real supervisor whose `start` first gets a signal, as one during start-up would."""

    def __init__(self, *, send_signal: Callable[[], None], **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._send_signal = send_signal

    def start(self) -> None:
        self._send_signal()
        super().start()


def _stub_watch_command(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, client: MagicMock) -> None:
    """Point `watch` at a config for an empty watch folder, and at *client* for the API."""
    watch_dir = tmp_path / "data"
    watch_dir.mkdir()
    cfg = WatcherConfig(
        version=1,
        environment="staging",
        api_base_urls={"staging": "https://staging.example.test/api/v1"},
        watcher_ids={"staging": "w-test"},
        instrument=InstrumentConfig(
            id="test-instrument",
            watch_directory=watch_dir,
            file_patterns=["*.csv"],
            run_detection=RunDetectionConfig(pattern=r"^([^_]+)", recursive=False),
        ),
    )
    config_path = tmp_path / "config.yaml"
    save_config(cfg, config_path)
    monkeypatch.setattr(cli_module, "resolve_config_path", lambda _override: config_path)
    monkeypatch.setattr(cli_module, "load_env", lambda *a, **k: None)
    monkeypatch.setattr(cli_module, "_make_client", lambda *a, **k: client)
    monkeypatch.setattr(cli_module, "state_db_dir", lambda _path, *, service: tmp_path)
    monkeypatch.setattr(cli_module, "_setup_file_logging", lambda: None)


def _record_signal_handlers(
    monkeypatch: pytest.MonkeyPatch,
) -> dict[int, Callable[[int, Any], None]]:
    """Have `signal.signal` keep each handler in the returned dict instead of installing it."""
    handlers: dict[int, Callable[[int, Any], None]] = {}

    def record(signum: int, handler: Callable[[int, Any], None]) -> None:
        handlers[signum] = handler

    monkeypatch.setattr(cli_module.signal, "signal", record)
    return handlers


@pytest.fixture
def api_client() -> MagicMock:
    """A mocked API client that answers the calls `watch` makes while it starts and stops."""
    client = MagicMock(name="DataHubClient")
    client.get_instrument.return_value = MagicMock(status="active")
    client.get_config_checksum.return_value = None
    client.push_config.return_value = ConfigChecksumResponse(config_checksum="sha256:x")
    client.get_latest_config_revision.return_value = None
    client.send_heartbeat.return_value = HeartbeatResponse(ok=True)
    return client


@pytest.fixture
def watch_until(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, api_client: MagicMock
) -> Callable[[str], Result]:
    """Run `watch` against stubs, until Ctrl+C (``"ctrl_c"``) or an update (``"update"``)."""
    _stub_watch_command(monkeypatch, tmp_path, api_client)
    _FakeSupervisor.instances = []
    # Keep the test process's own signal handlers.
    monkeypatch.setattr(cli_module.signal, "signal", lambda *_a, **_k: None)
    monkeypatch.setattr(cli_module, "WatcherSupervisor", _FakeSupervisor)

    def watch(until: str) -> Result:
        def run_supervisor(_supervisor: Any, stop_requested: threading.Event) -> None:
            # Ctrl+C sets the stop event. An update only asks the runtime to shut down.
            if until == "ctrl_c":
                stop_requested.set()

        monkeypatch.setattr(cli_module, "run_supervisor", run_supervisor)
        monkeypatch.setattr(_FakeSupervisor, "upgrade_restart", until == "update")
        return CliRunner().invoke(cli_module.cli, ["watch"])

    return watch


@pytest.fixture
def watch_with_signal_during_start(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, api_client: MagicMock
) -> Callable[[int], Result]:
    """Run `watch` against the fake supervisor, which gets the signal as its `start` begins."""
    _stub_watch_command(monkeypatch, tmp_path, api_client)
    _FakeSupervisor.instances = []
    monkeypatch.setattr(_FakeSupervisor, "signal_handlers", _record_signal_handlers(monkeypatch))
    monkeypatch.setattr(cli_module, "WatcherSupervisor", _FakeSupervisor)

    def watch(signum: int) -> Result:
        monkeypatch.setattr(_FakeSupervisor, "signal_during_start", signum)
        return CliRunner().invoke(cli_module.cli, ["watch"])

    return watch


@pytest.fixture
def real_watch(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, api_client: MagicMock
) -> Iterator[Callable[[int], Result]]:
    """Run `watch` with the real `WatcherSupervisor`, which gets the signal as `start` begins."""
    _stub_watch_command(monkeypatch, tmp_path, api_client)
    handlers = _record_signal_handlers(monkeypatch)
    supervisors: list[_SignalDuringStart] = []

    def watch(signum: int) -> Result:
        def make_supervisor(**kwargs: Any) -> _SignalDuringStart:
            # `config_dir` keeps the updater's files out of the real ~/.data-hub.
            sup = _SignalDuringStart(
                send_signal=lambda: handlers[signum](signum, None),
                config_dir=tmp_path,
                **kwargs,
            )
            supervisors.append(sup)
            return sup

        monkeypatch.setattr(cli_module, "WatcherSupervisor", make_supervisor)
        return CliRunner().invoke(cli_module.cli, ["watch"])

    try:
        yield watch
    finally:
        # A run that failed midway can leave its runtime, and the threads of it, running.
        for sup in supervisors:
            if sup.rt is not None or sup.waiting_reason is not None:
                sup.stop(stopped_message="test teardown")


class TestWatchStop:
    def test_ctrl_c_is_an_operator_stop_that_is_never_marked_as_an_update(
        self, watch_until: Callable[[str], Result]
    ) -> None:
        result = watch_until("ctrl_c")

        assert result.exit_code == 0, result.output
        (supervisor,) = _FakeSupervisor.instances
        assert supervisor.stops == [
            {"stopped_message": "Watcher stopped by user", "operator_stop": True}
        ]

    def test_an_in_process_update_is_stopped_for_the_supervisor_to_mark(
        self, watch_until: Callable[[str], Result]
    ) -> None:
        result = watch_until("update")

        # Non-zero, so whatever supervises the process starts it again on the new version.
        assert result.exit_code == 1, result.output
        (supervisor,) = _FakeSupervisor.instances
        assert supervisor.stops == [{"stopped_message": "Watcher restarting for auto-update"}]


class TestStopDuringStartUp:
    """A stop that arrives while `start` runs is recorded, and acted on once `start` returns."""

    @pytest.mark.parametrize("signum", [signal.SIGTERM, signal.SIGINT], ids=["sigterm", "sigint"])
    def test_the_stop_is_an_operator_stop_and_the_status_lines_are_skipped(
        self, watch_with_signal_during_start: Callable[[int], Result], signum: int
    ) -> None:
        result = watch_with_signal_during_start(signum)

        assert result.exit_code == 0, result.output
        (supervisor,) = _FakeSupervisor.instances
        assert supervisor.stops == [
            {"stopped_message": "Watcher stopped by user", "operator_stop": True}
        ]
        assert supervisor.request_stops == 1
        assert "Shutting down" in result.output
        # Those lines would say the watcher is running or waiting, so they are not printed.
        assert "Watcher is running" not in result.output
        assert "Press Ctrl+C" not in result.output

    @pytest.mark.parametrize("signum", [signal.SIGTERM, signal.SIGINT], ids=["sigterm", "sigint"])
    def test_the_real_supervisor_still_sends_the_final_stopped_heartbeat_and_event(
        self, real_watch: Callable[[int], Result], api_client: MagicMock, signum: int
    ) -> None:
        result = real_watch(signum)

        assert result.exit_code == 0, result.output
        statuses = [c.args[1]["status"] for c in api_client.send_heartbeat.call_args_list]
        assert statuses.index("watching") < statuses.index("stopped")
        final = api_client.send_heartbeat.call_args.args[1]
        assert final["status"] == "stopped"
        assert "status_reason" not in final
        stopped = [
            e
            for c in api_client.send_events.call_args_list
            for e in c.args[1]
            if e["event_type"] == "watcher_stopped"
        ]
        assert [e["message"] for e in stopped] == ["Watcher stopped by user"]

    def test_both_stop_handlers_are_installed_before_start(
        self, watch_with_signal_during_start: Callable[[int], Result]
    ) -> None:
        result = watch_with_signal_during_start(signal.SIGTERM)

        assert result.exit_code == 0, result.output
        (supervisor,) = _FakeSupervisor.instances
        assert supervisor.signal_handlers_installed == {signal.SIGINT, signal.SIGTERM}


class TestStopDuringTheStartUpScan:
    """Ctrl+C or SIGTERM while the start-up scan walks the watch folder ends the scan.

    The real supervisor and the real file monitor run, and the signal arrives from the scan
    itself, as it does from the terminal during a scan that takes minutes. The signal handler
    calls the supervisor's `request_stop`, which the monitor's scan reads between entries.
    """

    FILE_COUNT = 40

    @pytest.fixture
    def watch_with_signal_during_the_scan(
        self,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
        api_client: MagicMock,
        count_scan_entries: Callable[..., Any],
    ) -> Iterator[Callable[[int], tuple[Result, Any]]]:
        _stub_watch_command(monkeypatch, tmp_path, api_client)
        for i in range(self.FILE_COUNT):
            (tmp_path / "data" / f"RUN{i:03}_a.csv").write_text("a,b\n1,2\n")
        handlers = _record_signal_handlers(monkeypatch)
        supervisors: list[WatcherSupervisor] = []

        def make_supervisor(**kwargs: Any) -> WatcherSupervisor:
            # `config_dir` keeps the updater's files out of the real ~/.data-hub.
            sup = WatcherSupervisor(config_dir=tmp_path, **kwargs)
            supervisors.append(sup)
            return sup

        monkeypatch.setattr(cli_module, "WatcherSupervisor", make_supervisor)

        def watch(signum: int) -> tuple[Result, Any]:
            scan = count_scan_entries(after=lambda: handlers[signum](signum, None), n=3)
            return CliRunner().invoke(cli_module.cli, ["watch"]), scan

        try:
            yield watch
        finally:
            for sup in supervisors:
                if sup.rt is not None or sup.waiting_reason is not None:
                    sup.stop(stopped_message="test teardown")

    @pytest.mark.parametrize("signum", [signal.SIGTERM, signal.SIGINT], ids=["sigterm", "sigint"])
    def test_the_signal_ends_the_scan_and_the_watcher_stops_cleanly(
        self,
        watch_with_signal_during_the_scan: Callable[[int], tuple[Result, Any]],
        api_client: MagicMock,
        signum: int,
    ) -> None:
        result, scan = watch_with_signal_during_the_scan(signum)

        assert result.exit_code == 0, result.output
        # The scan read the entry that came with the signal and no more of the 40.
        assert scan.entries_read == 3
        # A normal clean stop follows: the final `stopped` heartbeat, and the stop event.
        final = api_client.send_heartbeat.call_args.args[1]
        assert final["status"] == "stopped"
        stopped = [
            e
            for c in api_client.send_events.call_args_list
            for e in c.args[1]
            if e["event_type"] == "watcher_stopped"
        ]
        assert [e["message"] for e in stopped] == ["Watcher stopped by user"]
        assert "Shutting down" in result.output
        assert "Watcher is running" not in result.output

    def test_the_files_the_scan_did_not_reach_are_left_for_the_next_start(
        self,
        watch_with_signal_during_the_scan: Callable[[int], tuple[Result, Any]],
        tmp_path: Path,
    ) -> None:
        from data_hub_watcher.constants import state_db_path
        from data_hub_watcher.state import StateDB

        result, _scan = watch_with_signal_during_the_scan(signal.SIGINT)

        assert result.exit_code == 0, result.output
        # `watch` here is the first start of a `new-only` environment, which records the
        # backlog as baseline in one go, at the end of its walk. A walk that ended early
        # has recorded none of it, so the next start walks the folder again.
        state = StateDB(state_db_path(tmp_path, "staging"))
        try:
            assert list(state.iter_baseline_stat_keys()) == []
            assert not state.baseline_established()
            assert state.pending_uploads() == []
        finally:
            state.close()
