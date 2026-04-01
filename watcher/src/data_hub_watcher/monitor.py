"""File monitoring with watchdog and stability detection.

``FileMonitor`` watches a directory for new/modified files, filters them
by glob patterns, waits for each file to become "stable" (size + mtime
unchanged for the configured period), then invokes a callback.
"""

from __future__ import annotations
import fnmatch
import hashlib
import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from watchdog.events import (
    FileCreatedEvent,
    FileModifiedEvent,
    FileSystemEvent,
    FileSystemEventHandler,
)
from watchdog.observers import Observer

from data_hub_watcher.constants import MAX_STABILITY_WAIT_SECONDS
from data_hub_watcher.state import StateDB

logger = logging.getLogger(__name__)


def file_sha256(path: Path) -> str:
    """Return the hex SHA-256 digest of *path*."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


@dataclass
class _PendingFile:
    """Tracks a file waiting to become stable."""

    path: Path
    size: int
    mtime: float
    first_seen: float = field(default_factory=time.monotonic)
    last_changed: float = field(default_factory=time.monotonic)


class _EventHandler(FileSystemEventHandler):
    """Watchdog handler that forwards matching create/modify events."""

    def __init__(
        self,
        file_patterns: list[str],
        on_event: Callable[[Path], None],
        recursive: bool,
    ) -> None:
        super().__init__()
        self._patterns = file_patterns
        self._on_event = on_event
        self._recursive = recursive

    def _matches(self, path: Path) -> bool:
        return any(fnmatch.fnmatch(path.name, pat) for pat in self._patterns)

    def on_created(self, event: FileSystemEvent) -> None:
        if isinstance(event, FileCreatedEvent) and not event.is_directory:
            p = Path(str(event.src_path))
            if self._matches(p):
                self._on_event(p)

    def on_modified(self, event: FileSystemEvent) -> None:
        if isinstance(event, FileModifiedEvent) and not event.is_directory:
            p = Path(str(event.src_path))
            if self._matches(p):
                self._on_event(p)


class FileMonitor:
    """Watches a directory, detects stable files, and invokes a callback.

    Parameters
    ----------
    watch_directory:
        Top-level directory to monitor.
    file_patterns:
        Glob patterns (e.g. ``["*.csv", "*.txt"]``) matched against filenames.
    stability_period:
        Seconds a file's size + mtime must remain unchanged before it is
        considered stable.
    on_stable_file:
        Called with the ``Path`` of each stable file.
    state_db:
        Used to skip files that have already been uploaded.
    recursive:
        Whether to monitor subdirectories (``True`` for directory-mode run
        detection, ``False`` otherwise).
    """

    def __init__(
        self,
        watch_directory: Path,
        file_patterns: list[str],
        stability_period: int,
        on_stable_file: Callable[[Path], None],
        state_db: StateDB,
        recursive: bool = False,
    ) -> None:
        self._watch_dir = watch_directory
        self._patterns = file_patterns
        self._stability_period = stability_period
        self._on_stable = on_stable_file
        self._state_db = state_db
        self._recursive = recursive

        self._pending: dict[Path, _PendingFile] = {}
        self._lock = threading.Lock()

        self._observer = Observer()
        self._checker_stop = threading.Event()
        self._checker_thread: threading.Thread | None = None

    # ------------------------------------------------------------------
    # public API
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Run the initial scan, start the watchdog observer, and begin the stability checker."""
        self._initial_scan()

        handler = _EventHandler(self._patterns, self._enqueue, self._recursive)
        self._observer.schedule(handler, str(self._watch_dir), recursive=self._recursive)
        self._observer.start()

        self._checker_stop.clear()
        self._checker_thread = threading.Thread(
            target=self._stability_loop, daemon=True, name="stability-checker"
        )
        self._checker_thread.start()
        logger.info(
            "FileMonitor started (dir=%s, patterns=%s, recursive=%s)",
            self._watch_dir,
            self._patterns,
            self._recursive,
        )

    def stop(self) -> None:
        """Stop the observer and stability-checker thread."""
        self._checker_stop.set()
        self._observer.stop()
        self._observer.join(timeout=5)
        if self._checker_thread and self._checker_thread.is_alive():
            self._checker_thread.join(timeout=5)
        logger.info("FileMonitor stopped")

    # ------------------------------------------------------------------
    # initial scan
    # ------------------------------------------------------------------

    def _initial_scan(self) -> None:
        """Walk the directory for existing files and enqueue unuploaded ones.

        This catches files that appeared while the watcher was stopped (e.g.
        between a crash and restart, or overnight when running as a service).
        """
        iterator = self._watch_dir.rglob("*") if self._recursive else self._watch_dir.iterdir()
        count = 0
        for entry in iterator:
            if not entry.is_file():
                continue
            if not any(fnmatch.fnmatch(entry.name, pat) for pat in self._patterns):
                continue
            sha = file_sha256(entry)
            if self._state_db.is_uploaded(entry.name, sha):
                continue
            self._enqueue(entry)
            count += 1

        if count:
            logger.info("Initial scan queued %d file(s) for stability check", count)

    # ------------------------------------------------------------------
    # stability tracking
    # ------------------------------------------------------------------

    def _enqueue(self, path: Path) -> None:
        """Add or refresh a file in the pending-stability dict."""
        try:
            stat = path.stat()
        except OSError:
            return
        with self._lock:
            existing = self._pending.get(path)
            if existing is None:
                self._pending[path] = _PendingFile(
                    path=path, size=stat.st_size, mtime=stat.st_mtime
                )
            else:
                if stat.st_size != existing.size or stat.st_mtime != existing.mtime:
                    existing.size = stat.st_size
                    existing.mtime = stat.st_mtime
                    existing.last_changed = time.monotonic()

    def _stability_loop(self) -> None:
        """Periodically check pending files for stability or timeout."""
        while not self._checker_stop.wait(timeout=1.0):
            self._check_pending()

    def _check_pending(self) -> None:
        """Poll each pending file's size + mtime against its last-known values.

        A file is "stable" when its size and mtime haven't changed for the full
        stability period.  If the file keeps changing beyond
        MAX_STABILITY_WAIT_SECONDS it is abandoned — this guards against files
        that are continuously appended to (e.g. active log streams).
        """
        now = time.monotonic()
        stable: list[Path] = []
        timed_out: list[Path] = []

        with self._lock:
            for path, pf in list(self._pending.items()):
                try:
                    stat = path.stat()
                except OSError:
                    del self._pending[path]
                    continue

                if stat.st_size != pf.size or stat.st_mtime != pf.mtime:
                    pf.size = stat.st_size
                    pf.mtime = stat.st_mtime
                    pf.last_changed = now
                    continue

                elapsed_since_change = now - pf.last_changed
                if elapsed_since_change >= self._stability_period:
                    stable.append(path)
                    del self._pending[path]
                elif (now - pf.first_seen) >= MAX_STABILITY_WAIT_SECONDS:
                    timed_out.append(path)
                    del self._pending[path]

        for path in timed_out:
            logger.error(
                "File %s did not stabilise within %ds — skipping",
                path,
                MAX_STABILITY_WAIT_SECONDS,
            )

        for path in stable:
            logger.info("File stable: %s", path)
            try:
                self._on_stable(path)
            except Exception:
                logger.exception("Callback failed for %s", path)
