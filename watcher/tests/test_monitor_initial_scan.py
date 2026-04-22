"""Unit tests for FileMonitor._initial_scan and StateDB stat-match helpers.

Covers both `StateDB.has_stat_match` (uploaded_files) and
`StateDB.has_detected_stat_match` / `record_detected_files` /
`get_detected_files_for_run` / `get_reported_run_ids_with_files`
(detected_files) — the two tables feed the same initial-scan skip
path.
"""

from __future__ import annotations
import os
from collections.abc import Generator
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from data_hub_watcher.monitor import FileMonitor
from data_hub_watcher.state import StateDB


@pytest.fixture()
def state_db(tmp_path: Path) -> Generator[StateDB, None, None]:
    db = StateDB(tmp_path / "test.db")
    yield db
    db.close()


@pytest.fixture()
def watch_dir(tmp_path: Path) -> Path:
    d = tmp_path / "watch"
    d.mkdir()
    return d


def _make_monitor(
    watch_dir: Path,
    state_db: StateDB,
    *,
    recursive: bool = False,
) -> FileMonitor:
    return FileMonitor(
        watch_directory=watch_dir,
        file_patterns=["*.nd2"],
        stability_period=1,
        on_stable_file=MagicMock(),
        state_db=state_db,
        recursive=recursive,
    )


class TestHasStatMatch:
    def test_match_on_exact_stat(self, state_db: StateDB) -> None:
        state_db.record_upload(
            "sample.nd2",
            "sha-a",
            "s3/sample.nd2",
            relative_path="sample.nd2",
            size_bytes=1024,
            mtime=1_700_000_000.0,
        )

        assert state_db.has_stat_match("sample.nd2", 1024, 1_700_000_000.0) is True

    def test_miss_on_different_size(self, state_db: StateDB) -> None:
        state_db.record_upload(
            "sample.nd2",
            "sha-a",
            "s3/sample.nd2",
            relative_path="sample.nd2",
            size_bytes=1024,
            mtime=1_700_000_000.0,
        )

        assert state_db.has_stat_match("sample.nd2", 2048, 1_700_000_000.0) is False

    def test_miss_on_different_relative_path(self, state_db: StateDB) -> None:
        """Same basename in a different subfolder must NOT match.

        This is the main reason has_stat_match keys on relative path rather
        than basename: two runs that both emit `output.nd2` must each be
        uploaded.
        """
        state_db.record_upload(
            "output.nd2",
            "sha-a",
            "s3/run-a/output.nd2",
            relative_path="run-a/output.nd2",
            size_bytes=1024,
            mtime=1_700_000_000.0,
        )

        assert state_db.has_stat_match("run-b/output.nd2", 1024, 1_700_000_000.0) is False

    def test_mtime_within_tolerance_matches(self, state_db: StateDB) -> None:
        state_db.record_upload(
            "sample.nd2",
            "sha-a",
            "s3/sample.nd2",
            relative_path="sample.nd2",
            size_bytes=1024,
            mtime=1_700_000_000.0,
        )

        assert state_db.has_stat_match("sample.nd2", 1024, 1_700_000_000.5) is True

    def test_mtime_outside_tolerance_misses(self, state_db: StateDB) -> None:
        state_db.record_upload(
            "sample.nd2",
            "sha-a",
            "s3/sample.nd2",
            relative_path="sample.nd2",
            size_bytes=1024,
            mtime=1_700_000_000.0,
        )

        assert state_db.has_stat_match("sample.nd2", 1024, 1_700_000_100.0) is False

    def test_legacy_row_without_stat_misses(self, state_db: StateDB) -> None:
        state_db._conn.execute(
            "INSERT INTO uploaded_files (filename, sha256, uploaded_at, s3_key) "
            "VALUES (?, ?, ?, ?)",
            ("legacy.nd2", "sha-legacy", "2025-01-01T00:00:00+00:00", "s3/legacy.nd2"),
        )
        state_db._conn.commit()

        assert state_db.has_stat_match("legacy.nd2", 512, 1_600_000_000.0) is False


