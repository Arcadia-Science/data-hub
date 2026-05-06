"""Tests for the ``data-hub-watcher self-update`` CLI command.

The self-update command branches based on platform + install method:

* POSIX or Windows pip install: spawn ``uv``/``pip`` inline via
  ``run_upgrade`` and surface the captured output.
* Windows uv-tool install: route through the SYSTEM-owned scheduled
  task to break the ``Scripts\\python.exe`` lock that would otherwise
  cause the in-process reinstall to fail with ``Access is denied``.

These tests pin the dispatch contract so a regression in the routing
logic surfaces here rather than as an inscrutable error on a real
lab PC.
"""

from __future__ import annotations
import sys
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest
from click.testing import CliRunner

from data_hub_watcher import cli as cli_module
from data_hub_watcher.models import (
    InstrumentConfig,
    RunDetectionConfig,
    WatcherConfig,
    WatcherUpdateInfoResponse,
)
from data_hub_watcher.self_update import InstallMethod
from data_hub_watcher.upgrade_worker import (
    UPGRADE_REQUEST_FILENAME,
    read_upgrade_request,
)


def _make_config(tmp_path: Path) -> WatcherConfig:
    watch_dir = tmp_path / "data"
    watch_dir.mkdir()
    (watch_dir / "RUN001_sample.csv").write_text("a,b\n1,2\n")
    return WatcherConfig(
        version=1,
        environment="staging",
        watcher_id="w-test",
        instrument=InstrumentConfig(
            id="test-instrument",
            watch_directory=watch_dir,
            file_patterns=["*.csv"],
            run_detection=RunDetectionConfig(pattern=r"^([^_]+)", recursive=False),
        ),
    )


