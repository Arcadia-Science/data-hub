"""Tests for how `data-hub-watcher watch` stops its supervisor.

A stop for an in-process update is marked `auto_update` on the final heartbeat, which
`WatcherSupervisor.stop` decides itself. A stop the operator asked for, with Ctrl+C or
SIGTERM, is never marked, even with an update under way, so the command has to say so.

A watcher whose registration was deleted on Data Hub exits with a code of its own, and a new
one refuses to start, with the same code, and says to run `init`. Only the server's
"deregistered" reply counts: a plain `NOT_FOUND` lets the watcher start.
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
from data_hub_watcher.api_client import ApiError
from data_hub_watcher.config_io import save_config
from data_hub_watcher.constants import DEREGISTERED_EXIT_CODE, DEREGISTERED_MESSAGE
from data_hub_watcher.models import (
    ApiErrorDetail,
    InstrumentConfig,
    RunDetectionConfig,
    WatcherConfig,
)
from data_hub_watcher.runtime import ShutdownReason


class _FakeSupervisor:
    """Stands in for `WatcherSupervisor`: records how it is stopped."""

    upgrade_restart = False
    deregistered = False
    instances: list[_FakeSupervisor] = []

    def __init__(self, **kwargs: Any) -> None:
        self.cfg: WatcherConfig = kwargs["cfg"]
        self.waiting_reason: str | None = None
        self.stops: list[dict[str, Any]] = []
        _FakeSupervisor.instances.append(self)

    def start(self) -> None:
        pass

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


@pytest.fixture
def client() -> MagicMock:
    """The Data Hub client `watch` is given: the instrument is active."""
    client = MagicMock()
    client.get_instrument.return_value = MagicMock(status="active")
    return client


@pytest.fixture
def watch_until(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, client: MagicMock
) -> Callable[[str], Result]:
    """Run `watch` against stubs.

    It runs until Ctrl+C (``"ctrl_c"``), an update (``"update"``) or the registration being
    deleted on Data Hub (``"deregistered"``).
    """
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
        monkeypatch.setattr(_FakeSupervisor, "deregistered", until == "deregistered")
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
        # Not 0 (a stop that was asked for) and not 1 (an update was installed, or a refused
        # start), so a wrapper script can tell that starting the watcher again won't help.
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
        self, watch_until: Callable[[str], Result], client: MagicMock
    ) -> None:
        client.get_watcher.side_effect = _deregistered()

        result = watch_until("ctrl_c")

        assert result.exit_code == 1, result.output
        assert DEREGISTERED_MESSAGE in " ".join(result.output.split())
        assert "data-hub-watcher init" in result.output
        # Nothing was built or synced.
        assert _FakeSupervisor.instances == []
        client.get_config_checksum.assert_not_called()
        client.push_config.assert_not_called()
        client.get_watcher.assert_called_once_with("w-test")

    def test_a_dry_run_refuses_too(
        self, watch_until: Callable[[str], Result], client: MagicMock
    ) -> None:
        client.get_watcher.side_effect = _deregistered()

        # The fixture has set up the stubs, and `watch_until` is not needed for the run.
        result = CliRunner().invoke(cli_module.cli, ["watch", "--dry-run"])

        assert result.exit_code == 1, result.output
        assert DEREGISTERED_MESSAGE in " ".join(result.output.split())
        client.get_config_checksum.assert_not_called()

    def test_the_check_is_made_after_the_instrument_and_before_the_start(
        self, watch_until: Callable[[str], Result], client: MagicMock
    ) -> None:
        result = watch_until("ctrl_c")

        assert result.exit_code == 0, result.output
        names = [call[0] for call in client.method_calls]
        assert names.index("get_instrument") < names.index("get_watcher")
        assert len(_FakeSupervisor.instances) == 1

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
        self, watch_until: Callable[[str], Result], client: MagicMock, error: Exception
    ) -> None:
        client.get_watcher.side_effect = error

        result = watch_until("ctrl_c")

        assert result.exit_code == 0, result.output
        assert DEREGISTERED_MESSAGE not in " ".join(result.output.split())
        assert len(_FakeSupervisor.instances) == 1
