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

from data_hub_watcher.monitor import FileMonitor, _stat_in_dedup_index
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
            [("run-42.nd2", "run-42.nd2", st.st_size, st.st_mtime, st.st_mtime)],
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
            [
                (
                    "detected.nd2",
                    "detected.nd2",
                    st_det.st_size,
                    st_det.st_mtime,
                    st_det.st_mtime,
                )
            ],
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
                ("a/one.nd2", "one.nd2", 1024, 1_700_000_000.0, 1_699_999_900.0),
                ("a/two.nd2", "two.nd2", 2048, 1_700_000_001.0, None),
            ],
        )

        records = state_db.get_detected_files_for_run("run-1")
        assert [
            (r.relative_path, r.filename, r.size_bytes, r.mtime, r.file_created_at) for r in records
        ] == [
            ("a/one.nd2", "one.nd2", 1024, 1_700_000_000.0, 1_699_999_900.0),
            ("a/two.nd2", "two.nd2", 2048, 1_700_000_001.0, None),
        ]

    def test_record_is_idempotent_upsert(self, state_db: StateDB) -> None:
        """Re-recording the same (run_id, relative_path) must upsert, not dup."""
        state_db.record_detected_files(
            "run-1", [("a.nd2", "a.nd2", 1024, 1_700_000_000.0, 1_700_000_000.0)]
        )
        state_db.record_detected_files(
            "run-1", [("a.nd2", "a.nd2", 2048, 1_700_000_050.0, 1_700_000_000.0)]
        )

        records = state_db.get_detected_files_for_run("run-1")
        assert len(records) == 1
        assert records[0].size_bytes == 2048
        assert records[0].mtime == pytest.approx(1_700_000_050.0)

    def test_record_empty_iterable_is_noop(self, state_db: StateDB) -> None:
        state_db.record_detected_files("run-empty", [])
        assert state_db.get_detected_files_for_run("run-empty") == []
        assert state_db.get_reported_run_ids_with_files() == []

    def test_has_detected_stat_match_hit(self, state_db: StateDB) -> None:
        state_db.record_detected_files(
            "run-1", [("x.nd2", "x.nd2", 1024, 1_700_000_000.0, 1_700_000_000.0)]
        )
        assert state_db.has_detected_stat_match("x.nd2", 1024, 1_700_000_000.0) is True

    def test_has_detected_stat_match_respects_mtime_tolerance(self, state_db: StateDB) -> None:
        state_db.record_detected_files(
            "run-1", [("x.nd2", "x.nd2", 1024, 1_700_000_000.0, 1_700_000_000.0)]
        )
        assert state_db.has_detected_stat_match("x.nd2", 1024, 1_700_000_000.5) is True
        assert state_db.has_detected_stat_match("x.nd2", 1024, 1_700_000_100.0) is False

    def test_has_detected_stat_match_miss_on_different_path(self, state_db: StateDB) -> None:
        state_db.record_detected_files(
            "run-a", [("run-a/out.nd2", "out.nd2", 1024, 1_700_000_000.0, 1_700_000_000.0)]
        )
        assert state_db.has_detected_stat_match("run-b/out.nd2", 1024, 1_700_000_000.0) is False

    def test_get_reported_run_ids_with_files_distinct_and_scoped(self, state_db: StateDB) -> None:
        state_db.record_detected_files(
            "run-1",
            [
                ("run-1/a.nd2", "a.nd2", 1, 1_700_000_000.0, 1_700_000_000.0),
                ("run-1/b.nd2", "b.nd2", 2, 1_700_000_001.0, 1_700_000_001.0),
            ],
        )
        state_db.record_detected_files(
            "run-2", [("run-2/a.nd2", "a.nd2", 3, 1_700_000_002.0, 1_700_000_002.0)]
        )
        state_db.record_run_reported("run-legacy")

        ids = state_db.get_reported_run_ids_with_files()

        assert ids == ["run-1", "run-2"]
        assert "run-legacy" not in ids


class TestBulkLoadIterators:
    """The new bulk-load helpers backing the rewritten initial scan.

    These are what let the scan replace the old per-file
    ``has_stat_match`` / ``has_detected_stat_match`` SELECTs with a
    single SELECT per table. The scan-level test below proves we
    actually use them; these tests pin down the iterator semantics
    in isolation.
    """

    def test_iter_uploaded_stat_keys_excludes_legacy_rows(self, state_db: StateDB) -> None:
        # Real row with stat columns populated.
        state_db.record_upload(
            "fresh.nd2",
            "sha-fresh",
            "s3/fresh.nd2",
            relative_path="fresh.nd2",
            size_bytes=1024,
            mtime=1_700_000_000.0,
        )
        # Legacy row predating the stat columns -- relative_path is NULL.
        # Bulk loaders must skip these so the in-memory dedup index
        # never contains entries that can't possibly match a scanned file.
        state_db._conn.execute(
            "INSERT INTO uploaded_files (filename, sha256, uploaded_at, s3_key) "
            "VALUES (?, ?, ?, ?)",
            ("legacy.nd2", "sha-legacy", "2025-01-01T00:00:00+00:00", "s3/legacy.nd2"),
        )
        state_db._conn.commit()

        keys = list(state_db.iter_uploaded_stat_keys())
        assert keys == [("fresh.nd2", 1024, 1_700_000_000.0)]

    def test_iter_detected_stat_keys_returns_all_present_rows(self, state_db: StateDB) -> None:
        state_db.record_detected_files(
            "run-1",
            [
                ("run-1/a.nd2", "a.nd2", 100, 1.0, None),
                ("run-1/b.nd2", "b.nd2", 200, 2.0, None),
            ],
        )

        keys = sorted(state_db.iter_detected_stat_keys())
        assert keys == [("run-1/a.nd2", 100, 1.0), ("run-1/b.nd2", 200, 2.0)]


