"""Tests for how `data-hub-watcher watch` stops its supervisor.

A stop for an in-process update is marked `auto_update` on the final heartbeat, which
`WatcherSupervisor.stop` decides itself. A stop the operator asked for, with Ctrl+C or
SIGTERM, is never marked, even with an update under way, so the command has to say so.
A stop that arrives during start-up is acted on once `start` returns, the same way, and the
supervisor's one stop signal, `request_stop`, also ends the start-up scan early.

A watcher whose registration was deleted on Data Hub exits with a code of its own, and a new
one refuses to start, with the same code, and says to run `init`. Only the server's
"deregistered" reply counts: a plain `NOT_FOUND` lets the watcher start.
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
from data_hub_watcher.api_client import ApiError
from data_hub_watcher.config_io import save_config
from data_hub_watcher.constants import DEREGISTERED_EXIT_CODE, DEREGISTERED_MESSAGE
from data_hub_watcher.models import (
    ApiErrorDetail,
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
    deregistered = False
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
        if self.deregistered:
            return ShutdownReason(
                is_upgrade_restart=False,
                stopped_message="Watcher stopped: its registration was deleted on Data Hub",
                is_deregistered=True,
            )
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
    """Run `watch` against stubs.

    It runs until Ctrl+C (``"ctrl_c"``), an update (``"update"``) or the registration being
    deleted on Data Hub (``"deregistered"``).
    """
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
        monkeypatch.setattr(_FakeSupervisor, "deregistered", until == "deregistered")
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


def _deregistered() -> ApiError:
    return ApiError(
        "Watcher 'w-test' was deregistered",
        status_code=404,
        detail=ApiErrorDetail(
            code="WATCHER_DEREGISTERED", message="Watcher 'w-test' was deregistered"
        ),
    )


def _plain_not_found() -> ApiError:
    return ApiError(
        "Watcher 'w-test' not found",
        status_code=404,
        detail=ApiErrorDetail(code="NOT_FOUND", message="Watcher 'w-test' not found"),
    )


class TestWatchDeregistered:
    def test_the_exit_code_is_its_own(self) -> None:
        # Not 0 (a stop that was asked for) and not 1 (an update was installed, so start again),
        # so a wrapper script or a systemd unit (`RestartPreventExitStatus=3`) can tell that
        # starting the watcher again won't help.
        assert DEREGISTERED_EXIT_CODE not in (0, 1)
        assert DEREGISTERED_EXIT_CODE == 3

    def test_a_deregistered_watcher_exits_with_its_own_code(
        self, watch_until: Callable[[str], Result]
    ) -> None:
        result = watch_until("deregistered")

        assert result.exit_code == DEREGISTERED_EXIT_CODE, result.output
        (supervisor,) = _FakeSupervisor.instances
        # It is stopped, not as an operator's stop and not as an update. The supervisor
        # sends nothing for it.
        assert supervisor.stops == [
            {"stopped_message": "Watcher stopped: its registration was deleted on Data Hub"}
        ]
        # The update message is for a restart, and this is not one.
        assert "Upgrade installed" not in result.output

    def test_the_help_text_documents_the_exit_code(self) -> None:
        result = CliRunner().invoke(cli_module.cli, ["watch", "--help"])

        assert result.exit_code == 0
        help_text = " ".join(result.output.split())
        assert f"exits with code {DEREGISTERED_EXIT_CODE}" in help_text
        assert "data-hub-watcher init" in help_text


class TestWatchRefusesADeregisteredWatcher:
    def test_it_refuses_to_start_and_says_to_run_init(
        self, watch_until: Callable[[str], Result], api_client: MagicMock
    ) -> None:
        api_client.get_watcher.side_effect = _deregistered()

        result = watch_until("ctrl_c")

        # The code of a deregistered stop, and not the 1 of "an update was installed, start
        # again": a systemd unit with `RestartPreventExitStatus=3` would otherwise restart a
        # deregistered watcher in a loop after every reboot.
        assert result.exit_code == DEREGISTERED_EXIT_CODE, result.output
        assert DEREGISTERED_MESSAGE in " ".join(result.output.split())
        assert "data-hub-watcher init" in result.output
        # Nothing was built or synced.
        assert _FakeSupervisor.instances == []
        api_client.get_config_checksum.assert_not_called()
        api_client.push_config.assert_not_called()
        api_client.get_watcher.assert_called_once_with("w-test")

    def test_a_dry_run_refuses_too(
        self, watch_until: Callable[[str], Result], api_client: MagicMock
    ) -> None:
        api_client.get_watcher.side_effect = _deregistered()

        # The fixture has set up the stubs, and `watch_until` is not needed for the run.
        result = CliRunner().invoke(cli_module.cli, ["watch", "--dry-run"])

        assert result.exit_code == DEREGISTERED_EXIT_CODE, result.output
        assert DEREGISTERED_MESSAGE in " ".join(result.output.split())
        api_client.get_config_checksum.assert_not_called()

    def test_the_check_is_made_after_the_instrument_and_before_the_start(
        self, watch_until: Callable[[str], Result], api_client: MagicMock
    ) -> None:
        result = watch_until("ctrl_c")

        assert result.exit_code == 0, result.output
        names = [call[0] for call in api_client.method_calls]
        assert names.index("get_instrument") < names.index("get_watcher")
        assert len(_FakeSupervisor.instances) == 1

    def test_any_other_refused_start_still_exits_with_1(
        self, watch_until: Callable[[str], Result], api_client: MagicMock
    ) -> None:
        # The deregistered code is for a deregistered watcher only. A pending instrument is
        # refused the ordinary way.
        api_client.get_instrument.return_value = MagicMock(status="pending")

        result = watch_until("ctrl_c")

        assert result.exit_code == 1, result.output
        assert DEREGISTERED_MESSAGE not in " ".join(result.output.split())

    @pytest.mark.parametrize(
        "error",
        [
            _plain_not_found(),
            ApiError("<html>404 Not Found</html>", status_code=404),
            ApiError("bad gateway", status_code=502),
            ApiError("Connection error: refused", status_code=0),
            ValueError("a reply the client could not read"),
        ],
        ids=["plain-not-found", "html-404", "5xx", "network", "unreadable-reply"],
    )
    def test_any_other_failure_of_the_check_lets_the_watcher_start(
        self, watch_until: Callable[[str], Result], api_client: MagicMock, error: Exception
    ) -> None:
        api_client.get_watcher.side_effect = error

        result = watch_until("ctrl_c")

        assert result.exit_code == 0, result.output
        assert DEREGISTERED_MESSAGE not in " ".join(result.output.split())
        assert len(_FakeSupervisor.instances) == 1


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
