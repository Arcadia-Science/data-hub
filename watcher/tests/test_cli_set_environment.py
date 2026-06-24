"""Tests for `data-hub-watcher config set-environment` and the switch helper.

Network and credential side effects are mocked: `_make_client` returns a
`MagicMock`, and `load_env` / `save_api_key` are stubbed so the tests never
touch the real `~/.data-hub`. The state DBs live under `tmp_path` because the
config's parent directory is the config dir.
"""

from __future__ import annotations
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from click.testing import CliRunner, Result

from data_hub_watcher import cli as cli_module
from data_hub_watcher.api_client import ApiError
from data_hub_watcher.config_io import load_config, save_config
from data_hub_watcher.constants import state_db_path
from data_hub_watcher.models import InstrumentConfig, RunDetectionConfig, WatcherConfig
from data_hub_watcher.state import StateDB

PREVIEW_A = "https://data-hub-git-branch-a.vercel.app/api/v1"
PREVIEW_B = "https://data-hub-git-branch-b.vercel.app/api/v1"


def _write_config(
    tmp_path: Path,
    *,
    environment: str,
    watcher_ids: dict[str, str],
    api_base_url: str | None = None,
) -> Path:
    watch_dir = tmp_path / "data"
    watch_dir.mkdir(exist_ok=True)
    (watch_dir / "RUN001_sample.csv").write_text("a,b\n1,2\n")
    cfg = WatcherConfig(
        version=1,
        environment=environment,  # type: ignore[arg-type]
        api_base_url=api_base_url,
        watcher_ids=watcher_ids,
        instrument=InstrumentConfig(
            id="test-instrument",
            watch_directory=watch_dir,
            file_patterns=["*.csv"],
            run_detection=RunDetectionConfig(pattern=r"^([^_]+)", recursive=False),
        ),
    )
    path = tmp_path / "config.yaml"
    save_config(cfg, path)
    return path


@pytest.fixture
def fake_client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> MagicMock:
    """Stub out network + credential IO and return the shared fake client."""
    monkeypatch.setattr(cli_module, "load_env", lambda *a, **k: None)
    monkeypatch.setattr(cli_module, "save_api_key", lambda *a, **k: tmp_path / ".env")

    client = MagicMock()
    client.list_instruments.return_value = [MagicMock(id="test-instrument")]
    client.get_instrument.return_value = MagicMock(status="active")
    client.register_watcher.return_value = MagicMock(watcher_id="w-prod")
    client.get_config_checksum.return_value = None
    monkeypatch.setattr(cli_module, "_make_client", lambda *a, **k: client)
    return client


def _invoke(path: Path, monkeypatch: pytest.MonkeyPatch, args: list[str]) -> Result:
    monkeypatch.setattr(cli_module, "resolve_config_path", lambda _override: path)
    runner = CliRunner()
    return runner.invoke(cli_module.cli, ["config", "set-environment", *args])