class TestStatInDedupIndex:
    """Pure-Python tolerance check used by the scan to skip dedup'd files."""

    def test_exact_match(self) -> None:
        index = {"a.nd2": [(1024, 1_700_000_000.0)]}
        assert _stat_in_dedup_index(index, "a.nd2", 1024, 1_700_000_000.0) is True

    def test_within_mtime_tolerance(self) -> None:
        index = {"a.nd2": [(1024, 1_700_000_000.0)]}
        assert _stat_in_dedup_index(index, "a.nd2", 1024, 1_700_000_000.5) is True

    def test_outside_mtime_tolerance(self) -> None:
        index = {"a.nd2": [(1024, 1_700_000_000.0)]}
        assert _stat_in_dedup_index(index, "a.nd2", 1024, 1_700_000_100.0) is False

    def test_size_mismatch(self) -> None:
        index = {"a.nd2": [(1024, 1_700_000_000.0)]}
        assert _stat_in_dedup_index(index, "a.nd2", 2048, 1_700_000_000.0) is False

    def test_path_not_in_index(self) -> None:
        index = {"a.nd2": [(1024, 1_700_000_000.0)]}
        assert _stat_in_dedup_index(index, "b.nd2", 1024, 1_700_000_000.0) is False

    def test_picks_correct_entry_among_multiple(self) -> None:
        # Same relative path, different (size, mtime) tuples -- the
        # uploaded_files PK is (filename, sha256, s3_key) so the same
        # path can legitimately have multiple rows after a re-upload.
        index = {
            "a.nd2": [
                (1024, 1_700_000_000.0),
                (2048, 1_700_000_500.0),
            ]
        }
        assert _stat_in_dedup_index(index, "a.nd2", 2048, 1_700_000_500.0) is True
        assert _stat_in_dedup_index(index, "a.nd2", 4096, 1_700_000_500.0) is False


class TestInitialScanBulkLoad:
    """Regression guard: the rewritten scan must NOT issue per-file SELECTs.

    The old loop ran ``has_stat_match`` and ``has_detected_stat_match``
    once per file -- on a 50k-file lab tree that's 100k SQL round
    trips through a process-wide lock. The rewrite replaces those with
    one bulk SELECT per table via ``iter_*_stat_keys``.

    We assert the new behaviour by counting how many times those
    helpers are invoked across a 50-file scan. The number must be
    exactly one each, regardless of how many files end up matching or
    being enqueued.
    """

    def test_initial_scan_bulk_loads_exactly_once_per_table(
        self, state_db: StateDB, watch_dir: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        for i in range(50):
            (watch_dir / f"file-{i:03d}.nd2").write_bytes(b"x" * 64)

        # Pre-populate dedup so half the files are skipped -- exercises
        # both the "in index" and "not in index" branches without
        # changing the per-table SELECT count.
        for i in range(0, 50, 2):
            f = watch_dir / f"file-{i:03d}.nd2"
            st = f.stat()
            state_db.record_upload(
                f.name,
                f"sha-{i}",
                f"s3/{f.name}",
                relative_path=f.name,
                size_bytes=st.st_size,
                mtime=st.st_mtime,
            )

        uploaded_calls = 0
        detected_calls = 0
        original_uploaded = state_db.iter_uploaded_stat_keys
        original_detected = state_db.iter_detected_stat_keys

        def counting_uploaded() -> object:
            nonlocal uploaded_calls
            uploaded_calls += 1
            return original_uploaded()

        def counting_detected() -> object:
            nonlocal detected_calls
            detected_calls += 1
            return original_detected()

        monkeypatch.setattr(state_db, "iter_uploaded_stat_keys", counting_uploaded)
        monkeypatch.setattr(state_db, "iter_detected_stat_keys", counting_detected)

        # The per-row helpers (``has_stat_match`` /
        # ``has_detected_stat_match``) must not be touched by the scan
        # any more -- if they are, our claim of "one SELECT per table"
        # is a lie.
        has_stat_calls = 0
        has_detected_calls = 0
        original_has_stat = state_db.has_stat_match
        original_has_detected = state_db.has_detected_stat_match

        def counting_has_stat(*args: object, **kwargs: object) -> bool:
            nonlocal has_stat_calls
            has_stat_calls += 1
            return original_has_stat(*args, **kwargs)  # type: ignore[arg-type]

        def counting_has_detected(*args: object, **kwargs: object) -> bool:
            nonlocal has_detected_calls
            has_detected_calls += 1
            return original_has_detected(*args, **kwargs)  # type: ignore[arg-type]

        monkeypatch.setattr(state_db, "has_stat_match", counting_has_stat)
        monkeypatch.setattr(state_db, "has_detected_stat_match", counting_has_detected)

        monitor = _make_monitor(watch_dir, state_db)
        monitor._initial_scan()

        assert uploaded_calls == 1, f"expected exactly one bulk SELECT, got {uploaded_calls}"
        assert detected_calls == 1, f"expected exactly one bulk SELECT, got {detected_calls}"
        assert has_stat_calls == 0, (
            f"per-row has_stat_match must not be used in the scan, got {has_stat_calls}"
        )
        assert has_detected_calls == 0, (
            f"per-row has_detected_stat_match must not be used, got {has_detected_calls}"
        )
        # And the actual scan output must still be correct: 25 enqueued,
        # 25 skipped (every other file was pre-recorded above).
        assert len(monitor._pending) == 25