class TestInitialScan:
    def test_skips_file_with_matching_stat(self, state_db: StateDB, watch_dir: Path) -> None:
        f = watch_dir / "seen.nd2"
        f.write_bytes(b"x" * 2048)
        st = f.stat()
        state_db.record_upload(
            "seen.nd2",
            "sha-seen",
            "s3/seen.nd2",
            relative_path="seen.nd2",
            size_bytes=st.st_size,
            mtime=st.st_mtime,
        )

        monitor = _make_monitor(watch_dir, state_db)
        monitor._initial_scan()

        assert f not in monitor._pending

    def test_enqueues_file_with_different_size(self, state_db: StateDB, watch_dir: Path) -> None:
        f = watch_dir / "grew.nd2"
        f.write_bytes(b"x" * 2048)
        st = f.stat()
        state_db.record_upload(
            "grew.nd2",
            "sha-old",
            "s3/grew.nd2",
            relative_path="grew.nd2",
            size_bytes=st.st_size - 1,
            mtime=st.st_mtime,
        )

        monitor = _make_monitor(watch_dir, state_db)
        monitor._initial_scan()

        assert f in monitor._pending

    def test_enqueues_file_with_different_mtime(self, state_db: StateDB, watch_dir: Path) -> None:
        f = watch_dir / "touched.nd2"
        f.write_bytes(b"x" * 2048)
        st = f.stat()
        state_db.record_upload(
            "touched.nd2",
            "sha-old",
            "s3/touched.nd2",
            relative_path="touched.nd2",
            size_bytes=st.st_size,
            mtime=st.st_mtime - 10.0,
        )

        monitor = _make_monitor(watch_dir, state_db)
        monitor._initial_scan()

        assert f in monitor._pending

    def test_enqueues_legacy_record(self, state_db: StateDB, watch_dir: Path) -> None:
        f = watch_dir / "legacy.nd2"
        f.write_bytes(b"x" * 2048)
        state_db._conn.execute(
            "INSERT INTO uploaded_files (filename, sha256, uploaded_at, s3_key) "
            "VALUES (?, ?, ?, ?)",
            ("legacy.nd2", "sha-legacy", "2025-01-01T00:00:00+00:00", "s3/legacy.nd2"),
        )
        state_db._conn.commit()

        monitor = _make_monitor(watch_dir, state_db)
        monitor._initial_scan()

        assert f in monitor._pending

    def test_skips_unmatched_patterns(self, state_db: StateDB, watch_dir: Path) -> None:
        (watch_dir / "readme.txt").write_text("ignore me")
        (watch_dir / "sample.nd2").write_bytes(b"x" * 1024)

        monitor = _make_monitor(watch_dir, state_db)
        monitor._initial_scan()

        assert watch_dir / "sample.nd2" in monitor._pending
        assert watch_dir / "readme.txt" not in monitor._pending

    def test_does_not_read_file_contents(self, state_db: StateDB, watch_dir: Path) -> None:
        """Regression guard: the scan must not open file bodies.

        Chmod a file to 0o000 so any read would fail, then assert the scan
        still enqueues it. Proves the scan is stat-only.
        """
        f = watch_dir / "unreadable.nd2"
        f.write_bytes(b"x" * 1024)
        original_mode = f.stat().st_mode
        os.chmod(f, 0o000)
        try:
            monitor = _make_monitor(watch_dir, state_db)
            monitor._initial_scan()
        finally:
            os.chmod(f, original_mode)

        assert f in monitor._pending

    def test_skips_file_recorded_in_detected_files(
        self, state_db: StateDB, watch_dir: Path
    ) -> None:
        """Initial scan must also honor `detected_files` records.

        In manual mode `uploaded_files` is never populated locally, so
        without this skip path every restart would re-POST / re-PATCH
        the full manifest.
        """
        f = watch_dir / "run-42.nd2"
        f.write_bytes(b"x" * 4096)
        st = f.stat()
        state_db.record_detected_files(
            "run-42",
            [("run-42.nd2", "run-42.nd2", st.st_size, st.st_mtime)],
        )

        monitor = _make_monitor(watch_dir, state_db)
        monitor._initial_scan()

        assert f not in monitor._pending

    def test_skips_union_of_uploaded_and_detected(self, state_db: StateDB, watch_dir: Path) -> None:
        uploaded = watch_dir / "uploaded.nd2"
        detected = watch_dir / "detected.nd2"
        fresh = watch_dir / "fresh.nd2"
        for p in (uploaded, detected, fresh):
            p.write_bytes(b"x" * 1024)

        st_up = uploaded.stat()
        state_db.record_upload(
            "uploaded.nd2",
            "sha-up",
            "s3/uploaded.nd2",
            relative_path="uploaded.nd2",
            size_bytes=st_up.st_size,
            mtime=st_up.st_mtime,
        )
        st_det = detected.stat()
        state_db.record_detected_files(
            "run-1",
            [("detected.nd2", "detected.nd2", st_det.st_size, st_det.st_mtime)],
        )

        monitor = _make_monitor(watch_dir, state_db)
        monitor._initial_scan()

        assert uploaded not in monitor._pending
        assert detected not in monitor._pending
        assert fresh in monitor._pending

    def test_same_basename_in_different_subdirs_both_enqueued(
        self, state_db: StateDB, watch_dir: Path
    ) -> None:
        """Regression guard for basename collisions in recursive watches.

        Two runs both emit `output.nd2` with identical size and mtime (think
        `cp -p` from one run folder into another). Run-a has been uploaded;
        run-b must still be enqueued because its relative path differs.
        """
        (watch_dir / "run-a").mkdir()
        (watch_dir / "run-b").mkdir()
        a = watch_dir / "run-a" / "output.nd2"
        b = watch_dir / "run-b" / "output.nd2"
        a.write_bytes(b"x" * 2048)
        b.write_bytes(b"x" * 2048)
        os.utime(b, (a.stat().st_atime, a.stat().st_mtime))

        st_a = a.stat()
        state_db.record_upload(
            "output.nd2",
            "sha-a",
            "s3/run-a/output.nd2",
            relative_path="run-a/output.nd2",
            size_bytes=st_a.st_size,
            mtime=st_a.st_mtime,
        )

        monitor = _make_monitor(watch_dir, state_db, recursive=True)
        monitor._initial_scan()

        assert a not in monitor._pending
        assert b in monitor._pending


