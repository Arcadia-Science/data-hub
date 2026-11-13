"""The start-up scan ends early on a stop (watcher 1.4.3).

On a large folder the scan takes minutes, and a stop that arrived during it used to wait for
the end of it. `FileMonitor` takes a ``should_stop`` callable and checks it between the
entries of the scan. The files the scan hadn't reached are scanned at the next start, so the
scan must leave nothing behind in the state database that would make that start skip them.
"""

from __future__ import annotations
import threading
from collections.abc import Callable, Generator
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from data_hub_watcher.monitor import FileMonitor
from data_hub_watcher.state import StateDB

FILE_COUNT = 40


@pytest.fixture()
def state_db(tmp_path: Path) -> Generator[StateDB, None, None]:
    db = StateDB(tmp_path / "state.db")
    yield db
    db.close()


@pytest.fixture()
def watch_dir(tmp_path: Path) -> Path:
    folder = tmp_path / "watch"
    folder.mkdir()
    for i in range(FILE_COUNT):
        (folder / f"RUN{i:03}_a.csv").write_text("a,b\n1,2\n")
    return folder


def _monitor(
    watch_dir: Path,
    state_db: StateDB,
    *,
    should_stop: Callable[[], bool] | None = None,
    seed_baseline: bool = False,
    recursive: bool = False,
) -> FileMonitor:
    return FileMonitor(
        watch_directory=watch_dir,
        file_patterns=["*.csv"],
        stability_period=1,
        on_stable_file=MagicMock(),
        state_db=state_db,
        should_stop=should_stop,
        seed_baseline=seed_baseline,
        recursive=recursive,
    )


class TestScanStopsEarly:
    def test_a_stop_during_the_scan_ends_it_between_entries(
        self, watch_dir: Path, state_db: StateDB, count_scan_entries: Callable[..., Any]
    ) -> None:
        stop = threading.Event()
        scandir = count_scan_entries(after=stop.set, n=3)
        monitor = _monitor(watch_dir, state_db, should_stop=stop.is_set)

        monitor.start()

        # The stop came with the third entry, and the scan saw it before the fourth.
        assert scandir.entries_read == 3
        assert len(monitor._pending) < FILE_COUNT

    def test_start_then_returns_without_starting_the_observer_or_the_stability_checker(
        self, watch_dir: Path, state_db: StateDB, count_scan_entries: Callable[..., Any]
    ) -> None:
        stop = threading.Event()
        count_scan_entries(after=stop.set)
        monitor = _monitor(watch_dir, state_db, should_stop=stop.is_set)

        monitor.start()

        assert not monitor._observer.is_alive()
        assert monitor._checker_thread is None
        assert not monitor.is_watching()
        # And it can be stopped like any other monitor.
        assert monitor.stop(timeout=1) is True

    def test_a_stop_before_the_scan_skips_it_altogether(
        self,
        watch_dir: Path,
        state_db: StateDB,
        count_scan_entries: Callable[..., Any],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        scandir = count_scan_entries()
        loaded: list[bool] = []
        monkeypatch.setattr(
            FileMonitor, "_load_dedup_index", lambda self: loaded.append(True) or {}
        )
        monitor = _monitor(watch_dir, state_db, should_stop=lambda: True)

        monitor.start()

        assert scandir.entries_read == 0
        # Not even the index of what was uploaded, which can be large.
        assert loaded == []

    def test_a_stop_is_seen_in_a_tree_of_folders_with_no_files_in_it(
        self,
        tmp_path: Path,
        state_db: StateDB,
        count_scan_entries: Callable[..., Any],
    ) -> None:
        folder = tmp_path / "tree"
        for i in range(30):
            (folder / f"run{i}").mkdir(parents=True)
        stop = threading.Event()
        scandir = count_scan_entries(after=stop.set, n=2)
        monitor = _monitor(folder, state_db, should_stop=stop.is_set, recursive=True)

        monitor.start()

        # Walking folders is work too: the scan did not go through all 30.
        assert scandir.entries_read == 2

    def test_nothing_is_recorded_for_the_files_it_did_not_reach(
        self, watch_dir: Path, state_db: StateDB, count_scan_entries: Callable[..., Any]
    ) -> None:
        stop = threading.Event()
        count_scan_entries(after=stop.set)
        monitor = _monitor(watch_dir, state_db, should_stop=stop.is_set)
        monitor.start()
        monitor.stop(timeout=1)

        # Files go into the state database when they have been reported or uploaded,
        # which starts at the stability checker, and that never ran.
        assert list(state_db.iter_uploaded_stat_keys()) == []
        assert list(state_db.iter_detected_stat_keys()) == []
        assert list(state_db.iter_baseline_stat_keys()) == []
        assert state_db.pending_uploads() == []

    def test_the_next_start_scans_every_file(
        self, watch_dir: Path, state_db: StateDB, count_scan_entries: Callable[..., Any]
    ) -> None:
        stop = threading.Event()
        count_scan_entries(after=stop.set)
        first = _monitor(watch_dir, state_db, should_stop=stop.is_set)
        first.start()
        first.stop(timeout=1)
        assert len(first._pending) < FILE_COUNT

        second = _monitor(watch_dir, state_db, should_stop=threading.Event().is_set)
        second._initial_scan()

        assert len(second._pending) == FILE_COUNT

    def test_a_scan_with_no_stop_callable_runs_to_the_end(
        self, watch_dir: Path, state_db: StateDB
    ) -> None:
        monitor = _monitor(watch_dir, state_db)

        monitor._initial_scan()

        assert len(monitor._pending) == FILE_COUNT


class TestBaselineScanStopsEarly:
    """The first start of a `new-only` environment records the backlog as skipped.

    The rows and the "seeded" mark go in once, after the walk. A walk that stops early must
    record neither: a baseline row makes the database count as seeded, so the next start would
    not seed again, and the files the walk never reached would be uploaded as new.
    """

    def test_a_baseline_scan_that_stops_early_records_nothing(
        self, watch_dir: Path, state_db: StateDB, count_scan_entries: Callable[..., Any]
    ) -> None:
        stop = threading.Event()
        scandir = count_scan_entries(after=stop.set)
        monitor = _monitor(watch_dir, state_db, should_stop=stop.is_set, seed_baseline=True)

        monitor.start()

        assert scandir.entries_read == 3
        assert list(state_db.iter_baseline_stat_keys()) == []
        assert not state_db.baseline_established()

    def test_the_next_start_seeds_the_whole_folder(
        self, watch_dir: Path, state_db: StateDB, count_scan_entries: Callable[..., Any]
    ) -> None:
        stop = threading.Event()
        count_scan_entries(after=stop.set)
        _monitor(watch_dir, state_db, should_stop=stop.is_set, seed_baseline=True).start()
        # What `build_runtime` asks before it builds the next monitor.
        assert not state_db.baseline_established()

        second = _monitor(watch_dir, state_db, seed_baseline=True)
        second._initial_scan()

        assert len(list(state_db.iter_baseline_stat_keys())) == FILE_COUNT
        assert state_db.baseline_established()
        # Seeded, not queued for upload.
        assert second._pending == {}
