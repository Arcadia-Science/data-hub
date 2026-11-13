"""How long `FileMonitor.stop` waits for its observer and its stability checker.

A stop for Windows shutting down passes short timeouts for both, because Windows ends the
service when its preshutdown timeout passes. Any other stop keeps the defaults.
"""

from __future__ import annotations
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
