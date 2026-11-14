"""How `FileMonitor` notices that its watch folder itself is gone (watcher 1.4.3).

The handler tells its owner when watchdog reports the watched folder deleted or moved,
and nothing else about deletes and moves: a file or folder removed from inside the watch
folder stays ignored. `FileMonitor.is_watching` says whether watchdog still watches the
folder, which is how a folder that was deleted and created again is told from one that
was never touched.
"""

from __future__ import annotations
import logging
import shutil
import time
from collections.abc import Callable, Generator
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from watchdog.events import (
    DirCreatedEvent,
    DirDeletedEvent,
    DirMovedEvent,
    FileDeletedEvent,
    FileMovedEvent,
)

from data_hub_watcher.monitor import FileMonitor, _EventHandler
from data_hub_watcher.state import StateDB


@pytest.fixture()
def state_db(tmp_path: Path) -> Generator[StateDB, None, None]:
    db = StateDB(tmp_path / "state.db")
    yield db
    db.close()


def _handler(root: Path, on_root_gone: Callable[[], None] | None) -> _EventHandler:
    return _EventHandler(
        lambda name: name.endswith(".csv"),
        MagicMock(),
        True,
        root=str(root),
        on_root_gone=on_root_gone,
    )


class TestRootEvents:
    def test_the_folder_being_deleted_is_reported(self, tmp_path: Path) -> None:
        gone = MagicMock()

        _handler(tmp_path, gone).dispatch(DirDeletedEvent(str(tmp_path)))

        gone.assert_called_once_with()

    def test_the_folder_being_moved_is_reported(self, tmp_path: Path) -> None:
        gone = MagicMock()

        _handler(tmp_path, gone).dispatch(DirMovedEvent(str(tmp_path), str(tmp_path) + "-moved"))

        gone.assert_called_once_with()

    def test_a_delete_or_move_inside_the_folder_is_not(self, tmp_path: Path) -> None:
        gone = MagicMock()
        handler = _handler(tmp_path, gone)

        handler.dispatch(FileDeletedEvent(str(tmp_path / "a.csv")))
        handler.dispatch(DirDeletedEvent(str(tmp_path / "run1")))
        handler.dispatch(DirDeletedEvent(str(tmp_path / "run1" / "deeper")))
        handler.dispatch(FileMovedEvent(str(tmp_path / "a.csv"), str(tmp_path / "b.csv")))
        handler.dispatch(DirMovedEvent(str(tmp_path / "run1"), str(tmp_path / "run2")))
        # A folder that merely starts with the same text.
        handler.dispatch(DirDeletedEvent(str(tmp_path) + "-other"))

        gone.assert_not_called()

    def test_other_events_for_the_folder_are_not(self, tmp_path: Path) -> None:
        gone = MagicMock()

        _handler(tmp_path, gone).dispatch(DirCreatedEvent(str(tmp_path)))

        gone.assert_not_called()

    def test_a_handler_with_no_callback_ignores_the_event(self, tmp_path: Path) -> None:
        _handler(tmp_path, None).dispatch(DirDeletedEvent(str(tmp_path)))

    def test_a_callback_that_fails_does_not_stop_the_observer(
        self, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ) -> None:
        gone = MagicMock(side_effect=RuntimeError("boom"))

        with caplog.at_level(logging.ERROR, logger="data_hub_watcher.monitor"):
            _handler(tmp_path, gone).dispatch(DirDeletedEvent(str(tmp_path)))

        assert "Callback for a deleted watch folder failed" in caplog.text


class TestIsWatching:
    def _monitor(self, watch_dir: Path, state_db: StateDB) -> FileMonitor:
        return FileMonitor(
            watch_directory=watch_dir,
            file_patterns=["*.csv"],
            stability_period=1,
            on_stable_file=MagicMock(),
            state_db=state_db,
        )

    def test_it_is_false_until_the_monitor_starts(self, tmp_path: Path, state_db: StateDB) -> None:
        assert not self._monitor(tmp_path, state_db).is_watching()

    def test_it_is_true_while_the_folder_is_watched_and_false_once_it_is_deleted(
        self, tmp_path: Path, state_db: StateDB
    ) -> None:
        watch_dir = tmp_path.resolve() / "watch"
        watch_dir.mkdir()
        monitor = self._monitor(watch_dir, state_db)
        monitor.start()
        try:
            assert monitor.is_watching()

            # Created again at once: the folder is there, but the one watchdog watched is not.
            shutil.rmtree(watch_dir)
            watch_dir.mkdir()
            deadline = time.monotonic() + 10
            while monitor.is_watching():
                assert time.monotonic() < deadline, "watchdog still reports the folder as watched"
                time.sleep(0.02)
        finally:
            monitor.stop()
        assert not monitor.is_watching()
