"""Local SQLite state database for deduplication and crash recovery.

Stores which files have been uploaded (for dedup) and which runs have
been reported (for crash recovery).  Uses WAL mode for safe concurrent
reads from background threads without blocking writes.

Threading model
---------------
Each thread that touches the database gets its own
:class:`sqlite3.Connection` lazily on first access. SQLite is
fully thread-safe per connection but a single connection cannot be
shared across threads without serialising every call -- which is what
the previous process-wide ``threading.Lock`` was doing and what was
defeating WAL mode for parallel readers (and, with the upcoming
parallel uploader pool, parallel writers too).

Reads run unlocked: WAL lets multiple readers proceed against the
last-committed snapshot while a writer is in progress. Writes take
``_write_lock`` so only one Python thread at a time issues an
``INSERT/UPDATE/DELETE`` -- combined with ``PRAGMA busy_timeout`` this
gives us cooperative serialisation without ever surfacing
``database is locked`` to callers.
"""

from __future__ import annotations
import logging
import sqlite3
import threading
import weakref
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

# `meta` key set once `seed_baseline_files` has run for a `new-only`
# environment, so the one-shot seed gate survives an empty-at-first-start
# watch directory. See `StateDB.baseline_established`.
BASELINE_SEEDED_META_KEY = "baseline_seeded"


class _PerThreadHandle:
    """Owns a single ``sqlite3.Connection`` for the thread that opened it.

    Stored only in :class:`threading.local` so the holder is reachable
    exclusively through the owning thread's per-thread storage. When
    that thread terminates CPython clears its slice of the
    ``threading.local`` dict, drops the last strong reference to the
    holder, and the :func:`weakref.finalize` registered against it by
    :meth:`StateDB._conn` fires -- closing the connection and removing
    it from :attr:`StateDB._connections` so short-lived upload workers
    don't accumulate sqlite handles for the lifetime of the watcher.
    """

    __slots__ = ("conn", "__weakref__")

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn


@dataclass
class RunRecord:
    run_id: str
    reported_at: str
    uploaded_at: str | None


@dataclass
class DetectedFileRecord:
    """A single file recorded as already-detected-and-reported for a run."""

    relative_path: str
    filename: str
    size_bytes: int
    mtime: float
    # On-disk creation time at the moment the file was reported. NULL for
    # rows persisted before this column was added (legacy state DBs).
    file_created_at: float | None = None


