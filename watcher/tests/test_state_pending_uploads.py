"""`StateDB.pending_uploads`: auto-mode uploads the next start should retry."""

from __future__ import annotations
from collections.abc import Generator
from pathlib import Path

import pytest

from data_hub_watcher.state import StateDB


@pytest.fixture()
def db(tmp_path: Path) -> Generator[StateDB, None, None]:
    state_db = StateDB(tmp_path / "state.db")
    yield state_db
    state_db.close()


def test_lists_rows_oldest_first_and_clears_one(db: StateDB) -> None:
    db.record_pending_uploads("run-b", ["run-b/z.tif"])
    db.record_pending_uploads("run-a", ["run-a/a.tif", "run-a/b.tif"])

    assert [(p.relative_path, p.run_id, p.attempts) for p in db.pending_uploads()] == [
        ("run-b/z.tif", "run-b", 0),
        ("run-a/a.tif", "run-a", 0),
        ("run-a/b.tif", "run-a", 0),
    ]

    db.clear_pending_upload("run-a/a.tif")

    assert [p.relative_path for p in db.pending_uploads()] == ["run-b/z.tif", "run-a/b.tif"]


def test_recording_a_file_again_keeps_its_attempt_count(db: StateDB) -> None:
    db.record_pending_uploads("run", ["run/a.tif"])
    assert db.bump_pending_upload_attempts("run/a.tif") == 1

    # The auto path can hand the same file over again within one session.
    db.record_pending_uploads("run", ["run/a.tif"])

    assert db.bump_pending_upload_attempts("run/a.tif") == 2


def test_bumping_a_missing_row_returns_zero(db: StateDB) -> None:
    assert db.bump_pending_upload_attempts("never/recorded.tif") == 0


def test_record_upload_clears_the_pending_row(db: StateDB) -> None:
    db.record_pending_uploads("run", ["run/a.tif", "run/b.tif"])

    db.record_upload(
        "a.tif",
        "sha",
        "instrument/run/a.tif",
        relative_path="run/a.tif",
        size_bytes=1,
        mtime=1.0,
    )

    assert [p.relative_path for p in db.pending_uploads()] == ["run/b.tif"]
