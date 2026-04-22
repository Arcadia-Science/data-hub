"""Unit tests for `RunDetector.hydrate_from_state_db` and downstream PATCH behavior.

These tests pin down the core guarantee of the "skip reported files"
change: on watcher restart, a previously-reported run must be
reconstructed in memory from the local state DB so that any
subsequently-stabilised file for that run triggers a PATCH
(`_update_run`) rather than a duplicate POST (`_report_new_run`).
"""

from __future__ import annotations
from collections.abc import Generator
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from data_hub_watcher.run_detector import RunDetector
from data_hub_watcher.state import StateDB


@pytest.fixture()
def state_db(tmp_path: Path) -> Generator[StateDB, None, None]:
    db = StateDB(tmp_path / "state.db")
    yield db
    db.close()


@pytest.fixture()
def watch_dir(tmp_path: Path) -> Path:
    d = tmp_path / "watch"
    d.mkdir()
    return d


def _make_detector(
    watch_dir: Path,
    state_db: StateDB,
    *,
    client: MagicMock | None = None,
) -> RunDetector:
    return RunDetector(
        pattern=r"^([^/]+)/",
        instrument_id="inst-1",
        watcher_id="watcher-1",
        client=client or MagicMock(),
        state_db=state_db,
        event_reporter=MagicMock(),
        counters=MagicMock(runs_reported=0, errors=0),
        watch_directory=watch_dir,
    )


class TestHydrateFromStateDb:
    def test_populates_runs_with_reported_true(self, state_db: StateDB, watch_dir: Path) -> None:
        state_db.record_detected_files(
            "run-alpha",
            [
                ("run-alpha/a.nd2", "a.nd2", 1024, 1_700_000_000.0),
                ("run-alpha/b.nd2", "b.nd2", 2048, 1_700_000_001.0),
            ],
        )

        detector = _make_detector(watch_dir, state_db)
        detector.hydrate_from_state_db()

        assert "run-alpha" in detector._runs
        run = detector._runs["run-alpha"]
        assert run.reported is True
        assert run.uploaded_file_count == 2
        paths = [f.path for f in run.files]
        assert paths == [
            watch_dir / "run-alpha/a.nd2",
            watch_dir / "run-alpha/b.nd2",
        ]
        assert run.files[0].size_bytes == 1024
        assert run.files[0].mtime == pytest.approx(1_700_000_000.0)

    def test_skips_runs_without_detected_files(self, state_db: StateDB, watch_dir: Path) -> None:
        """Legacy runs (in `runs` but not `detected_files`) must not hydrate.

        The upgrade path is: such runs fall through to the pre-hydration
        code path exactly once, re-report, record their manifest, and
        future restarts will skip them.
        """
        state_db.record_run_reported("run-legacy")

        detector = _make_detector(watch_dir, state_db)
        detector.hydrate_from_state_db()

        assert detector._runs == {}

    def test_hydration_is_idempotent(self, state_db: StateDB, watch_dir: Path) -> None:
        state_db.record_detected_files("run-1", [("run-1/a.nd2", "a.nd2", 10, 1_700_000_000.0)])

        detector = _make_detector(watch_dir, state_db)
        detector.hydrate_from_state_db()
        detector.hydrate_from_state_db()

        assert list(detector._runs.keys()) == ["run-1"]
        assert len(detector._runs["run-1"].files) == 1

    def test_retry_unreported_runs_skips_hydrated_runs(
        self, state_db: StateDB, watch_dir: Path
    ) -> None:
        state_db.record_detected_files("run-1", [("run-1/a.nd2", "a.nd2", 10, 1_700_000_000.0)])

        client = MagicMock()
        detector = _make_detector(watch_dir, state_db, client=client)
        detector.hydrate_from_state_db()
        detector.retry_unreported_runs()

        client.report_run.assert_not_called()


class TestNewFileAfterHydrationTriggersPatch:
    def test_new_file_patches_instead_of_posting(self, state_db: StateDB, watch_dir: Path) -> None:
        """Regression guard for the "re-POST on restart" bug.

        Pre-fix, `_runs` was empty on restart so a newly-stabilised file
        for an already-reported run triggered a POST. Post-fix, the
        hydrated `RunState` routes it through `_update_run` (PATCH).
        """
        (watch_dir / "run-42").mkdir()
        existing = watch_dir / "run-42" / "existing.nd2"
        existing.write_bytes(b"x" * 1024)
        st = existing.stat()
        state_db.record_detected_files(
            "run-42",
            [("run-42/existing.nd2", "existing.nd2", st.st_size, st.st_mtime)],
        )

        client = MagicMock()
        client.update_run.return_value = MagicMock(id="api-run-42")
        detector = _make_detector(watch_dir, state_db, client=client)
        detector.hydrate_from_state_db()

        new_file = watch_dir / "run-42" / "new.nd2"
        new_file.write_bytes(b"y" * 2048)
        detector.on_stable_file(new_file)

        client.report_run.assert_not_called()
        client.update_run.assert_called_once()
        args, _kwargs = client.update_run.call_args
        assert args[0] == "inst-1"
        assert args[1] == "run-42"
        payload = args[2]
        rel_paths = [f["relative_path"] for f in payload["detected_files"]]
        assert "run-42/existing.nd2" in rel_paths
        assert "run-42/new.nd2" in rel_paths

    def test_update_run_persists_new_manifest(self, state_db: StateDB, watch_dir: Path) -> None:
        """After a successful PATCH the new file is recorded in `detected_files`."""
        (watch_dir / "run-7").mkdir()
        existing = watch_dir / "run-7" / "a.nd2"
        existing.write_bytes(b"x" * 1024)
        st = existing.stat()
        state_db.record_detected_files("run-7", [("run-7/a.nd2", "a.nd2", st.st_size, st.st_mtime)])

        client = MagicMock()
        detector = _make_detector(watch_dir, state_db, client=client)
        detector.hydrate_from_state_db()

        new_file = watch_dir / "run-7" / "b.nd2"
        new_file.write_bytes(b"y" * 512)
        detector.on_stable_file(new_file)

        rel_paths = {r.relative_path for r in state_db.get_detected_files_for_run("run-7")}
        assert rel_paths == {"run-7/a.nd2", "run-7/b.nd2"}


class TestReportNewRunPersistsManifest:
    def test_successful_post_records_detected_files(
        self, state_db: StateDB, watch_dir: Path
    ) -> None:
        client = MagicMock()
        client.report_run.return_value = MagicMock(id="api-run-id")
        detector = _make_detector(watch_dir, state_db, client=client)

        (watch_dir / "run-new").mkdir()
        f = watch_dir / "run-new" / "first.nd2"
        f.write_bytes(b"z" * 42)
        detector.on_stable_file(f)

        records = state_db.get_detected_files_for_run("run-new")
        assert [r.relative_path for r in records] == ["run-new/first.nd2"]
        assert records[0].filename == "first.nd2"
        assert records[0].size_bytes == 42

    def test_manifest_not_recorded_if_post_fails(self, state_db: StateDB, watch_dir: Path) -> None:
        from data_hub_watcher.api_client import ApiError

        client = MagicMock()
        client.report_run.side_effect = ApiError("boom", 500)
        detector = _make_detector(watch_dir, state_db, client=client)

        (watch_dir / "run-fail").mkdir()
        f = watch_dir / "run-fail" / "first.nd2"
        f.write_bytes(b"z" * 42)
        detector.on_stable_file(f)

        assert state_db.get_detected_files_for_run("run-fail") == []
        assert state_db.get_reported_run_ids_with_files() == []