class TestDetectedFilesApi:
    """Unit tests for the `detected_files` table helpers on `StateDB`."""

    def test_record_and_lookup_roundtrip(self, state_db: StateDB) -> None:
        state_db.record_detected_files(
            "run-1",
            [
                ("a/one.nd2", "one.nd2", 1024, 1_700_000_000.0),
                ("a/two.nd2", "two.nd2", 2048, 1_700_000_001.0),
            ],
        )

        records = state_db.get_detected_files_for_run("run-1")
        assert [(r.relative_path, r.filename, r.size_bytes, r.mtime) for r in records] == [
            ("a/one.nd2", "one.nd2", 1024, 1_700_000_000.0),
            ("a/two.nd2", "two.nd2", 2048, 1_700_000_001.0),
        ]

    def test_record_is_idempotent_upsert(self, state_db: StateDB) -> None:
        """Re-recording the same (run_id, relative_path) must upsert, not dup."""
        state_db.record_detected_files("run-1", [("a.nd2", "a.nd2", 1024, 1_700_000_000.0)])
        state_db.record_detected_files("run-1", [("a.nd2", "a.nd2", 2048, 1_700_000_050.0)])

        records = state_db.get_detected_files_for_run("run-1")
        assert len(records) == 1
        assert records[0].size_bytes == 2048
        assert records[0].mtime == pytest.approx(1_700_000_050.0)

    def test_record_empty_iterable_is_noop(self, state_db: StateDB) -> None:
        state_db.record_detected_files("run-empty", [])
        assert state_db.get_detected_files_for_run("run-empty") == []
        assert state_db.get_reported_run_ids_with_files() == []

    def test_has_detected_stat_match_hit(self, state_db: StateDB) -> None:
        state_db.record_detected_files("run-1", [("x.nd2", "x.nd2", 1024, 1_700_000_000.0)])
        assert state_db.has_detected_stat_match("x.nd2", 1024, 1_700_000_000.0) is True

    def test_has_detected_stat_match_respects_mtime_tolerance(self, state_db: StateDB) -> None:
        state_db.record_detected_files("run-1", [("x.nd2", "x.nd2", 1024, 1_700_000_000.0)])
        assert state_db.has_detected_stat_match("x.nd2", 1024, 1_700_000_000.5) is True
        assert state_db.has_detected_stat_match("x.nd2", 1024, 1_700_000_100.0) is False

    def test_has_detected_stat_match_miss_on_different_path(self, state_db: StateDB) -> None:
        state_db.record_detected_files(
            "run-a", [("run-a/out.nd2", "out.nd2", 1024, 1_700_000_000.0)]
        )
        assert state_db.has_detected_stat_match("run-b/out.nd2", 1024, 1_700_000_000.0) is False

    def test_get_reported_run_ids_with_files_distinct_and_scoped(self, state_db: StateDB) -> None:
        state_db.record_detected_files(
            "run-1",
            [
                ("run-1/a.nd2", "a.nd2", 1, 1_700_000_000.0),
                ("run-1/b.nd2", "b.nd2", 2, 1_700_000_001.0),
            ],
        )
        state_db.record_detected_files("run-2", [("run-2/a.nd2", "a.nd2", 3, 1_700_000_002.0)])
        state_db.record_run_reported("run-legacy")

        ids = state_db.get_reported_run_ids_with_files()

        assert ids == ["run-1", "run-2"]
        assert "run-legacy" not in ids
