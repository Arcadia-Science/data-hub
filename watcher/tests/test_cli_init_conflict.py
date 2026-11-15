"""Tests for what `data-hub-watcher init` says when the instrument already has a watcher.

Network and credential side effects are mocked, as in `test_cli_set_environment.py`:
`_make_client` returns a `MagicMock`, and `load_env` / `save_api_key` are stubbed so the
tests never touch the real `~/.data-hub`.
"""

from __future__ import annotations
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from click.testing import CliRunner

from data_hub_watcher import cli as cli_module
from data_hub_watcher.api_client import ApiError


@pytest.fixture
def fake_client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> MagicMock:
    monkeypatch.setattr(cli_module, "load_env", lambda *a, **k: None)
    monkeypatch.setattr(cli_module, "save_api_key", lambda *a, **k: tmp_path / ".env")
    monkeypatch.setattr(cli_module, "env_file_path", lambda _env: tmp_path / "missing.env")
    monkeypatch.delenv("DATA_HUB_API_KEY", raising=False)

    client = MagicMock()
    client.list_instruments.return_value = [
        MagicMock(
            id="plate-reader-a",
            status="active",
            display_name="Plate Reader A",
            file_patterns=["*.csv"],
        )
    ]
    client.register_watcher.side_effect = ApiError("conflict", status_code=409)
    monkeypatch.setattr(cli_module, "_make_client", lambda *a, **k: client)
    return client


def test_init_409_names_the_watcher_page_and_stays_plain_ascii(
    tmp_path: Path, fake_client: MagicMock, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.yaml"
    monkeypatch.setattr(cli_module, "resolve_config_path", lambda _override: config_path)
    watch_dir = tmp_path / "data"
    watch_dir.mkdir()
    answers = [
        "staging",  # Environment
        "https://datahub.example.test/api/v1",  # API base URL
        "dhub_test_key",  # API key
        "1",  # the existing instrument
        str(watch_dir),  # watch directory
        "",  # file patterns: the instrument's
        "1",  # run detection preset
        "",  # watch subdirectories: the default
        "",  # stability period: the default
        "",  # upload mode: the default
    ]

    result = CliRunner().invoke(cli_module.cli, ["init"], input="\n".join(answers) + "\n")

    assert result.exit_code != 0, result.output
    assert "Instrument 'plate-reader-a' already has an active watcher" in result.output
    assert "https://datahub.example.test/instruments/plate-reader-a/watcher" in result.output
    assert "Deregister from its actions menu" in result.output
    # A Windows console on a legacy code page can't always print more than ASCII, so the
    # guidance itself (the message after the "Error:" prefix) stays plain.
    guidance = result.output.split("Error:", 1)[1]
    assert guidance.isascii(), guidance
    # The refused PC writes no config.
    assert not config_path.exists()
