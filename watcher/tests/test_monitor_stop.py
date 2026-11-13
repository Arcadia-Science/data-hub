"""How long `FileMonitor.stop` waits for its observer and its stability checker.

A stop for Windows shutting down passes short timeouts for both, because Windows ends the
service when its preshutdown timeout passes. Any other stop keeps the defaults.
"""

from __future__ import annotations
import logging
import threading
from collections.abc import Generator
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from data_hub_watcher.monitor import FileMonitor
from data_hub_watcher.state import StateDB


@pytest.fixture()
def state_db(tmp_path: Path) -> Generator[StateDB, None, None]:
    db = StateDB(tmp_path / "state.db")
    yield db
    db.close()


def _monitor_with_running_threads(
    tmp_path: Path, state_db: StateDB
) -> tuple[FileMonitor, MagicMock, MagicMock]:
    watch_dir = tmp_path / "watch"
    watch_dir.mkdir()
    monitor = FileMonitor(
        watch_directory=watch_dir,
        file_patterns=["*.csv"],
        stability_period=1,
        on_stable_file=MagicMock(),
        state_db=state_db,
    )
    observer = MagicMock()
    observer.is_alive.return_value = True
    monitor._observer = observer
    checker = MagicMock(spec=threading.Thread)
    checker.is_alive.return_value = True
    monitor._checker_thread = checker
    return monitor, observer, checker


class TestStopTimeouts:
    def test_the_defaults_wait_5_seconds_for_each(self, tmp_path: Path, state_db: StateDB) -> None:
        monitor, observer, checker = _monitor_with_running_threads(tmp_path, state_db)

        monitor.stop()

        observer.join.assert_called_once_with(timeout=5.0)
        checker.join.assert_called_once_with(timeout=5.0)

    def test_short_timeouts_apply_to_both_waits(self, tmp_path: Path, state_db: StateDB) -> None:
        monitor, observer, checker = _monitor_with_running_threads(tmp_path, state_db)

        monitor.stop(timeout=1, observer_timeout=2)

        observer.join.assert_called_once_with(timeout=2)
        checker.join.assert_called_once_with(timeout=1)

    def test_reports_whether_the_stability_checker_exited(
        self, tmp_path: Path, state_db: StateDB
    ) -> None:
        monitor, _observer, _checker = _monitor_with_running_threads(tmp_path, state_db)

        # The thread mock still says it is alive after the join: an upload that it is
        # running outlasts the wait.
        assert monitor.stop(timeout=1, observer_timeout=1) is False


class TestStoppedIsLoggedOnlyOnceItIsTrue:
    """`stop(timeout=0.0)` returns at once, and the stability checker can be uploading a file."""

    def test_a_checker_still_running_is_not_logged_as_stopped(
        self, tmp_path: Path, state_db: StateDB, caplog: pytest.LogCaptureFixture
    ) -> None:
        monitor, _observer, _checker = _monitor_with_running_threads(tmp_path, state_db)

        with caplog.at_level(logging.INFO, logger="data_hub_watcher.monitor"):
            assert monitor.stop(timeout=0.0) is False

        messages = [r.getMessage() for r in caplog.records]
        assert "FileMonitor stopped" not in messages
        assert any("still running" in m for m in messages)

    def test_the_wait_that_follows_logs_it_when_the_checker_has_exited(
        self, tmp_path: Path, state_db: StateDB, caplog: pytest.LogCaptureFixture
    ) -> None:
        monitor, _observer, checker = _monitor_with_running_threads(tmp_path, state_db)
        monitor.stop(timeout=0.0)
        caplog.clear()
        # The upload ended while the stop waited for it.
        checker.is_alive.return_value = False

        with caplog.at_level(logging.INFO, logger="data_hub_watcher.monitor"):
            assert monitor.join(5.0) is True

        assert [r.getMessage() for r in caplog.records] == ["FileMonitor stopped"]

    def test_a_checker_that_exits_in_time_is_logged_as_stopped_by_the_stop(
        self, tmp_path: Path, state_db: StateDB, caplog: pytest.LogCaptureFixture
    ) -> None:
        monitor, _observer, checker = _monitor_with_running_threads(tmp_path, state_db)
        # Alive when the stop looks, gone after the join.
        checker.is_alive.side_effect = [True, False]

        with caplog.at_level(logging.INFO, logger="data_hub_watcher.monitor"):
            assert monitor.stop() is True

        assert [r.getMessage() for r in caplog.records] == ["FileMonitor stopped"]
