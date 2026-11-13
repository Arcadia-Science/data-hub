"""`StateDB.pending_events`: events the watcher queued and the server hasn't taken yet."""

from __future__ import annotations
import sqlite3
import threading
from collections.abc import Callable, Generator
from pathlib import Path

import pytest

from data_hub_watcher.state import StateDB


@pytest.fixture()
def db(tmp_path: Path) -> Generator[StateDB, None, None]:
    state_db = StateDB(tmp_path / "state.db")
    yield state_db
    state_db.close()


def test_lists_a_watchers_events_oldest_first(db: StateDB) -> None:
    first = db.add_pending_event("w-1", "first")
    db.add_pending_event("w-2", "someone else's")
    second = db.add_pending_event("w-1", "second")

    assert first < second
    assert db.pending_events("w-1") == [(first, "first"), (second, "second")]


def test_deletes_the_events_it_is_given_and_ignores_ids_that_are_gone(db: StateDB) -> None:
    a = db.add_pending_event("w-1", "a")
    b = db.add_pending_event("w-1", "b")
    c = db.add_pending_event("w-1", "c")

    db.delete_pending_events([a, c, 9999])
    db.delete_pending_events([])

    assert db.pending_events("w-1") == [(b, "b")]


def test_ids_are_not_reused_after_the_newest_event_is_deleted(db: StateDB) -> None:
    first = db.add_pending_event("w-1", "first")
    db.delete_pending_events([first])

    assert db.add_pending_event("w-1", "second") > first


def test_deletes_only_the_events_of_other_watchers(db: StateDB) -> None:
    mine = db.add_pending_event("w-1", "mine")
    db.add_pending_event("w-old", "old registration")
    db.add_pending_event("w-other", "another")

    assert db.delete_pending_events_of_other_watchers("w-1") == 2

    assert db.pending_events("w-1") == [(mine, "mine")]
    assert db.pending_events("w-old") == []
    assert db.delete_pending_events_of_other_watchers("w-1") == 0


@pytest.mark.parametrize(
    ("statement", "write"),
    [
        ("INSERT", lambda db: db.add_pending_event("w-1", "new")),
        ("DELETE", lambda db: db.delete_pending_events([1])),
        ("DELETE", lambda db: db.delete_pending_events_of_other_watchers("w-other")),
    ],
    ids=["add", "delete", "delete-of-other-watchers"],
)
def test_a_write_that_fails_does_not_leave_a_transaction_open(
    db: StateDB, statement: str, write: Callable[[StateDB], object]
) -> None:
    db.add_pending_event("w-1", "kept")
    # `RAISE(ABORT)` ends only the statement, which is the case where a transaction the caller
    # doesn't end stays open on the connection, holding the write lock and waiting for the
    # next write on this thread to commit it.
    db._conn.execute(
        f"CREATE TRIGGER refuse BEFORE {statement} ON pending_events "
        "BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END"
    )
    db._conn.commit()

    with pytest.raises(sqlite3.IntegrityError, match="database or disk is full"):
        write(db)

    assert not db._conn.in_transaction
    assert db.pending_events("w-1") == [(1, "kept")]


def test_events_survive_closing_and_reopening_the_database(tmp_path: Path) -> None:
    path = tmp_path / "state.db"
    first = StateDB(path)
    row = first.add_pending_event("w-1", "kept")
    first.close()

    second = StateDB(path)
    try:
        assert second.pending_events("w-1") == [(row, "kept")]
    finally:
        second.close()


def test_a_database_from_before_the_table_gets_it_without_losing_rows(tmp_path: Path) -> None:
    path = tmp_path / "old.db"
    old = sqlite3.connect(path)
    old.executescript(
        """
        CREATE TABLE runs (run_id TEXT PRIMARY KEY, reported_at TEXT NOT NULL, uploaded_at TEXT);
        INSERT INTO runs VALUES ('RUN001', '2026-01-01T00:00:00+00:00', NULL);
        """
    )
    old.commit()
    old.close()

    db = StateDB(path)
    try:
        assert db.get_run("RUN001") is not None
        assert db.pending_events("w-1") == []
        db.add_pending_event("w-1", "new")
        assert len(db.pending_events("w-1")) == 1
    finally:
        db.close()


def test_events_added_from_many_threads_are_all_kept(db: StateDB) -> None:
    def add(thread: int) -> None:
        for i in range(25):
            db.add_pending_event("w-1", f"{thread}-{i}")

    threads = [threading.Thread(target=add, args=(n,)) for n in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    rows = db.pending_events("w-1")
    assert len(rows) == 200
    assert len({payload for _id, payload in rows}) == 200
    # Each thread's own events keep their order.
    for thread_no in range(8):
        own = [payload for _id, payload in rows if payload.startswith(f"{thread_no}-")]
        assert own == [f"{thread_no}-{i}" for i in range(25)]
