"""Tests for `config edit` and `config validate` around remote config (watcher 1.3.0)."""

from __future__ import annotations
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from click.testing import CliRunner

from data_hub_watcher import cli as cli_module
from data_hub_watcher.config_io import load_config, save_config
from data_hub_watcher.models import InstrumentConfig, RunDetectionConfig, WatcherConfig


def _write_config(tmp_path: Path, watch_dir: Path) -> Path:
    cfg = WatcherConfig(
        version=1,
        environment="staging",
        api_base_urls={"staging": "https://staging.example.test/api/v1"},
        watcher_ids={"staging": "w-staging"},
        instrument=InstrumentConfig(
            id="test-instrument",
            watch_directory=watch_dir,
            file_patterns=["*.csv"],
            stability_period_seconds=5,
            max_stability_wait_seconds=1800,
            upload_parallelism=2,
            run_detection=RunDetectionConfig(pattern=r"^([^_]+)", recursive=False),
        ),
    )
    path = tmp_path / "config.yaml"
    save_config(cfg, path)
    return path


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    monkeypatch.setattr(cli_module, "load_env", lambda *a, **k: None)
    fake = MagicMock()
    monkeypatch.setattr(cli_module, "_make_client", lambda *a, **k: fake)
    monkeypatch.setattr(cli_module, "_prompt_run_detection", lambda *a, **k: (r"^([^_]+)", False))
    return fake


class TestConfigEdit:
    def test_keeps_fields_it_does_not_prompt_for(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, client: MagicMock
    ) -> None:
        watch_dir = tmp_path / "data"
        watch_dir.mkdir()
        path = _write_config(tmp_path, watch_dir)
        monkeypatch.setattr(cli_module, "resolve_config_path", lambda _override: path)

        # Prompts: environment, watch dir, file patterns, stability, upload
        # mode, enabled. Change the patterns and accept the other defaults.
        user_input = "\n".join(["", "", "*.csv,*.txt", "", "", ""]) + "\n"
        result = CliRunner().invoke(cli_module.cli, ["config", "edit"], input=user_input)

        assert result.exit_code == 0, result.output
        inst = load_config(path).instrument
        assert inst.file_patterns == ["*.csv", "*.txt"]
        assert inst.max_stability_wait_seconds == 1800
        assert inst.upload_parallelism == 2
        # The push tells the server when the file was edited.
        assert "modified_at" in client.push_config.call_args.kwargs

    def test_rejects_a_missing_watch_folder(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, client: MagicMock
    ) -> None:
        watch_dir = tmp_path / "data"
        watch_dir.mkdir()
        path = _write_config(tmp_path, watch_dir)
        monkeypatch.setattr(cli_module, "resolve_config_path", lambda _override: path)
        missing = tmp_path / "typo"

        user_input = "\n".join(["", str(missing)]) + "\n"
        result = CliRunner().invoke(cli_module.cli, ["config", "edit"], input=user_input)

        assert result.exit_code != 0
        assert "watch_directory not found" in result.output

    def test_rejects_more_patterns_than_data_hub_can_read(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, client: MagicMock
    ) -> None:
        watch_dir = tmp_path / "data"
        watch_dir.mkdir()
        path = _write_config(tmp_path, watch_dir)
        before = path.read_bytes()
        monkeypatch.setattr(cli_module, "resolve_config_path", lambda _override: path)
        many = ",".join(f"*.x{i}" for i in range(51))

        user_input = "\n".join(["", "", many]) + "\n"
        result = CliRunner().invoke(cli_module.cli, ["config", "edit"], input=user_input)

        assert result.exit_code != 0
        assert "at most 50 file patterns" in result.output
        assert path.read_bytes() == before
        client.push_config.assert_not_called()


class TestConfigValidate:
    def test_reports_a_missing_watch_folder(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        watch_dir = tmp_path / "data"
        watch_dir.mkdir()
        path = _write_config(tmp_path, watch_dir)
        watch_dir.rmdir()
        monkeypatch.setattr(cli_module, "resolve_config_path", lambda _override: path)
        monkeypatch.setattr(cli_module, "load_env", lambda *a, **k: None)

        result = CliRunner().invoke(cli_module.cli, ["config", "validate"])

        assert result.exit_code != 0
        assert "watch_directory not found" in result.output
        assert "wait" in result.output

    def test_valid_config_passes(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        watch_dir = tmp_path / "data"
        watch_dir.mkdir()
        path = _write_config(tmp_path, watch_dir)
        monkeypatch.setattr(cli_module, "resolve_config_path", lambda _override: path)
        monkeypatch.setattr(cli_module, "load_env", lambda *a, **k: None)

        result = CliRunner().invoke(cli_module.cli, ["config", "validate"])

        assert result.exit_code == 0, result.output
        assert "Config is valid" in result.output

    def test_warns_when_data_hub_cannot_read_the_settings(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        watch_dir = tmp_path / "data"
        watch_dir.mkdir()
        path = _write_config(tmp_path, watch_dir)
        cfg = load_config(path)
        too_many = cfg.instrument.model_copy(
            update={"file_patterns": [f"*.x{i}" for i in range(51)]}
        )
        save_config(cfg.model_copy(update={"instrument": too_many}), path)
        monkeypatch.setattr(cli_module, "resolve_config_path", lambda _override: path)
        monkeypatch.setattr(cli_module, "load_env", lambda *a, **k: None)

        result = CliRunner().invoke(cli_module.cli, ["config", "validate"])

        # The watcher runs it, so it still passes, with a warning.
        assert result.exit_code == 0, result.output
        assert "Config is valid" in result.output
        assert "Data Hub can't read these settings" in result.output
        assert "file_patterns" in result.output


class TestEditableSettingsProblem:
    @pytest.mark.parametrize(
        ("update", "expected"),
        [
            ({"file_patterns": [f"*.x{i}" for i in range(51)]}, "file_patterns"),
            ({"file_patterns": ["*." + "x" * 200]}, "longer than 200"),
            (
                {"run_detection": RunDetectionConfig(pattern=r"^(?P<run>[^_]+)", recursive=False)},
                "named groups",
            ),
        ],
    )
    def test_flags_settings_outside_the_servers_rules(
        self, tmp_path: Path, update: dict[str, object], expected: str
    ) -> None:
        from data_hub_watcher.remote_config import editable_settings_problem

        cfg = load_config(_write_config(tmp_path, tmp_path))
        assert editable_settings_problem(cfg.instrument) is None

        problem = editable_settings_problem(cfg.instrument.model_copy(update=update))

        assert problem is not None and expected in problem