@pytest.fixture
def configured(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Patch the CLI's config + client so we exercise just the upgrade logic.

    Returns the per-test config dir we route ``DEFAULT_CONFIG_DIR`` at
    so individual tests can read back the request sentinel from disk.
    """
    config_path = tmp_path / "config.yaml"
    config_path.write_text("# placeholder, content is mocked away\n")
    cfg = _make_config(tmp_path)

    monkeypatch.setattr(cli_module, "resolve_config_path", lambda _override: config_path)
    monkeypatch.setattr(cli_module, "load_config", lambda _p: cfg)
    monkeypatch.setattr(cli_module, "env_file_path", lambda _env: tmp_path / ".env.staging")

    # Stub the API client so /update-check returns a known target.
    fake_client = MagicMock(name="DataHubClient")
    fake_client.get_update_info.return_value = WatcherUpdateInfoResponse(
        latest_version="9.9.9",
        channel="stable",
        mandatory=False,
    )
    monkeypatch.setattr(cli_module, "DataHubClient", lambda *_a, **_kw: fake_client)

    # Reroute the well-known config dir into the per-test tmp dir so
    # the sentinels the dispatch writes don't pollute the real
    # ``~/.data-hub`` of whoever runs the suite.
    config_dir = tmp_path / ".data-hub"
    config_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(cli_module, "DEFAULT_CONFIG_DIR", config_dir)

    return config_dir


class TestSelfUpdateWindowsUvToolWorkerDispatch:
    """On Windows uv-tool installs, ``self-update`` writes a sentinel + triggers schtasks."""

    def _force_windows_uv_tool(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(sys, "platform", "win32")
        monkeypatch.setattr(cli_module, "detect_install_method", lambda: InstallMethod.UV_TOOL)
        monkeypatch.setattr(
            cli_module,
            "_resolve_uv_executable",
            lambda override=None, prefix=None: ("/fake/bin/uv.exe", ["/fake/bin/uv.exe"]),
        )

    def test_writes_sentinel_and_triggers_task_on_happy_path(
        self,
        configured: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        self._force_windows_uv_tool(monkeypatch)
        # Pretend the [windows-service] extra is installed so the
        # rendered pkg_spec preserves it (closes the historical
        # regression where pywin32 silently disappeared after a
        # reinstall).
        import data_hub_watcher.upgrade_worker as worker_module

        monkeypatch.setattr(worker_module, "detect_installed_extras", lambda: ["windows-service"])
        # Pretend the scheduled task is registered.
        import data_hub_watcher.scheduled_task as st_module

        monkeypatch.setattr(st_module, "task_exists", lambda **_kw: True)
        trigger_calls: list[None] = []
        monkeypatch.setattr(
            st_module,
            "trigger_upgrade_task",
            lambda **_kw: trigger_calls.append(None),
        )

        runner = CliRunner()
        result = runner.invoke(cli_module.cli, ["self-update"])

        assert result.exit_code == 0, result.output
        assert "Dispatching upgrade" in result.output
        assert "9.9.9" in result.output
        assert "Upgrade dispatched" in result.output
        # Sentinel must be on disk with the right pkg_spec.
        req = read_upgrade_request(configured)
        assert req is not None
        assert req.target_version == "9.9.9"
        assert req.pkg_spec == "data-hub-watcher[windows-service]==9.9.9"
        assert req.uv_executable == "/fake/bin/uv.exe"
        assert trigger_calls == [None]

    def test_refuses_with_actionable_error_when_task_missing(
        self,
        configured: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        self._force_windows_uv_tool(monkeypatch)
        import data_hub_watcher.scheduled_task as st_module

        monkeypatch.setattr(st_module, "task_exists", lambda **_kw: False)
        # If the dispatch silently fell back to the in-process path,
        # we'd hit `run_upgrade` and try to actually reinstall — fail
        # loudly here so the test catches that regression.
        monkeypatch.setattr(
            cli_module,
            "run_upgrade",
            lambda *a, **kw: pytest.fail(
                "self-update must NOT call in-process run_upgrade on Windows uv-tool"
            ),
        )

        runner = CliRunner()
        result = runner.invoke(cli_module.cli, ["self-update"])

        assert result.exit_code != 0
        # Operator must see exactly which command to run next.
        assert "service reinstall" in result.output
        # No request sentinel should have been written when the
        # pre-flight check failed.
        assert not (configured / UPGRADE_REQUEST_FILENAME).exists()

    def test_refuses_when_uv_executable_cannot_be_located(
        self,
        configured: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(sys, "platform", "win32")
        monkeypatch.setattr(cli_module, "detect_install_method", lambda: InstallMethod.UV_TOOL)
        monkeypatch.setattr(
            cli_module,
            "_resolve_uv_executable",
            lambda override=None, prefix=None: (None, [r"C:\Users\lab\.local\bin\uv.exe"]),
        )

        runner = CliRunner()
        result = runner.invoke(cli_module.cli, ["self-update"])

        assert result.exit_code != 0
        assert "uv" in result.output.lower()
        assert r"C:\Users\lab\.local\bin\uv.exe" in result.output

    def test_schtasks_failure_rolls_back_sentinels(
        self,
        configured: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        from data_hub_watcher.scheduled_task import ScheduledTaskError

        self._force_windows_uv_tool(monkeypatch)
        import data_hub_watcher.scheduled_task as st_module

        monkeypatch.setattr(st_module, "task_exists", lambda **_kw: True)

        def boom(**_kw: Any) -> None:
            raise ScheduledTaskError(
                "schtasks /Run failed",
                argv=["schtasks.exe", "/Run", "/TN", "DataHubWatcherUpgrade"],
                stderr="ERROR: Access is denied.",
                returncode=1,
            )

        monkeypatch.setattr(st_module, "trigger_upgrade_task", boom)

        runner = CliRunner()
        result = runner.invoke(cli_module.cli, ["self-update"])

        assert result.exit_code != 0
        assert "scheduled task" in result.output.lower()
        # Sentinels must be cleaned up so a retry isn't gated on a
        # stale request file from the failed dispatch.
        assert not (configured / UPGRADE_REQUEST_FILENAME).exists()


class TestSelfUpdatePosixStillUsesInProcess:
    def test_posix_uv_tool_uses_run_upgrade_inline(
        self,
        configured: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # Mac/Linux uv-tool installs are not affected by the file-lock
        # issue, so the inline subprocess path stays in place. The
        # dispatch helper should never be reached.
        monkeypatch.setattr(sys, "platform", "linux")
        monkeypatch.setattr(cli_module, "detect_install_method", lambda: InstallMethod.UV_TOOL)

        import subprocess

        monkeypatch.setattr(
            cli_module,
            "run_upgrade",
            lambda method, target_version=None: subprocess.CompletedProcess(
                args=["uv"], returncode=0, stdout="ok\n", stderr=""
            ),
        )
        # If dispatch helper somehow fired, it would try to call
        # `_resolve_uv_executable`; replacing with a sentinel that
        # explodes makes a regression visible.
        import data_hub_watcher.scheduled_task as st_module

        monkeypatch.setattr(
            st_module,
            "trigger_upgrade_task",
            lambda **_kw: pytest.fail("POSIX uv-tool must not route through the worker"),
        )

        runner = CliRunner()
        result = runner.invoke(cli_module.cli, ["self-update"])

        assert result.exit_code == 0, result.output
        assert "Upgrade to 9.9.9 complete" in result.output
