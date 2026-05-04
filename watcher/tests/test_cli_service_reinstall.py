"""Unit tests for the ``data-hub-watcher service reinstall`` CLI command.

The command is the operator-facing wrapper around stop → uninstall →
install → start that we need after a manual wheel swap from an
Administrator shell.  These tests verify two contracts that have
historically caused real outages on lab PCs:

* The four SCM helpers must be invoked **in order** so we never end up
  installing a service while the previous one is still half-running.
* Stop and uninstall must be best-effort.  A clean machine (where the
  service isn't installed yet) must still progress to ``install_service``
  and ``start_service`` instead of bailing out at the first error.
"""

from __future__ import annotations
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from click.testing import CliRunner

from data_hub_watcher import cli as cli_module
from data_hub_watcher.models import InstrumentConfig, RunDetectionConfig, WatcherConfig


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
def fake_service_module(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    """Inject a fake ``data_hub_watcher.service`` module into ``sys.modules``.

    The CLI command imports its helpers lazily inside the function body so
    we can swap the whole module out without touching the real service
    code (which pulls in win32 imports).
    """
    fake = MagicMock(name="data_hub_watcher.service")
    monkeypatch.setitem(sys.modules, "data_hub_watcher.service", fake)
    return fake


@pytest.fixture
def windows_platform(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pretend we're on Windows so ``_windows_only()`` doesn't bail out."""
    monkeypatch.setattr(sys, "platform", "win32")


@pytest.fixture
def configured_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Write a placeholder config and route the CLI to it.

    The CLI's ``load_config`` is patched to return an in-memory config so
    we don't need to round-trip through real YAML parsing here — what we
    care about is the SCM call sequencing, not config IO.
    """
    config_path = tmp_path / "config.yaml"
    config_path.write_text("# placeholder, content is mocked away\n")
    cfg = _make_config(tmp_path)

    monkeypatch.setattr(cli_module, "resolve_config_path", lambda _override: config_path)
    monkeypatch.setattr(cli_module, "load_config", lambda _p: cfg)
    monkeypatch.setattr(cli_module, "env_file_path", lambda _env: tmp_path / ".env.staging")
    return config_path


class TestServiceReinstallHappyPath:
    def test_calls_stop_uninstall_install_start_in_order(
        self,
        windows_platform: None,
        fake_service_module: MagicMock,
        configured_path: Path,
        tmp_path: Path,
    ) -> None:
        env_path = tmp_path / ".env.staging"
        env_path.write_text("")

        manager = MagicMock()
        manager.attach_mock(fake_service_module.stop_service, "stop_service")
        manager.attach_mock(fake_service_module.uninstall_service, "uninstall_service")
        manager.attach_mock(fake_service_module.install_service, "install_service")
        manager.attach_mock(fake_service_module.start_service, "start_service")

        runner = CliRunner()
        result = runner.invoke(cli_module.cli, ["service", "reinstall"])

        assert result.exit_code == 0, result.output
        call_names = [c[0] for c in manager.mock_calls]
        assert call_names == [
            "stop_service",
            "uninstall_service",
            "install_service",
            "start_service",
        ]
        # install_service must receive resolved paths so the SCM-launched
        # process can find the config and env file regardless of cwd.
        kwargs = fake_service_module.install_service.call_args.kwargs
        assert kwargs["config_path"] == configured_path.resolve()
        assert kwargs["env_path"] == env_path.resolve()

    def test_stop_failure_is_swallowed_and_install_still_runs(
        self,
        windows_platform: None,
        fake_service_module: MagicMock,
        configured_path: Path,
        tmp_path: Path,
    ) -> None:
        # Simulates a clean machine: the service isn't installed, so
        # ``stop_service`` raises. The reinstall must continue.
        (tmp_path / ".env.staging").write_text("")
        fake_service_module.stop_service.side_effect = RuntimeError("service does not exist")
        fake_service_module.uninstall_service.side_effect = RuntimeError("service does not exist")

        runner = CliRunner()
        result = runner.invoke(cli_module.cli, ["service", "reinstall"])

        assert result.exit_code == 0, result.output
        fake_service_module.install_service.assert_called_once()
        fake_service_module.start_service.assert_called_once()
        assert "stop skipped" in result.output
        assert "uninstall skipped" in result.output

    def test_install_failure_aborts_before_start(
        self,
        windows_platform: None,
        fake_service_module: MagicMock,
        configured_path: Path,
        tmp_path: Path,
    ) -> None:
        # If install fails (bad permissions, missing pywin32, etc.) we
        # MUST NOT try to start a service that doesn't exist — that just
        # papers over the real error with a confusing second one.
        (tmp_path / ".env.staging").write_text("")
        fake_service_module.install_service.side_effect = RuntimeError("access denied")

        runner = CliRunner()
        result = runner.invoke(cli_module.cli, ["service", "reinstall"])

        assert result.exit_code != 0
        assert "Failed to install service" in result.output
        fake_service_module.start_service.assert_not_called()


class TestServiceReinstallPlatformGuard:
    def test_non_windows_platform_exits_one(
        self,
        monkeypatch: pytest.MonkeyPatch,
        fake_service_module: MagicMock,
        configured_path: Path,
    ) -> None:
        monkeypatch.setattr(sys, "platform", "linux")

        runner = CliRunner()
        result = runner.invoke(cli_module.cli, ["service", "reinstall"])

        assert result.exit_code == 1
        assert "Windows" in result.output
        # None of the service helpers should have been touched.
        fake_service_module.stop_service.assert_not_called()
        fake_service_module.install_service.assert_not_called()


class TestServiceReinstallEnvPathOverride:
    def test_env_path_override_is_used(
        self,
        windows_platform: None,
        fake_service_module: MagicMock,
        configured_path: Path,
        tmp_path: Path,
    ) -> None:
        custom_env = tmp_path / "custom.env"
        custom_env.write_text("")

        runner = CliRunner()
        result = runner.invoke(
            cli_module.cli,
            ["service", "reinstall", "--env-path", str(custom_env)],
        )

        assert result.exit_code == 0, result.output
        kwargs = fake_service_module.install_service.call_args.kwargs
        assert kwargs["env_path"] == custom_env.resolve()

    def test_missing_env_path_warns_but_proceeds(
        self,
        windows_platform: None,
        fake_service_module: MagicMock,
        configured_path: Path,
        tmp_path: Path,
    ) -> None:
        # Don't create the env file — the default path won't exist.
        runner = CliRunner()
        result = runner.invoke(cli_module.cli, ["service", "reinstall"])

        assert result.exit_code == 0, result.output
        # Warning is printed to stderr; CliRunner mixes stderr into output
        # by default, so a substring check is enough.
        assert "Warning" in result.output
        assert "does not exist" in result.output
        fake_service_module.install_service.assert_called_once()
