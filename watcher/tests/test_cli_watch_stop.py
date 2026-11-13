"""Tests for how `data-hub-watcher watch` stops its supervisor.

A stop for an in-process update is marked `auto_update` on the final heartbeat, which
`WatcherSupervisor.stop` decides itself. A stop the operator asked for, with Ctrl+C or
SIGTERM, is never marked, even with an update under way, so the command has to say so.
"""

from __future__ import annotations
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest
from click.testing import CliRunner, Result

from data_hub_watcher import cli as cli_module
from data_hub_watcher.config_io import save_config
from data_hub_watcher.models import InstrumentConfig, RunDetectionConfig, WatcherConfig
from data_hub_watcher.runtime import ShutdownReason


class _FakeSupervisor:
    """Stands in for `WatcherSupervisor`: records how it is stopped."""

    upgrade_restart = False
    instances: list[_FakeSupervisor] = []

    def __init__(self, **kwargs: Any) -> None:
        self.cfg: WatcherConfig = kwargs["cfg"]
        self.waiting_reason: str | None = None
        self.stops: list[dict[str, Any]] = []
        _FakeSupervisor.instances.append(self)

    def start(self) -> None:
        pass

    def classify_shutdown(self) -> ShutdownReason:
        return ShutdownReason(
            is_upgrade_restart=self.upgrade_restart,
            stopped_message="Watcher restarting for auto-update"
            if self.upgrade_restart
            else "Watcher stopped",
        )

    def stop(self, **kwargs: Any) -> None:
        self.stops.append(kwargs)


@pytest.fixture
def watch_until(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Callable[[str], Result]:
    """Run `watch` against stubs, until Ctrl+C (``"ctrl_c"``) or an update (``"update"``)."""
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
    client = MagicMock()
    client.get_instrument.return_value = MagicMock(status="active")

    _FakeSupervisor.instances = []
    monkeypatch.setattr(cli_module, "resolve_config_path", lambda _override: config_path)
    monkeypatch.setattr(cli_module, "load_env", lambda *a, **k: None)
    monkeypatch.setattr(cli_module, "_make_client", lambda *a, **k: client)
    monkeypatch.setattr(cli_module, "state_db_dir", lambda _path, *, service: tmp_path)
    monkeypatch.setattr(cli_module, "_setup_file_logging", lambda: None)
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
