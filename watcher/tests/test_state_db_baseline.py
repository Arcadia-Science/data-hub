"""Tests for the `baseline_files` and `meta` tables on `StateDB`."""

from __future__ import annotations
from collections.abc import Generator
from pathlib import Path

import pytest

from data_hub_watcher.state import StateDB


@pytest.fixture()
def state_db(tmp_path: Path) -> Generator[StateDB, None, None]:
    db = StateDB(tmp_path / "test.db")
    yield db
    db.close()


class TestBaselineFiles:
    def test_record_and_iter_roundtrip(self, state_db: StateDB) -> None:
        state_db.record_baseline_files(
            [("a/one.csv", 1024, 1_700_000_000.0), ("b/two.csv", 2048, 1_700_000_001.0)]
        )
        assert sorted(state_db.iter_baseline_stat_keys()) == [
            ("a/one.csv", 1024, 1_700_000_000.0),
            ("b/two.csv", 2048, 1_700_000_001.0),
        ]

    def test_record_empty_is_noop(self, state_db: StateDB) -> None:
        state_db.record_baseline_files([])
        assert list(state_db.iter_baseline_stat_keys()) == []

    def test_established_false_on_empty_db(self, state_db: StateDB) -> None:
        assert state_db.baseline_established() is False

    def test_established_true_with_baseline_rows(self, state_db: StateDB) -> None:
        state_db.record_baseline_files([("a.csv", 1, 1.0)])
        assert state_db.baseline_established() is True

    def test_established_true_with_upload_history(self, state_db: StateDB) -> None:
        state_db.record_upload(
            "a.csv", "sha", "s3/a.csv", relative_path="a.csv", size_bytes=1, mtime=1.0
        )
        assert state_db.baseline_established() is True

    def test_established_true_with_detected_history(self, state_db: StateDB) -> None:
        state_db.record_detected_files("run-1", [("a.csv", "a.csv", 1, 1.0, None)])
        assert state_db.baseline_established() is True

    def test_baseline_survives_prune(self, state_db: StateDB) -> None:
        # The backlog must stay skipped forever; unlike `uploaded_files`,
        # `baseline_files` is never pruned.
        state_db.record_baseline_files([("a.csv", 1, 1.0)])
        state_db.prune_uploaded_files(days=0)
        assert list(state_db.iter_baseline_stat_keys()) == [("a.csv", 1, 1.0)]

    def test_mark_baseline_seeded_establishes_without_rows(self, state_db: StateDB) -> None:
        # The sentinel makes the one-shot seed gate hold for an empty watch dir
        # (zero matched files) so the tree isn't re-walked on every start.
        assert state_db.baseline_established() is False
        state_db.mark_baseline_seeded()
        assert state_db.baseline_established() is True
        assert list(state_db.iter_baseline_stat_keys()) == []


class TestMeta:
    def test_get_missing_returns_none(self, state_db: StateDB) -> None:
        assert state_db.get_meta("preview_api_base_url") is None

    def test_set_then_get(self, state_db: StateDB) -> None:
        state_db.set_meta("preview_api_base_url", "https://x.example/api/v1")
        assert state_db.get_meta("preview_api_base_url") == "https://x.example/api/v1"

    def test_set_overwrites(self, state_db: StateDB) -> None:
        state_db.set_meta("k", "v1")
        state_db.set_meta("k", "v2")
        assert state_db.get_meta("k") == "v2"
