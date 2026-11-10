"""Unit tests for the report-only rescan after a config change widens the watcher.

When a config revision adds a file pattern, turns on recursion, changes the
run-detection regex or moves the folder, files already on disk that only the
new config matches are reported as detected without being uploaded. Files
written afterwards follow `upload_mode` as usual.
"""

from __future__ import annotations
import os
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from data_hub_watcher.heartbeat import WatcherCounters
from data_hub_watcher.models import InstrumentConfig, RunDetectionConfig
from data_hub_watcher.monitor import FileMonitor
from data_hub_watcher.remote_config import report_only_predicate, widens_scope
from data_hub_watcher.run_detector import RunDetector
from data_hub_watcher.state import StateDB


@pytest.fixture
def state_db(tmp_path: Path) -> Iterator[StateDB]:
    db = StateDB(tmp_path / "state.db")
    yield db
    db.close()


@pytest.fixture
def watch_dir(tmp_path: Path) -> Path:
    d = tmp_path / "watch"
    d.mkdir()
    return d


def _inst(
    watch_dir: Path,
    patterns: list[str],
    *,
    recursive: bool = False,
    pattern: str = r"^([^_]+)",
) -> InstrumentConfig:
    return InstrumentConfig(
        id="test-instrument",
        watch_directory=watch_dir,
        file_patterns=patterns,
        run_detection=RunDetectionConfig(pattern=pattern, recursive=recursive),
    )


def _write(path: Path, *, age_seconds: float = 0.0) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("data\n")
    if age_seconds:
        old = time.time() - age_seconds
        os.utime(path, (old, old))
    return path


def _detector(
    watch_dir: Path, state_db: StateDB, upload_cb: MagicMock, client: MagicMock
) -> RunDetector:
    return RunDetector(
        pattern=r"^([^_]+)",
        instrument_id="test-instrument",
        watcher_id="w-test",
        client=client,
        state_db=state_db,
        event_reporter=MagicMock(),
        counters=WatcherCounters(),
        upload_callback=upload_cb,
        watch_directory=watch_dir,
    )


def _settle(monitor: FileMonitor) -> None:
    """Mark every pending file as unchanged long enough, then dispatch."""
    with monitor._lock:
        for pending in monitor._pending.values():
            pending.last_changed -= 3600
    monitor._check_pending()


class TestWidensScope:
    def test_new_pattern_recursion_regex_and_folder_widen(self, tmp_path: Path) -> None:
        a = tmp_path / "a"
        b = tmp_path / "b"
        base = _inst(a, ["*.csv"])
        assert widens_scope(base, _inst(a, ["*.csv", "*.txt"]))
        assert widens_scope(base, _inst(a, ["*.csv"], recursive=True))
        assert widens_scope(base, _inst(a, ["*.csv"], pattern=r"^(\w+)"))
        assert widens_scope(base, _inst(b, ["*.csv"]))

    def test_narrowing_does_not_widen(self, tmp_path: Path) -> None:
        a = tmp_path / "a"
        base = _inst(a, ["*.csv", "*.txt"], recursive=True)
        assert not widens_scope(base, _inst(a, ["*.csv"], recursive=True))
        assert not widens_scope(base, _inst(a, ["*.csv", "*.txt"], recursive=False))


class TestReportOnlyPredicate:
    def test_only_old_files_the_old_config_missed_are_report_only(self, tmp_path: Path) -> None:
        old = _inst(tmp_path, ["*.csv"])
        new = _inst(tmp_path, ["*.csv", "*.txt"], recursive=True)
        cutoff = 1_000.0
        report_only = report_only_predicate(old, new, cutoff=cutoff)

        assert report_only("RUN1_a.txt", 500.0)  # new pattern
        assert report_only("sub/RUN1_a.csv", 500.0)  # newly recursive
        assert not report_only("RUN1_a.csv", 500.0)  # old config handled it
        assert not report_only("RUN1_b.txt", 1_500.0)  # written after the change

    def test_regex_change_marks_previous_mismatches(self, tmp_path: Path) -> None:
        old = _inst(tmp_path, ["*.csv"], pattern=r"^(RUN\d+)_")
        new = _inst(tmp_path, ["*.csv"], pattern=r"^([^_]+)_")
        report_only = report_only_predicate(old, new, cutoff=1_000.0)

        assert report_only("other_a.csv", 500.0)
        assert not report_only("RUN1_a.csv", 500.0)

    def test_folder_change_marks_every_old_file(self, tmp_path: Path) -> None:
        old = _inst(tmp_path / "a", ["*.csv"])
        new = _inst(tmp_path / "b", ["*.csv"])
        report_only = report_only_predicate(old, new, cutoff=1_000.0)

        assert report_only("RUN1_a.csv", 500.0)
        assert not report_only("RUN1_a.csv", 1_500.0)