class TestSwitchRegistration:
    def test_reuses_stored_id_without_registering(
        self, tmp_path: Path, fake_client: MagicMock, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        path = _write_config(
            tmp_path,
            environment="staging",
            watcher_ids={"staging": "w-staging", "production": "w-prod-existing"},
        )

        result = _invoke(path, monkeypatch, ["production", "--api-key", "dhub_key"])

        assert result.exit_code == 0, result.output
        fake_client.register_watcher.assert_not_called()
        fake_client.get_instrument.assert_called()  # validates the stored id
        cfg = load_config(path)
        assert cfg.environment == "production"
        assert cfg.watcher_id == "w-prod-existing"

    def test_registers_when_no_stored_id_and_keeps_other_ids(
        self, tmp_path: Path, fake_client: MagicMock, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        path = _write_config(tmp_path, environment="staging", watcher_ids={"staging": "w-staging"})

        result = _invoke(path, monkeypatch, ["production", "--api-key", "dhub_key"])

        assert result.exit_code == 0, result.output
        fake_client.register_watcher.assert_called_once()
        cfg = load_config(path)
        assert cfg.environment == "production"
        assert cfg.watcher_ids == {"staging": "w-staging", "production": "w-prod"}


class TestSwitchFailures:
    def test_preview_without_url_fails_before_any_call(
        self, tmp_path: Path, fake_client: MagicMock, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        path = _write_config(tmp_path, environment="staging", watcher_ids={"staging": "w-staging"})

        result = _invoke(path, monkeypatch, ["preview"])

        assert result.exit_code != 0
        assert "api-base-url is required" in result.output
        fake_client.list_instruments.assert_not_called()
        assert load_config(path).environment == "staging"

    def test_no_register_unknown_target_leaves_config_untouched(
        self, tmp_path: Path, fake_client: MagicMock, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        path = _write_config(tmp_path, environment="staging", watcher_ids={"staging": "w-staging"})

        result = _invoke(
            path, monkeypatch, ["production", "--api-key", "dhub_key", "--no-register"]
        )

        assert result.exit_code != 0
        fake_client.register_watcher.assert_not_called()
        cfg = load_config(path)
        assert cfg.environment == "staging"
        assert cfg.watcher_ids == {"staging": "w-staging"}

    def test_api_error_leaves_config_untouched(
        self, tmp_path: Path, fake_client: MagicMock, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake_client.list_instruments.side_effect = ApiError("unauthorized", status_code=401)
        path = _write_config(tmp_path, environment="staging", watcher_ids={"staging": "w-staging"})

        result = _invoke(path, monkeypatch, ["production", "--api-key", "dhub_key"])

        assert result.exit_code != 0
        cfg = load_config(path)
        assert cfg.environment == "staging"
        assert cfg.watcher_ids == {"staging": "w-staging"}


class TestWindowsServiceSync:
    def test_rewrites_registry_env_path_on_windows(
        self, tmp_path: Path, fake_client: MagicMock, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(sys, "platform", "win32")
        env_path = tmp_path / ".env.production"
        monkeypatch.setattr(cli_module, "env_file_path", lambda _env: env_path)

        fake_service = MagicMock(name="data_hub_watcher.service")
        monkeypatch.setitem(sys.modules, "data_hub_watcher.service", fake_service)

        path = _write_config(tmp_path, environment="staging", watcher_ids={"staging": "w-staging"})

        result = _invoke(path, monkeypatch, ["production", "--api-key", "dhub_key"])

        assert result.exit_code == 0, result.output
        fake_service._rewrite_service_env_path.assert_called_once_with(env_path)


class TestPreviewRedeploy:
    def _seed_preview_db(self, tmp_path: Path, url: str) -> None:
        db = StateDB(state_db_path(tmp_path, "preview"))
        db.set_meta("preview_api_base_url", url)
        db.record_baseline_files([("old-backlog.csv", 10, 1.0)])
        db.close()

    def test_changed_url_resets_db_and_reregisters(
        self, tmp_path: Path, fake_client: MagicMock, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        self._seed_preview_db(tmp_path, PREVIEW_A)
        path = _write_config(
            tmp_path,
            environment="preview",
            watcher_ids={"preview": "w-prev-a"},
            api_base_url=PREVIEW_A,
        )

        result = _invoke(
            path, monkeypatch, ["preview", "--api-base-url", PREVIEW_B, "--api-key", "dhub_key"]
        )

        assert result.exit_code == 0, result.output
        fake_client.register_watcher.assert_called_once()
        cfg = load_config(path)
        assert cfg.api_base_url == PREVIEW_B

        db = StateDB(state_db_path(tmp_path, "preview"))
        try:
            # Reset wiped the old backlog; only the new deployment URL remains.
            assert list(db.iter_baseline_stat_keys()) == []
            assert db.get_meta("preview_api_base_url") == PREVIEW_B
        finally:
            db.close()

    def test_unchanged_url_preserves_db(
        self, tmp_path: Path, fake_client: MagicMock, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        self._seed_preview_db(tmp_path, PREVIEW_A)
        path = _write_config(
            tmp_path,
            environment="preview",
            watcher_ids={"preview": "w-prev-a"},
            api_base_url=PREVIEW_A,
        )

        result = _invoke(
            path, monkeypatch, ["preview", "--api-base-url", PREVIEW_A, "--api-key", "dhub_key"]
        )

        assert result.exit_code == 0, result.output
        fake_client.register_watcher.assert_not_called()

        db = StateDB(state_db_path(tmp_path, "preview"))
        try:
            assert [k[0] for k in db.iter_baseline_stat_keys()] == ["old-backlog.csv"]
        finally:
            db.close()
