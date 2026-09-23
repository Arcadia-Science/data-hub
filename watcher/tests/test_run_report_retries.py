"""Transient run-report failures retry without another file event."""

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
import requests

from data_hub_watcher.api_client import ApiError, DataHubClient
from data_hub_watcher.monitor import FileMonitor
from data_hub_watcher.run_detector import RunDetector


def _detector(tmp_path: Path, client: MagicMock) -> RunDetector:
    return RunDetector(
        pattern=r"^(R1)_",
        instrument_id="synthetic-instrument",
        watcher_id="synthetic-watcher",
        client=client,
        state_db=MagicMock(),
        event_reporter=MagicMock(),
        counters=MagicMock(),
        watch_directory=tmp_path,
    )


def test_transient_post_retries_without_new_file(tmp_path: Path, monkeypatch) -> None:
    clock = [100.0]
    monkeypatch.setattr("data_hub_watcher.run_detector.time.monotonic", lambda: clock[0])
    file = tmp_path / "R1_a.csv"
    file.write_text("a")
    client = MagicMock()
    client.report_run.side_effect = [ApiError("temporary", 503), SimpleNamespace(id="run")]
    detector = _detector(tmp_path, client)

    detector.on_stable_file(file)
    detector.on_stable_file(file)  # duplicate callbacks must not be needed
    clock[0] = 104.0
    detector.retry_failed_reports()
    assert client.report_run.call_count == 1

    clock[0] = 105.0
    detector.retry_failed_reports()
    assert client.report_run.call_count == 2
    assert detector._runs["R1"].reported
    detector.retry_failed_reports()
    assert client.report_run.call_count == 2


def test_transient_patch_retries_backlog(tmp_path: Path, monkeypatch) -> None:
    clock = [100.0]
    monkeypatch.setattr("data_hub_watcher.run_detector.time.monotonic", lambda: clock[0])
    client = MagicMock()
    client.report_run.return_value = SimpleNamespace(id="run")
    client.update_run.side_effect = [ApiError("temporary", 503), MagicMock()]
    detector = _detector(tmp_path, client)
    first = tmp_path / "R1_a.csv"
    second = tmp_path / "R1_b.csv"
    first.write_text("a")
    second.write_text("b")

    detector.on_stable_file(first)
    detector.on_stable_file(second)
    assert client.update_run.call_count == 1
    clock[0] = 105.0
    detector.retry_failed_reports()
    assert client.update_run.call_count == 2
    assert detector._runs["R1"].patched_file_count == 2


def test_permanent_error_does_not_schedule_retry(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("data_hub_watcher.run_detector.time.monotonic", lambda: 100.0)
    file = tmp_path / "R1_a.csv"
    file.write_text("a")
    client = MagicMock()
    client.report_run.side_effect = ApiError("invalid watcher", 400)
    detector = _detector(tmp_path, client)
    detector.on_stable_file(file)
    detector.retry_failed_reports()
    assert client.report_run.call_count == 1
    assert detector._runs["R1"].retry_at is None


def test_rate_limit_honors_retry_after(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("data_hub_watcher.run_detector.time.monotonic", lambda: 100.0)
    response = requests.Response()
    response.status_code = 429
    response._content = b"busy"
    response.headers["Retry-After"] = "120"
    with pytest.raises(ApiError) as raised:
        DataHubClient("https://example.test")._handle_error(response)
    assert raised.value.retry_after_seconds == 120

    file = tmp_path / "R1_a.csv"
    file.write_text("a")
    client = MagicMock()
    client.report_run.side_effect = raised.value
    detector = _detector(tmp_path, client)
    detector.on_stable_file(file)
    assert detector._runs["R1"].retry_at == 220


def test_monitor_ticks_retries_even_with_no_pending_file(tmp_path: Path) -> None:
    retry = MagicMock()
    monitor = FileMonitor(
        watch_directory=tmp_path,
        file_patterns=["*.csv"],
        stability_period=1,
        on_stable_file=MagicMock(),
        on_retry_tick=retry,
        state_db=MagicMock(),
    )
    monitor._check_pending()
    retry.assert_called_once_with()
