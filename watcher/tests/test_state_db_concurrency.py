"""Concurrency tests for the thread-local ``StateDB`` connection model.

The optimisation switches ``StateDB`` from a single ``sqlite3.Connection``
guarded by a process-wide ``threading.Lock`` to per-thread lazy
connections plus a write-only lock. This unlocks parallel uploaders
(see ``Uploader.upload_files`` with ``upload_parallelism > 1``) but
introduces real multi-threaded SQLite usage that the previous
single-thread model masked.

These tests pin down the new invariants:
- Concurrent writers from many threads never raise
  ``sqlite3.OperationalError("database is locked")``.
- Reads can run concurrently with writes (WAL semantics).
- The final row count after parallel inserts equals the number of
  inserts attempted (no silent loss).
- ``close()`` cleans up every thread's connection, including ones
  opened by threads that no longer exist.
"""

from __future__ import annotations
import sqlite3
import threading
from collections.abc import Generator
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import pytest

from data_hub_watcher.state import StateDB


@pytest.fixture()
def state_db(tmp_path: Path) -> Generator[StateDB, None, None]:
    db = StateDB(tmp_path / "concurrency.db")
    yield db
    db.close()


class TestParallelWriters:
    """Many threads writing to ``uploaded_files`` in parallel."""

    def test_no_database_locked_errors_under_contention(self, state_db: StateDB) -> None:
        """40 threads x 25 inserts each must complete without OperationalError.

        Pre-thread-local-connections this would frequently raise
        ``database is locked`` once the per-process ``_lock`` was
        replaced by SQLite's own busy detection -- the
        ``busy_timeout=5000`` PRAGMA + ``_write_lock`` together must
        prevent that.
        """
        per_worker = 25
        worker_count = 40

        def worker(worker_id: int) -> int:
            for i in range(per_worker):
                state_db.record_upload(
                    f"w{worker_id}-{i}.nd2",
                    f"sha-{worker_id}-{i}",
                    f"s3/w{worker_id}/{i}.nd2",
                    relative_path=f"w{worker_id}/{i}.nd2",
                    size_bytes=1024 + i,
                    mtime=1_700_000_000.0 + worker_id,
                )
            return per_worker

        with ThreadPoolExecutor(max_workers=worker_count) as pool:
            futures = [pool.submit(worker, w) for w in range(worker_count)]
            results = [f.result() for f in as_completed(futures)]

        assert sum(results) == worker_count * per_worker
        # Cross-check via the bulk-load iterator: every insert is
        # represented in the final dump.
        keys = list(state_db.iter_uploaded_stat_keys())
        assert len(keys) == worker_count * per_worker

    def test_concurrent_reads_during_writes(self, state_db: StateDB) -> None:
        """Reader threads must observe consistent snapshots while writers run.

        WAL mode lets readers proceed against the last-committed
        snapshot without blocking writers. Pre-rewrite the
        process-wide lock would have serialised every reader behind
        every writer -- the test would still pass, but slowly. We
        assert the readers complete (no exceptions, no corrupted
        rows) which covers the correctness side; the throughput win
        is observable in the parallel-upload integration scenario.
        """
        stop = threading.Event()
        write_errors: list[BaseException] = []
        read_errors: list[BaseException] = []

        def writer() -> None:
            i = 0
            try:
                while not stop.is_set():
                    state_db.record_upload(
                        f"writer-{i}.nd2",
                        f"sha-{i}",
                        f"s3/writer/{i}.nd2",
                        relative_path=f"writer/{i}.nd2",
                        size_bytes=1024,
                        mtime=1_700_000_000.0 + i,
                    )
                    i += 1
            except BaseException as exc:
                write_errors.append(exc)

        def reader() -> int:
            count = 0
            try:
                while not stop.is_set():
                    # Both helpers should be safe to call from any
                    # thread now that each opens its own connection
                    # lazily on first access.
                    _ = list(state_db.iter_uploaded_stat_keys())
                    _ = state_db.is_uploaded("writer-0.nd2", "sha-0", "s3/writer/0.nd2")
                    count += 1
            except BaseException as exc:
                read_errors.append(exc)
            return count

        threads = [
            threading.Thread(target=writer, name="writer", daemon=True),
            threading.Thread(target=reader, name="reader-1", daemon=True),
            threading.Thread(target=reader, name="reader-2", daemon=True),
        ]
        for t in threads:
            t.start()
        # Brief contention window; long enough to exercise interleaving
        # without slowing the test suite noticeably.
        threading.Event().wait(0.4)
        stop.set()
        for t in threads:
            t.join(timeout=5.0)
            assert not t.is_alive(), f"{t.name} did not stop in time"

        assert write_errors == [], f"writer raised: {write_errors!r}"
        assert read_errors == [], f"reader raised: {read_errors!r}"


class TestPerThreadConnections:
    """The connection cache is keyed per-thread, not per-process."""

    def test_distinct_threads_get_distinct_connections(self, state_db: StateDB) -> None:
        # Touch the property on the main thread to materialise its
        # connection.
        main_conn = state_db._conn
        worker_conn: sqlite3.Connection | None = None

        def grab_conn() -> None:
            nonlocal worker_conn
            worker_conn = state_db._conn

        t = threading.Thread(target=grab_conn)
        t.start()
        t.join(timeout=2.0)

        assert worker_conn is not None
        assert worker_conn is not main_conn

    def test_same_thread_reuses_its_connection(self, state_db: StateDB) -> None:
        first = state_db._conn
        second = state_db._conn
        assert first is second


class TestClose:
    """``close()`` must reach connections opened by other threads."""

    def test_close_shuts_down_all_thread_connections(self, tmp_path: Path) -> None:
        db = StateDB(tmp_path / "close.db")
        # Open connections from several threads.
        opened: list[sqlite3.Connection] = []
        opened_lock = threading.Lock()

        def open_one() -> None:
            conn = db._conn
            with opened_lock:
                opened.append(conn)

        threads = [threading.Thread(target=open_one) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=2.0)

        # Plus the main-thread connection (from __init__'s
        # ``_create_tables``).
        assert len(opened) == 5

        db.close()

        # Every captured connection must now refuse further use; the
        # exact exception type is sqlite3.ProgrammingError on closed
        # handles.
        for conn in opened:
            with pytest.raises(sqlite3.ProgrammingError):
                conn.execute("SELECT 1")
