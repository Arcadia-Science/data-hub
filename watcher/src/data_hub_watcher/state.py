"""Local SQLite state database for deduplication and crash recovery.

Stores which files have been uploaded (for dedup) and which runs have
been reported (for crash recovery).  Uses WAL mode for safe concurrent
reads from the heartbeat thread.
"""

from __future__ import annotations
import logging
import sqlite3
import threading
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

logger = logging.getLogger(__name__)


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


class StateDB:
    """Thin wrapper around a SQLite database with three tables.

    - `uploaded_files` — tracks files already sent to S3.
    - `runs` — tracks runs reported to and uploaded via the API.
    - `detected_files` — tracks the file manifest for every run we have
      reported to the API, so subsequent restarts can hydrate
      `RunDetector._runs` and skip files in the initial scan even in
      manual mode (where `uploaded_files` stays empty).
    """

    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        # check_same_thread=False is required because the heartbeat and
        # stability-checker threads also read from this DB.
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        # WAL mode allows concurrent reads from background threads while
        # the main thread writes, without blocking.
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._lock = threading.Lock()
        self._create_tables()

    def _create_tables(self) -> None:
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
            """
        )
        # Additive migration: older state DBs predate the stat-based initial
        # scan and have no size/mtime/relative_path columns. Add them as
        # nullable so legacy rows remain valid; has_stat_match simply misses
        # them and the scan falls back to enqueuing (uploader-side dedup
        # prevents re-upload).
        #
        # relative_path is keyed instead of just `filename` so same-named
        # files in different subdirectories (common in recursive watches)
        # don't collide on the cheap stat check.
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
        self._conn.commit()

    # ------------------------------------------------------------------
    # uploaded_files
    # ------------------------------------------------------------------

    def prune_uploaded_files(self, days: int = 90) -> int:
        """Delete upload records older than *days*. Returns rows removed."""
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        with self._lock:
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
        with self._lock:
            cur = self._conn.execute(
                "SELECT 1 FROM uploaded_files WHERE filename = ? AND sha256 = ? AND s3_key = ?",
                (filename, sha256, s3_key),
            )
            return cur.fetchone() is not None

    def has_any_upload(self, filename: str, sha256: str) -> bool:
        """Check whether this file content has been uploaded to *any* destination.

        Used by the file monitor's initial scan to skip files that have already
        been processed, before the S3 key is known.
        """
        with self._lock:
            cur = self._conn.execute(
                "SELECT 1 FROM uploaded_files WHERE filename = ? AND sha256 = ?",
                (filename, sha256),
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
        """
        with self._lock:
            cur = self._conn.execute(
                "SELECT 1 FROM uploaded_files "
                "WHERE relative_path = ? AND size_bytes = ? AND ABS(mtime - ?) < 1.0 "
                "LIMIT 1",
                (relative_path, size_bytes, mtime),
            )
            return cur.fetchone() is not None

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
        with self._lock:
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
        files: Iterable[tuple[str, str, int, float]],
    ) -> None:
        """Persist the file manifest for a reported run.

        *files* is an iterable of `(relative_path, filename, size_bytes,
        mtime)` tuples. Rows are upserted so repeated calls for the same
        run (e.g. as more files stabilise and PATCHes are issued) keep
        the table consistent with the in-memory `RunState`.
        """
        rows = [
            (run_id, rel_path, filename, size_bytes, mtime)
            for rel_path, filename, size_bytes, mtime in files
        ]
        if not rows:
            return
        with self._lock:
            self._conn.executemany(
                "INSERT OR REPLACE INTO detected_files "
                "(run_id, relative_path, filename, size_bytes, mtime) "
                "VALUES (?, ?, ?, ?, ?)",
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
        consistency across filesystem timestamp resolutions.
        """
        with self._lock:
            cur = self._conn.execute(
                "SELECT 1 FROM detected_files "
                "WHERE relative_path = ? AND size_bytes = ? AND ABS(mtime - ?) < 1.0 "
                "LIMIT 1",
                (relative_path, size_bytes, mtime),
            )
            return cur.fetchone() is not None

    def get_detected_files_for_run(self, run_id: str) -> list[DetectedFileRecord]:
        """Return the persisted file manifest for *run_id*, ordered by path."""
        with self._lock:
            cur = self._conn.execute(
                "SELECT relative_path, filename, size_bytes, mtime "
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
        with self._lock:
            cur = self._conn.execute("SELECT DISTINCT run_id FROM detected_files ORDER BY run_id")
            return [row[0] for row in cur.fetchall()]

    # ------------------------------------------------------------------
    # runs
    # ------------------------------------------------------------------

    def get_run(self, run_id: str) -> RunRecord | None:
        with self._lock:
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
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO runs (run_id, reported_at, uploaded_at) "
                "VALUES (?, ?, (SELECT uploaded_at FROM runs WHERE run_id = ?))",
                (run_id, now, run_id),
            )
            self._conn.commit()

    def record_run_uploaded(self, run_id: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with self._lock:
            self._conn.execute(
                "UPDATE runs SET uploaded_at = ? WHERE run_id = ?",
                (now, run_id),
            )
            self._conn.commit()

    # ------------------------------------------------------------------
    # lifecycle
    # ------------------------------------------------------------------

    def close(self) -> None:
        with self._lock:
            self._conn.close()
