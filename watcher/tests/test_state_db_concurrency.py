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
import gc
import sqlite3
import threading
import weakref
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


class TestThreadDeathReclamation:
    """Connections owned by terminated threads must be reaped.

    The optimisation spawns a fresh ``ThreadPoolExecutor`` per upload
    batch; each worker opens its own ``sqlite3.Connection`` on first
    StateDB access. Without lifecycle plumbing those handles would
    pile up in ``StateDB._connections`` (and in the kernel FD table)
    for the entire watcher process lifetime -- hours-to-days on a
    busy lab PC. The per-thread ``weakref.finalize`` callback in
    ``StateDB._conn`` is what prevents that. These tests pin its
    behaviour.
    """

    def test_connections_are_dropped_when_owning_thread_dies(self, state_db: StateDB) -> None:
        """After short-lived workers exit, only the main thread's handle remains.

        We open one ``StateDB`` connection per worker (the workers
        write a row so the handle is fully materialised), join the
        workers, then drive the GC. The watcher's ``_connections``
        set must drop back down to just the main-thread connection
        eagerly cached at construction time.
        """
        # Materialise the main thread's connection (already opened by
        # ``_create_tables``, but make the expectation explicit).
        _ = state_db._conn

        def worker(worker_id: int) -> None:
            state_db.record_upload(
                f"tt-{worker_id}.nd2",
                f"sha-tt-{worker_id}",
                f"s3/tt/{worker_id}.nd2",
                relative_path=f"tt/{worker_id}.nd2",
                size_bytes=1024,
                mtime=1_700_000_000.0 + worker_id,
            )

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=5.0)
            assert not t.is_alive()

        # Threading-local data is reclaimed when the thread is joined,
        # but the actual ``_PerThreadHandle`` may still be sitting on
        # the GC's young-generation freelist. A single ``gc.collect``
        # is enough to fire the ``weakref.finalize`` callbacks.
        gc.collect()

        with state_db._connections_lock:
            remaining = set(state_db._connections)

        # Exactly one connection should remain: the main thread's.
        # We don't rely on ``len`` to point at a specific handle --
        # we assert membership against the live main-thread handle so
        # the test stays robust to incidental allocations elsewhere.
        assert state_db._conn in remaining
        assert len(remaining) == 1, (
            f"Expected only the main-thread handle to remain, got {len(remaining)} live connections"
        )

    def test_thread_local_holder_is_garbage_collected_after_thread_dies(
        self, state_db: StateDB
    ) -> None:
        """The per-thread holder is the linchpin of the reaper.

        We weak-ref the holder rather than the connection itself
        because the connection is briefly kept alive by the
        ``weakref.finalize`` callback's closed-over reference. A live
        holder == a still-leaked entry; a dead holder == reaper
        already ran.
        """
        holder_refs: list[weakref.ref[object]] = []
        holder_refs_lock = threading.Lock()

        def worker() -> None:
            _ = state_db._conn
            holder = state_db._local.holder  # type: ignore[attr-defined]
            with holder_refs_lock:
                holder_refs.append(weakref.ref(holder))

        threads = [threading.Thread(target=worker) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=5.0)

        gc.collect()

        live_holders = [ref() for ref in holder_refs if ref() is not None]
        assert live_holders == [], (
            f"Expected all per-thread holders to be GC'd; {len(live_holders)} still alive"
        )

    def test_pool_workers_do_not_leak_handles_across_batches(self, state_db: StateDB) -> None:
        """Simulate the per-batch ``ThreadPoolExecutor`` pattern.

        ``Uploader.upload_files`` constructs a new pool per call.
        With ``upload_parallelism=4`` and 10 batches the unfixed code
        would accumulate ~40 stale connections; the fix keeps the
        live count bounded regardless of batch count.
        """
        batches = 10
        per_batch = 4

        def worker(batch: int, worker_id: int) -> None:
            state_db.record_upload(
                f"b{batch}-w{worker_id}.nd2",
                f"sha-b{batch}-w{worker_id}",
                f"s3/b{batch}/w{worker_id}.nd2",
                relative_path=f"b{batch}/w{worker_id}.nd2",
                size_bytes=512,
                mtime=1_700_000_000.0 + batch,
            )

        for batch in range(batches):
            with ThreadPoolExecutor(max_workers=per_batch) as pool:
                futures = [pool.submit(worker, batch, w) for w in range(per_batch)]
                for f in futures:
                    f.result()

        gc.collect()

        with state_db._connections_lock:
            remaining = len(state_db._connections)

        # Upper bound: the main-thread handle plus a small slack for
        # any GC scheduling oddities. Concrete number doesn't matter
        # as long as it isn't O(batches * per_batch) -- the pre-fix
        # code would land at exactly 41 here.
        assert remaining <= 2, (
            f"Per-batch worker connections leaked: {remaining} live "
            f"after {batches} batches of {per_batch} workers"
        )
