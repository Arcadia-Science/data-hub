"""Tests for how the one-shot `data-hub-watcher upload` command builds its uploader.

The command must give the uploader the instrument's `upload_parallelism` and a
stop event that Ctrl-C sets, so upload threads that are still running start no
more parts or files before the process exits.
"""

from __future__ import annotations
import threading
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from click.testing import CliRunner, Result

from data_hub_watcher import cli as cli_module
from data_hub_watcher.config_io import save_config
from data_hub_watcher.models import (
    InstrumentConfig,
    RunDetectionConfig,
    UploadQueueFile,
    UploadQueueResponse,
    WatcherConfig,
)


@pytest.fixture
def uploader_class(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> MagicMock:
    """Stub the config, client, state folder and `Uploader`, and return the `Uploader` class."""
    watch_dir = tmp_path / "data"
    watch_dir.mkdir()
    (watch_dir / "RUN001_sample.csv").write_text("a,b\n1,2\n")
    cfg = WatcherConfig(
        version=1,
        environment="staging",
        api_base_urls={"staging": "https://staging.example.test/api/v1"},
        watcher_ids={"staging": "w-test"},
        instrument=InstrumentConfig(
            id="test-instrument",
            watch_directory=watch_dir,
            file_patterns=["*.csv"],
            upload_parallelism=6,
            run_detection=RunDetectionConfig(pattern=r"^([^_]+)", recursive=False),
        ),
    )
    config_path = tmp_path / "config.yaml"
    save_config(cfg, config_path)

    client = MagicMock()
    client.get_instrument.return_value = MagicMock(status="active")
    client.get_upload_queue.return_value = UploadQueueResponse(
        files=[
            UploadQueueFile(
                id=1,
                instrument_id="test-instrument",
                run_id="RUN001",
                filename="RUN001_sample.csv",
                relative_path="RUN001_sample.csv",
            )
        ]
    )
    uploader_class = MagicMock()
    uploader_class.return_value._upload_single.return_value = True

    monkeypatch.setattr(cli_module, "resolve_config_path", lambda _override: config_path)
    monkeypatch.setattr(cli_module, "load_env", lambda *a, **k: None)
    monkeypatch.setattr(cli_module, "_make_client", lambda *a, **k: client)
    # Keep the state database out of the real `~/.data-hub`.
    monkeypatch.setattr(cli_module, "state_db_dir", lambda _path, *, service: tmp_path)
    monkeypatch.setattr(cli_module, "Uploader", uploader_class)
    return uploader_class


def _upload(*extra: str) -> Result:
    return CliRunner().invoke(cli_module.cli, ["upload", *extra])


def _stop_event(uploader_class: MagicMock) -> threading.Event:
    stop_event = uploader_class.call_args.kwargs["stop_event"]
    assert isinstance(stop_event, threading.Event)
    return stop_event


class TestUploadCommand:
    def test_one_file_upload_passes_the_parallelism_and_a_stop_event(
        self, tmp_path: Path, uploader_class: MagicMock
    ) -> None:
        file_path = tmp_path / "data" / "RUN001_sample.csv"

        result = _upload("--file", str(file_path), "--run-id", "RUN001")

        assert result.exit_code == 0, result.output
        assert uploader_class.call_args.kwargs["upload_parallelism"] == 6
        assert not _stop_event(uploader_class).is_set()

    def test_queue_upload_passes_the_parallelism_and_a_stop_event(
        self, tmp_path: Path, uploader_class: MagicMock
    ) -> None:
        result = _upload()

        assert result.exit_code == 0, result.output
        assert uploader_class.call_args.kwargs["upload_parallelism"] == 6
        assert not _stop_event(uploader_class).is_set()
        uploader_class.return_value.poll_upload_queue.assert_called_once_with()

    def test_ctrl_c_during_a_one_file_upload_sets_the_stop_event(
        self, tmp_path: Path, uploader_class: MagicMock
    ) -> None:
        uploader_class.return_value._upload_single.side_effect = KeyboardInterrupt
        file_path = tmp_path / "data" / "RUN001_sample.csv"

        result = _upload("--file", str(file_path), "--run-id", "RUN001")

        assert result.exit_code == 1
        assert _stop_event(uploader_class).is_set()

    def test_ctrl_c_during_a_queue_upload_sets_the_stop_event(
        self, tmp_path: Path, uploader_class: MagicMock
    ) -> None:
        uploader_class.return_value.poll_upload_queue.side_effect = KeyboardInterrupt

        result = _upload()

        assert result.exit_code == 1
        assert _stop_event(uploader_class).is_set()
