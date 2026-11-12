"""`StateDB.record_report`: what an accepted run report leaves behind, all or nothing.

Auto mode retries a file at the next start only if it has a `pending_uploads` row, and the
initial scan skips it if it has a `detected_files` row. A file with the second and not the
first is never uploaded, so the run, its manifest and its pending rows are written in one
transaction.
"""

from __future__ import annotations
import sqlite3
import threading
from collections.abc import Generator
from pathlib import Path

import pytest

from data_hub_watcher.state import StateDB


@pytest.fixture()
def db(tmp_path: Path) -> Generator[StateDB, None, None]:
    state_db = StateDB(tmp_path / "state.db")
    yield state_db
    state_db.close()


def _manifest(*names: str) -> list[tuple[str, str, int, float, float | None]]:
    return [(f"run/{name}", name, 10, 1_700_000_000.0, 1_699_999_000.0) for name in names]


def _refuse_pending_rows(db: StateDB) -> None:
    """Make every insert into `pending_uploads` fail, as a write that can't be made does.

    ``RAISE(ABORT)`` ends only the statement, which is the case where a transaction the
    caller doesn't end is left open on the connection.
    """
    db._conn.execute(
        "CREATE TRIGGER refuse_pending BEFORE INSERT ON pending_uploads "
        "BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END"
    )
    db._conn.commit()


def test_writes_the_run_the_manifest_and_the_pending_rows(db: StateDB) -> None:
    db.record_report(
        "run",
        _manifest("a.csv", "b.csv"),
        new_run=True,
        pending_relative_paths=["run/a.csv", "run/b.csv"],
    )

    run = db.get_run("run")
    assert run is not None and run.uploaded_at is None
    assert [r.relative_path for r in db.get_detected_files_for_run("run")] == [
        "run/a.csv",
        "run/b.csv",
    ]
    assert [(p.relative_path, p.run_id, p.attempts) for p in db.pending_uploads()] == [
        ("run/a.csv", "run", 0),
        ("run/b.csv", "run", 0),
    ]


def test_without_pending_paths_it_writes_no_pending_rows(db: StateDB) -> None:
    # Manual mode, and report-only files in auto mode.
    db.record_report("run", _manifest("a.csv"), new_run=True)

    assert db.get_run("run") is not None
    assert [r.relative_path for r in db.get_detected_files_for_run("run")] == ["run/a.csv"]
    assert db.pending_uploads() == []


def test_a_later_report_leaves_the_run_row_alone(db: StateDB) -> None:
    db.record_report("run", _manifest("a.csv"), new_run=True)
    db.record_run_uploaded("run")
    before = db.get_run("run")

    db.record_report(
        "run", _manifest("a.csv", "b.csv"), new_run=False, pending_relative_paths=["run/b.csv"]
    )

    assert db.get_run("run") == before
    assert [r.relative_path for r in db.get_detected_files_for_run("run")] == [
        "run/a.csv",
        "run/b.csv",
    ]
    assert [p.relative_path for p in db.pending_uploads()] == ["run/b.csv"]


def test_a_file_that_is_pending_already_keeps_its_attempt_count(db: StateDB) -> None:
    db.record_report("run", _manifest("a.csv"), new_run=True, pending_relative_paths=["run/a.csv"])
    assert db.bump_pending_upload_attempts("run/a.csv") == 1

    db.record_report("run", _manifest("a.csv"), new_run=False, pending_relative_paths=["run/a.csv"])

    assert [p.attempts for p in db.pending_uploads()] == [1]


def test_a_write_that_fails_leaves_nothing_behind(db: StateDB) -> None:
    _refuse_pending_rows(db)

    with pytest.raises(sqlite3.IntegrityError, match="database or disk is full"):
        db.record_report(
            "run", _manifest("a.csv"), new_run=True, pending_relative_paths=["run/a.csv"]
        )

    assert db.get_run("run") is None
    assert db.get_detected_files_for_run("run") == []
    assert db.pending_uploads() == []
    # The rows written before the failing one aren't waiting in an open transaction, for
    # the next write on this thread to commit with its own.
    assert not db._conn.in_transaction
    db.set_meta("unrelated", "write")
    assert db.get_run("run") is None
    assert db.get_detected_files_for_run("run") == []


def test_a_failed_report_does_not_undo_an_earlier_one(db: StateDB) -> None:
    db.record_report("run", _manifest("a.csv"), new_run=True, pending_relative_paths=["run/a.csv"])
    _refuse_pending_rows(db)

    with pytest.raises(sqlite3.IntegrityError):
        db.record_report(
            "run", _manifest("a.csv", "b.csv"), new_run=False, pending_relative_paths=["run/b.csv"]
        )

    assert [r.relative_path for r in db.get_detected_files_for_run("run")] == ["run/a.csv"]
    assert [p.relative_path for p in db.pending_uploads()] == ["run/a.csv"]


def test_a_reader_never_sees_part_of_a_report(db: StateDB) -> None:
    """Other threads, and a process that is killed, see a whole report or none of it."""
    files = 5
    writers = 4
    reports_each = 25
    errors: list[str] = []
    stop = threading.Event()

    def reader() -> None:
        # One statement is one snapshot, so a run row is either complete or absent.
        sql = (
            "SELECT run_id, "
            "(SELECT count(*) FROM detected_files d WHERE d.run_id = runs.run_id), "
            "(SELECT count(*) FROM pending_uploads p WHERE p.run_id = runs.run_id) FROM runs"
        )
        while not stop.is_set():
            for run_id, detected, pending in db._conn.execute(sql).fetchall():
                if (detected, pending) != (files, files):
                    errors.append(f"{run_id}: {detected} detected, {pending} pending")

    def writer(writer_id: int) -> None:
        for n in range(reports_each):
            run_id = f"w{writer_id}-r{n}"
            paths = [f"{run_id}/f{i}.csv" for i in range(files)]
            rows = [(path, path.rsplit("/", 1)[1], 1, 1.0, None) for path in paths]
            db.record_report(run_id, rows, new_run=True, pending_relative_paths=paths)

    reader_thread = threading.Thread(target=reader)
    reader_thread.start()
    threads = [threading.Thread(target=writer, args=(w,)) for w in range(writers)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    stop.set()
    reader_thread.join(timeout=10)

    assert errors == []
    assert len(db.pending_uploads()) == writers * reports_each * files