class TestWidenedPatternRescan:
    """Existing files that only the new pattern matches are reported, not uploaded."""

    def test_existing_files_reported_without_upload_new_files_uploaded(
        self, watch_dir: Path, state_db: StateDB
    ) -> None:
        old_inst = _inst(watch_dir, ["*.csv"])
        new_inst = _inst(watch_dir, ["*.csv", "*.txt"])
        existing = _write(watch_dir / "RUN1_existing.txt", age_seconds=600)
        cutoff = time.time()

        client = MagicMock()
        client.report_run.return_value = MagicMock(id="api-run-1")
        upload_cb = MagicMock(side_effect=lambda _run_id, files: len(files))
        detector = _detector(watch_dir, state_db, upload_cb, client)
        monitor = FileMonitor(
            watch_directory=watch_dir,
            file_patterns=new_inst.file_patterns,
            stability_period=1,
            on_stable_file=detector.on_stable_file,
            state_db=state_db,
            report_only=report_only_predicate(old_inst, new_inst, cutoff=cutoff),
            on_report_only_file=lambda p: detector.on_stable_file(p, upload=False),
        )

        monitor._initial_scan()
        _settle(monitor)

        # Reported as detected, never handed to the uploader.
        client.report_run.assert_called_once()
        reported = client.report_run.call_args.args[1]["detected_files"]
        assert [f["relative_path"] for f in reported] == ["RUN1_existing.txt"]
        upload_cb.assert_not_called()

        # A file written after the change, in the same run, follows auto mode.
        new_file = _write(watch_dir / "RUN1_later.txt")
        monitor._enqueue(new_file)
        _settle(monitor)

        client.update_run.assert_called_once()
        upload_cb.assert_called_once()
        uploaded = upload_cb.call_args.args[1]
        assert [f.path for f in uploaded] == [new_file]
        assert existing not in [f.path for f in uploaded]

    @pytest.mark.parametrize("noticed_by", ["stability_check", "watchdog_event"])
    def test_file_written_to_after_the_scan_follows_upload_mode(
        self, watch_dir: Path, state_db: StateDB, noticed_by: str
    ) -> None:
        # An acquisition was still writing this file when the change arrived.
        old_inst = _inst(watch_dir, ["*.csv"])
        new_inst = _inst(watch_dir, ["*.csv", "*.raw"])
        growing = _write(watch_dir / "RUN1_live.raw", age_seconds=600)
        on_stable = MagicMock()
        on_report_only = MagicMock()
        monitor = FileMonitor(
            watch_directory=watch_dir,
            file_patterns=new_inst.file_patterns,
            stability_period=1,
            on_stable_file=on_stable,
            state_db=state_db,
            report_only=report_only_predicate(old_inst, new_inst, cutoff=time.time()),
            on_report_only_file=on_report_only,
        )
        monitor._initial_scan()
        assert monitor._report_only_paths == {growing}

        with growing.open("a") as fh:
            fh.write("more data\n")
        if noticed_by == "watchdog_event":
            monitor._enqueue(growing)
        else:
            monitor._check_pending()
        _settle(monitor)

        on_stable.assert_called_once_with(growing)
        on_report_only.assert_not_called()

    def test_files_already_in_state_are_skipped(self, watch_dir: Path, state_db: StateDB) -> None:
        old_inst = _inst(watch_dir, ["*.csv"])
        new_inst = _inst(watch_dir, ["*.csv", "*.txt"])
        known = _write(watch_dir / "RUN1_known.txt", age_seconds=600)
        st = known.stat()
        state_db.record_baseline_files([("RUN1_known.txt", st.st_size, st.st_mtime)])
        on_stable = MagicMock()
        on_report_only = MagicMock()
        monitor = FileMonitor(
            watch_directory=watch_dir,
            file_patterns=new_inst.file_patterns,
            stability_period=1,
            on_stable_file=on_stable,
            state_db=state_db,
            report_only=report_only_predicate(old_inst, new_inst, cutoff=time.time()),
            on_report_only_file=on_report_only,
        )

        monitor._initial_scan()
        _settle(monitor)

        on_stable.assert_not_called()
        on_report_only.assert_not_called()

    def test_without_widening_every_file_follows_upload_mode(
        self, watch_dir: Path, state_db: StateDB
    ) -> None:
        _write(watch_dir / "RUN1_a.csv", age_seconds=600)
        on_stable = MagicMock()
        on_report_only = MagicMock()
        monitor = FileMonitor(
            watch_directory=watch_dir,
            file_patterns=["*.csv"],
            stability_period=1,
            on_stable_file=on_stable,
            state_db=state_db,
            on_report_only_file=on_report_only,
        )

        monitor._initial_scan()
        _settle(monitor)

        on_stable.assert_called_once()
        on_report_only.assert_not_called()


class TestDetectorUploadFlag:
    def test_report_only_file_in_reported_run_is_never_uploaded(
        self, watch_dir: Path, state_db: StateDB
    ) -> None:
        client = MagicMock()
        client.report_run.return_value = MagicMock(id="api-run-1")
        uploads: list[list[Any]] = []

        def upload_cb(_run_id: str, files: list[Any]) -> int:
            uploads.append([f.path.name for f in files])
            return len(files)

        cb = MagicMock(side_effect=upload_cb)
        detector = _detector(watch_dir, state_db, cb, client)

        detector.on_stable_file(_write(watch_dir / "RUN1_a.csv"))
        detector.on_stable_file(_write(watch_dir / "RUN1_b.txt"), upload=False)
        detector.on_stable_file(_write(watch_dir / "RUN1_c.csv"))

        assert uploads == [["RUN1_a.csv"], ["RUN1_c.csv"]]
        # All three were reported to the server.
        patched = [
            f["relative_path"]
            for c in client.update_run.call_args_list
            for f in c.args[2]["detected_files"]
        ]
        assert patched == ["RUN1_b.txt", "RUN1_c.csv"]