class StateDB:
    """Thin wrapper around a SQLite database, one file per environment.

    - `uploaded_files` — tracks files already sent to S3.
    - `runs` — tracks runs reported to and uploaded via the API.
    - `detected_files` — tracks the file manifest for every run we have
      reported to the API, so subsequent restarts can hydrate
      `RunDetector._runs` and skip files in the initial scan even in
      manual mode (where `uploaded_files` stays empty).
    - `baseline_files` — files that existed on disk when a `new-only`
      environment was first entered and were deliberately skipped (never
      uploaded). Distinct from `uploaded_files`: a baseline row means
      "ignore", not "sent". Never pruned, unlike `uploaded_files`.
    - `meta` — small key/value store (e.g. the preview deployment URL this
      DB was seeded against) used to decide when to reset on a redeploy.
    """

    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._db_path = db_path
        # Per-thread connection storage. Each thread that calls into this
        # StateDB gets its own sqlite3 handle the first time it touches
        # the ``_conn`` property (see below). Sharing a single handle
        # across threads serialises every call on Python's lock and
        # nullifies WAL's concurrent-read benefit.
        self._local = threading.local()
        # Live per-thread connections, used so ``close()`` can reach
        # handles that belong to threads other than the closer. Stored
        # as a ``set`` (not a list) for O(1) removal by the per-thread
        # weakref finaliser when an upload-worker thread dies; without
        # that pruning, every short-lived ThreadPoolExecutor worker
        # would leak an open sqlite handle for the lifetime of the
        # watcher process.
        self._connections: set[sqlite3.Connection] = set()
        self._connections_lock = threading.Lock()
        # Serialises concurrent writers from this Python process so we
        # never surface ``database is locked`` to callers. SQLite itself
        # only allows one writer at a time; this lock just makes the
        # contention happen in user space (cheap) instead of at the
        # SQLite layer (busy-wait + retry storms).
        self._write_lock = threading.Lock()
        # Eagerly materialise the main-thread connection so DDL runs
        # exactly once at construction time -- subsequent worker threads
        # see the schema already in place when they open their handles.
        self._create_tables()

    # ------------------------------------------------------------------
    # connection plumbing
    # ------------------------------------------------------------------

    @property
    def _conn(self) -> sqlite3.Connection:
        """Return the current thread's sqlite3 connection, opening one if needed.

        Exposed as a property (rather than a private helper) so existing
        callers and tests that historically reached for ``state_db._conn``
        keep working unchanged. The underlying handle is now per-thread,
        which is the behavioural difference -- but every call site only
        used it on the main thread, so the change is invisible.
        """
        holder = getattr(self._local, "holder", None)
        if holder is not None:
            return holder.conn

        # ``check_same_thread=False`` is no longer strictly needed (each
        # connection is used by exactly one thread) but keeping it set
        # tolerates the rare test that constructs a StateDB on the main
        # thread and immediately uses its handle from a child thread
        # before the child has triggered its own lazy init.
        conn = sqlite3.connect(str(self._db_path), check_same_thread=False)
        # WAL is a database-file property and persists once enabled, but
        # the other PRAGMAs are per-connection and have to be set on
        # every handle.
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        # 64 MiB page cache (negative => kibibytes) and a 256 MiB mmap
        # window. On lab PCs with millions of historical upload rows,
        # these turn the bulk-load scans (``iter_uploaded_stat_keys`` /
        # ``iter_detected_stat_keys``) into mostly in-memory work.
        conn.execute("PRAGMA cache_size=-65536")
        conn.execute("PRAGMA temp_store=MEMORY")
        conn.execute("PRAGMA mmap_size=268435456")
        # If two writer threads race, the loser waits up to 5 s for the
        # winner's transaction to commit instead of immediately raising
        # ``database is locked``. Combined with ``_write_lock`` above
        # this is belt-and-suspenders -- the lock makes contention
        # cooperative; ``busy_timeout`` covers the case where a worker
        # bypasses the lock (e.g. via the ``_conn`` property in a test).
        conn.execute("PRAGMA busy_timeout=5000")

        # Hold the handle behind a per-thread wrapper so the finaliser
        # registered just below has something to watch other than the
        # connection itself -- registering finalize() on the connection
        # would race with ``sqlite3.Connection.__del__`` and confuse the
        # "already-closed" detection.
        holder = _PerThreadHandle(conn)
        self._local.holder = holder
        with self._connections_lock:
            self._connections.add(conn)
        # When this thread terminates, CPython clears the per-thread
        # slice of ``self._local``, the holder loses its last strong
        # reference, and this finaliser closes the connection and
        # removes it from ``_connections``. The result: an upload
        # ThreadPoolExecutor that spawns -> dies -> spawns again on
        # every batch no longer accumulates a sqlite handle per worker
        # per batch for the watcher's lifetime.
        weakref.finalize(holder, self._reap_connection, conn)
        return conn

    def _reap_connection(self, conn: sqlite3.Connection) -> None:
        """Drop *conn* from the live set and best-effort close it.

        Invoked from a :func:`weakref.finalize` callback when the
        owning thread's :class:`threading.local` storage is reclaimed.
        Idempotent against an explicit :meth:`close` -- if the
        connection has already been closed there, ``conn.close()`` is
        a no-op and the ``discard`` simply finds nothing to remove.
        """
        with self._connections_lock:
            self._connections.discard(conn)
        try:
            conn.close()
        except sqlite3.Error:
            # Already closed (e.g. close() ran first) or otherwise in a
            # bad state. We've removed it from the live set so there is
            # nothing left to clean up.
            pass

    def _create_tables(self) -> None:
        with self._write_lock:
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS uploaded_files (
                    filename   TEXT NOT NULL,
                    sha256     TEXT NOT NULL,
                    uploaded_at TEXT NOT NULL,
                    s3_key     TEXT NOT NULL,
                    PRIMARY KEY (filename, sha256, s3_key)
                );

                CREATE TABLE IF NOT EXISTS runs (
                    run_id      TEXT PRIMARY KEY,
                    reported_at TEXT NOT NULL,
                    uploaded_at TEXT
                );

                CREATE TABLE IF NOT EXISTS detected_files (
                    run_id        TEXT NOT NULL,
                    relative_path TEXT NOT NULL,
                    filename      TEXT NOT NULL,
                    size_bytes    INTEGER NOT NULL,
                    mtime         REAL NOT NULL,
                    PRIMARY KEY (run_id, relative_path)
                );

                CREATE INDEX IF NOT EXISTS idx_detected_files_stat
                    ON detected_files (relative_path, size_bytes, mtime);

                CREATE TABLE IF NOT EXISTS baseline_files (
                    relative_path TEXT PRIMARY KEY,
                    size_bytes    INTEGER NOT NULL,
                    mtime         REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS meta (
                    key   TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                """
            )
            # Additive migration: older state DBs predate the stat-based
            # initial scan and have no size/mtime/relative_path columns.
            # Add them as nullable so legacy rows remain valid;
            # has_stat_match simply misses them and the scan falls back
            # to enqueuing (uploader-side dedup prevents re-upload).
            #
            # relative_path is keyed instead of just `filename` so
            # same-named files in different subdirectories (common in
            # recursive watches) don't collide on the cheap stat check.
            cols = {row[1] for row in self._conn.execute("PRAGMA table_info(uploaded_files)")}
            if "size_bytes" not in cols:
                self._conn.execute("ALTER TABLE uploaded_files ADD COLUMN size_bytes INTEGER")
            if "mtime" not in cols:
                self._conn.execute("ALTER TABLE uploaded_files ADD COLUMN mtime REAL")
            if "relative_path" not in cols:
                self._conn.execute("ALTER TABLE uploaded_files ADD COLUMN relative_path TEXT")
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_uploaded_files_stat "
                "ON uploaded_files (relative_path, size_bytes, mtime)"
            )
            # detected_files predates the file_created_at column; add it
            # as nullable so legacy rows survive the migration. New rows
            # always populate it (record_detected_files passes the value
            # through).
            detected_cols = {
                row[1] for row in self._conn.execute("PRAGMA table_info(detected_files)")
            }
            if "file_created_at" not in detected_cols:
                self._conn.execute("ALTER TABLE detected_files ADD COLUMN file_created_at REAL")
            self._conn.commit()

    # ------------------------------------------------------------------
    # uploaded_files
    # ------------------------------------------------------------------

    def prune_uploaded_files(self, days: int = 90) -> int:
        """Delete upload records older than *days*. Returns rows removed."""
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        with self._write_lock:
            cur = self._conn.execute("DELETE FROM uploaded_files WHERE uploaded_at < ?", (cutoff,))
            self._conn.commit()
        removed = cur.rowcount
        if removed:
            logger.info("Pruned %d uploaded_files record(s) older than %d days", removed, days)
        return removed

    def is_uploaded(self, filename: str, sha256: str, s3_key: str) -> bool:
        """Check whether this exact file has already been uploaded to *s3_key*.

        Keyed on `(filename, sha256, s3_key)` so the same file content can
        be uploaded to different S3 destinations (e.g. different runs that
        produce identically-named output files).
        """
        cur = self._conn.execute(
            "SELECT 1 FROM uploaded_files WHERE filename = ? AND sha256 = ? AND s3_key = ?",
            (filename, sha256, s3_key),
        )
        return cur.fetchone() is not None

    def has_stat_match(self, relative_path: str, size_bytes: int, mtime: float) -> bool:
        """Cheap identity check for the initial scan.

        Returns True if any prior upload record matches
        `(relative_path, size, mtime)`. We key on the watch-dir-relative
        path rather than basename so same-named files in different
        subdirectories (common in recursive watches) don't collide.

        The mtime comparison uses a ~1s tolerance to absorb filesystem
        timestamp resolution differences (FAT = 2s, NTFS = 100ns, ext4 = ns)
        and minor float rounding between Python versions / platforms.

        Production hot paths (notably ``FileMonitor._initial_scan``)
        use :meth:`iter_uploaded_stat_keys` to bulk-load every key in a
        single ``SELECT`` and check membership in Python -- one query
        for the whole scan instead of one per file. This per-row
        helper remains for ad-hoc lookups and for the
        ``test_monitor_initial_scan`` unit suite that drives it
        directly.
        """
        cur = self._conn.execute(
            "SELECT 1 FROM uploaded_files "
            "WHERE relative_path = ? AND size_bytes = ? AND ABS(mtime - ?) < 1.0 "
            "LIMIT 1",
            (relative_path, size_bytes, mtime),
        )
        return cur.fetchone() is not None

    def iter_uploaded_stat_keys(self) -> Iterator[tuple[str, int, float]]:
        """Yield ``(relative_path, size_bytes, mtime)`` for every upload row.

        Bulk-load helper used by :meth:`FileMonitor._initial_scan` so
        the scan can build an in-memory dedup index in a single SQL
        round trip rather than issuing one ``SELECT`` per scanned file.
        Legacy rows that predate the stat columns (any of the three
        being NULL) are filtered out -- they would never match the
        scan's tolerance check anyway.
        """
        cur = self._conn.execute(
            "SELECT relative_path, size_bytes, mtime FROM uploaded_files "
            "WHERE relative_path IS NOT NULL AND size_bytes IS NOT NULL AND mtime IS NOT NULL"
        )
        for row in cur:
            yield row[0], row[1], row[2]

    def record_upload(
        self,
        filename: str,
        sha256: str,
        s3_key: str,
        *,
        relative_path: str,
        size_bytes: int,
        mtime: float,
    ) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with self._write_lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO uploaded_files "
                "(filename, sha256, uploaded_at, s3_key, relative_path, size_bytes, mtime) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (filename, sha256, now, s3_key, relative_path, size_bytes, mtime),
            )
            self._conn.commit()

    # ------------------------------------------------------------------
    # detected_files
    # ------------------------------------------------------------------

    def record_detected_files(
        self,
        run_id: str,
        files: Iterable[tuple[str, str, int, float, float | None]],
    ) -> None:
        """Persist the file manifest for a reported run.

        *files* is an iterable of `(relative_path, filename, size_bytes,
        mtime, file_created_at)` tuples. Rows are upserted so repeated
        calls for the same run (e.g. as more files stabilise and PATCHes
        are issued) keep the table consistent with the in-memory
        `RunState`. *file_created_at* may be `None` for legacy callers.
        """
        rows = [
            (run_id, rel_path, filename, size_bytes, mtime, file_created_at)
            for rel_path, filename, size_bytes, mtime, file_created_at in files
        ]
        if not rows:
            return
        with self._write_lock:
            self._conn.executemany(
                "INSERT OR REPLACE INTO detected_files "
                "(run_id, relative_path, filename, size_bytes, mtime, file_created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                rows,
            )
            self._conn.commit()

    def has_detected_stat_match(self, relative_path: str, size_bytes: int, mtime: float) -> bool:
        """Return True if this file was already reported as part of some run.

        Mirrors `has_stat_match` but targets the `detected_files` table
        so the initial scan can skip files that are already represented
        in a reported run's manifest — even when they haven't been
        uploaded yet (manual mode).

        Uses the same ~1s mtime tolerance as `has_stat_match` for
        consistency across filesystem timestamp resolutions. As with
        ``has_stat_match``, the production initial-scan path uses
        :meth:`iter_detected_stat_keys` to bulk-load instead of calling
        this per file.
        """
        cur = self._conn.execute(
            "SELECT 1 FROM detected_files "
            "WHERE relative_path = ? AND size_bytes = ? AND ABS(mtime - ?) < 1.0 "
            "LIMIT 1",
            (relative_path, size_bytes, mtime),
        )
        return cur.fetchone() is not None

    def iter_detected_stat_keys(self) -> Iterator[tuple[str, int, float]]:
        """Yield ``(relative_path, size_bytes, mtime)`` for every detected-file row.

        Bulk-load counterpart to :meth:`iter_uploaded_stat_keys` for the
        ``detected_files`` table. Excludes rows with NULL stat columns
        (none should exist today, but the guard keeps the helper safe
        if a future migration introduces them).
        """
        cur = self._conn.execute(
            "SELECT relative_path, size_bytes, mtime FROM detected_files "
            "WHERE relative_path IS NOT NULL AND size_bytes IS NOT NULL AND mtime IS NOT NULL"
        )
        for row in cur:
            yield row[0], row[1], row[2]

    def get_detected_files_for_run(self, run_id: str) -> list[DetectedFileRecord]:
        """Return the persisted file manifest for *run_id*, ordered by path."""
        cur = self._conn.execute(
            "SELECT relative_path, filename, size_bytes, mtime, file_created_at "
            "FROM detected_files WHERE run_id = ? ORDER BY relative_path",
            (run_id,),
        )
        rows = cur.fetchall()
        return [
            DetectedFileRecord(
                relative_path=row[0],
                filename=row[1],
                size_bytes=row[2],
                mtime=row[3],
                file_created_at=row[4],
            )
            for row in rows
        ]

    def get_reported_run_ids_with_files(self) -> list[str]:
        """Return every run_id that has at least one recorded detected file.

        Runs present in the legacy `runs` table but absent from
        `detected_files` (pre-upgrade rows) are intentionally excluded:
        they fall back to the pre-hydration code path and re-report once,
        after which their manifest will be recorded and future restarts
        will skip them.
        """
        cur = self._conn.execute("SELECT DISTINCT run_id FROM detected_files ORDER BY run_id")
        return [row[0] for row in cur.fetchall()]

    # ------------------------------------------------------------------
    # baseline_files
    # ------------------------------------------------------------------

    def record_baseline_files(self, files: Iterable[tuple[str, int, float]]) -> None:
        """Record `(relative_path, size_bytes, mtime)` rows as baseline.

        Used by `seed_baseline_files` when entering a `new-only` environment:
        the rows feed the initial-scan dedup index so the pre-existing backlog
        is skipped without ever being uploaded.
        """
        rows = list(files)
        if not rows:
            return
        with self._write_lock:
            self._conn.executemany(
                "INSERT OR REPLACE INTO baseline_files "
                "(relative_path, size_bytes, mtime) VALUES (?, ?, ?)",
                rows,
            )
            self._conn.commit()

    def iter_baseline_stat_keys(self) -> Iterator[tuple[str, int, float]]:
        """Yield `(relative_path, size_bytes, mtime)` for every baseline row."""
        cur = self._conn.execute("SELECT relative_path, size_bytes, mtime FROM baseline_files")
        for row in cur:
            yield row[0], row[1], row[2]

    def baseline_established(self) -> bool:
        """Whether this DB already has baseline or real upload/run history.

        Gate for one-shot baseline seeding: if any of `baseline_files`,
        `uploaded_files`, or `detected_files` is non-empty we must not reseed,
        or we would mark genuinely-new files as skippable backlog. Also true
        once seeding has run via the `baseline_seeded` meta sentinel — without
        it a `new-only` watch dir that was empty at first start would re-walk
        the whole tree on every restart until the first file appears.
        """
        if self.get_meta(BASELINE_SEEDED_META_KEY) is not None:
            return True
        cur = self._conn.execute(
            "SELECT "
            "EXISTS(SELECT 1 FROM baseline_files) OR "
            "EXISTS(SELECT 1 FROM uploaded_files) OR "
            "EXISTS(SELECT 1 FROM detected_files)"
        )
        return bool(cur.fetchone()[0])

    def mark_baseline_seeded(self) -> None:
        """Record that `seed_baseline_files` has run for this environment.

        Makes the one-shot seed gate hold even when the initial scan matched
        zero files (see `baseline_established`).
        """
        self.set_meta(BASELINE_SEEDED_META_KEY, "1")

    # ------------------------------------------------------------------
    # meta
    # ------------------------------------------------------------------

    def get_meta(self, key: str) -> str | None:
        cur = self._conn.execute("SELECT value FROM meta WHERE key = ?", (key,))
        row = cur.fetchone()
        return None if row is None else str(row[0])

    def set_meta(self, key: str, value: str) -> None:
        with self._write_lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
                (key, value),
            )
            self._conn.commit()

    # ------------------------------------------------------------------
    # runs
    # ------------------------------------------------------------------

    def get_run(self, run_id: str) -> RunRecord | None:
        cur = self._conn.execute(
            "SELECT run_id, reported_at, uploaded_at FROM runs WHERE run_id = ?",
            (run_id,),
        )
        row = cur.fetchone()
        if row is None:
            return None
        return RunRecord(run_id=row[0], reported_at=row[1], uploaded_at=row[2])

    def record_run_reported(self, run_id: str) -> None:
        """Mark a run as reported, preserving any existing uploaded_at timestamp.

        The sub-SELECT keeps uploaded_at intact if the run was already recorded
        (e.g. a retry after a previous partial failure).
        """
        now = datetime.now(timezone.utc).isoformat()
        with self._write_lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO runs (run_id, reported_at, uploaded_at) "
                "VALUES (?, ?, (SELECT uploaded_at FROM runs WHERE run_id = ?))",
                (run_id, now, run_id),
            )
            self._conn.commit()

    def last_run_reported_at(self) -> str | None:
        """Most recent ``reported_at`` timestamp across all runs, or None.

        Used by the updater to gate auto-updates on a quiet-instrument
        window: we don't want to take down the watcher in the middle of
        an actively-running experiment.
        """
        cur = self._conn.execute("SELECT MAX(reported_at) FROM runs")
        row = cur.fetchone()
        if row is None or row[0] is None:
            return None
        return str(row[0])

    def record_run_uploaded(self, run_id: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with self._write_lock:
            self._conn.execute(
                "UPDATE runs SET uploaded_at = ? WHERE run_id = ?",
                (now, run_id),
            )
            self._conn.commit()

    # ------------------------------------------------------------------
    # lifecycle
    # ------------------------------------------------------------------

    def close(self) -> None:
        """Close every per-thread sqlite3 handle opened by this StateDB.

        Safe to call from any thread: we snapshot the connection set
        under ``_connections_lock`` and close each one outside the
        lock. Connections opened after this call (e.g. a stray late
        write attempt) will simply re-open against the file -- there
        is no "is closed" flag because the watcher's shutdown sequence
        guarantees the runtime threads have already joined before
        ``close()`` runs.
        """
        with self._connections_lock:
            conns = list(self._connections)
            self._connections.clear()
        for conn in conns:
            try:
                conn.close()
            except sqlite3.Error as exc:
                # A best-effort close: if a connection is already closed
                # or in a bad state, log and move on so we still close
                # the rest. Re-raising would leave handles dangling.
                logger.warning("Error closing StateDB connection: %s", exc)
        # Drop the thread-local holder so any subsequent _conn access
        # from this thread re-initialises rather than reusing a closed
        # connection. The other threads' holders (and their dead
        # connections) are reaped lazily by the per-thread finaliser
        # registered in ``_conn``.
        if hasattr(self._local, "holder"):
            del self._local.holder
