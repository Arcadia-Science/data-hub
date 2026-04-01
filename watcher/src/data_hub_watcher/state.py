"""Local SQLite state database for deduplication and crash recovery.

Stores which files have been uploaded (for dedup) and which runs have
been reported (for crash recovery).  Uses WAL mode for safe concurrent
reads from the heartbeat thread.
"""

from __future__ import annotations
import logging
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass
class RunRecord:
    run_id: str
    reported_at: str
    uploaded_at: str | None


class StateDB:
    """Thin wrapper around a SQLite database with two tables.

    - ``uploaded_files`` — tracks files already sent to S3.
    - ``runs`` — tracks runs reported to and uploaded via the API.
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
        self._create_tables()

    def _create_tables(self) -> None:
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS uploaded_files (
                filename   TEXT NOT NULL,
                sha256     TEXT NOT NULL,
                uploaded_at TEXT NOT NULL,
                s3_key     TEXT NOT NULL,
                PRIMARY KEY (filename, sha256)
            );

            CREATE TABLE IF NOT EXISTS runs (
                run_id      TEXT PRIMARY KEY,
                reported_at TEXT NOT NULL,
                uploaded_at TEXT
            );
            """
        )
        self._conn.commit()

    # ------------------------------------------------------------------
    # uploaded_files
    # ------------------------------------------------------------------

    def prune_uploaded_files(self, days: int = 90) -> int:
        """Delete upload records older than *days*. Returns rows removed."""
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        cur = self._conn.execute("DELETE FROM uploaded_files WHERE uploaded_at < ?", (cutoff,))
        self._conn.commit()
        removed = cur.rowcount
        if removed:
            logger.info("Pruned %d uploaded_files record(s) older than %d days", removed, days)
        return removed

    def is_uploaded(self, filename: str, sha256: str) -> bool:
        """Check whether this exact file content has already been uploaded.

        Keyed on (filename, sha256) so re-uploading is triggered if the file
        content changes (same name, different hash) but skipped if the same
        file is seen again unchanged.
        """
        cur = self._conn.execute(
            "SELECT 1 FROM uploaded_files WHERE filename = ? AND sha256 = ?",
            (filename, sha256),
        )
        return cur.fetchone() is not None

    def record_upload(self, filename: str, sha256: str, s3_key: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        self._conn.execute(
            "INSERT OR REPLACE INTO uploaded_files (filename, sha256, uploaded_at, s3_key) "
            "VALUES (?, ?, ?, ?)",
            (filename, sha256, now, s3_key),
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
        self._conn.execute(
            "INSERT OR REPLACE INTO runs (run_id, reported_at, uploaded_at) "
            "VALUES (?, ?, (SELECT uploaded_at FROM runs WHERE run_id = ?))",
            (run_id, now, run_id),
        )
        self._conn.commit()

    def record_run_uploaded(self, run_id: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        self._conn.execute(
            "UPDATE runs SET uploaded_at = ? WHERE run_id = ?",
            (now, run_id),
        )
        self._conn.commit()

    # ------------------------------------------------------------------
    # lifecycle
    # ------------------------------------------------------------------

    def close(self) -> None:
        self._conn.close()
