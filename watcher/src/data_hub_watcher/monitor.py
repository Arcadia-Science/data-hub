"""File monitoring with watchdog and stability detection.

`FileMonitor` watches a directory for new/modified files, filters them
by glob patterns, waits for each file to become "stable" (size + mtime
unchanged for the configured period), then invokes a callback.
"""

from __future__ import annotations
import fnmatch
import logging
import os
import re
import threading
import time
from collections.abc import Callable, Iterator
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
from data_hub_watcher.events import EventReporter
from data_hub_watcher.state import StateDB

logger = logging.getLogger(__name__)

# ~1 second tolerance applied to stat-based dedup matches in the
# initial scan. Mirrors the SQL ``ABS(mtime - ?) < 1.0`` predicate used
# by ``StateDB.has_stat_match`` -- keep the two in sync.
_STAT_MTIME_TOLERANCE = 1.0


def _compile_pattern_matcher(file_patterns: list[str]) -> Callable[[str], bool]:
    """Return a fast ``filename -> bool`` matcher for *file_patterns*.

    Pre-compiles the user-facing fnmatch globs (e.g. ``["*.csv",
    "*.txt"]``) into a single anchored regex so the hot paths
    (per-file initial-scan filter, per-event watchdog filter) only do
    one regex match instead of one ``fnmatch.fnmatch`` call per
    pattern. ``fnmatch.translate`` already produces anchored regexes,
    so combining them with ``|`` is safe.
    """
    if not file_patterns:
        # An empty pattern list rejects everything -- mirrors the
        # behaviour of ``any(... for pat in [])`` which is False.
        return lambda _name: False

    combined = "|".join(f"(?:{fnmatch.translate(pat)})" for pat in file_patterns)
    regex = re.compile(combined)
    return lambda name: regex.match(name) is not None


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
        matches: Callable[[str], bool],
        on_event: Callable[[Path], None],
        recursive: bool,
    ) -> None:
        super().__init__()
        # Pre-compiled matcher shared with the FileMonitor so we
        # don't pay fnmatch translation cost per event.
        self._matches = matches
        self._on_event = on_event
        self._recursive = recursive

    def on_created(self, event: FileSystemEvent) -> None:
        if isinstance(event, FileCreatedEvent) and not event.is_directory:
            p = Path(str(event.src_path))
            if self._matches(p.name):
                self._on_event(p)

    def on_modified(self, event: FileSystemEvent) -> None:
        if isinstance(event, FileModifiedEvent) and not event.is_directory:
            p = Path(str(event.src_path))
            if self._matches(p.name):
                self._on_event(p)


class FileMonitor:
    """Watches a directory, detects stable files, and invokes a callback.

    Parameters
    ----------
    watch_directory:
        Top-level directory to monitor.
    file_patterns:
        Glob patterns (e.g. `["*.csv", "*.txt"]`) matched against filenames.
    stability_period:
        Seconds a file's size + mtime must remain unchanged before it is
        considered stable.
    on_stable_file:
        Called with the `Path` of each stable file.
    state_db:
        Used to skip files that have already been uploaded.
    recursive:
        Whether to monitor subdirectories (`True` for directory-mode run
        detection, `False` otherwise).
    """

    def __init__(
        self,
        watch_directory: Path,
        file_patterns: list[str],
        stability_period: int,
        on_stable_file: Callable[[Path], None],
        state_db: StateDB,
        recursive: bool = False,
        event_reporter: EventReporter | None = None,
    ) -> None:
        self._watch_dir = watch_directory
        self._patterns = file_patterns
        # Compile the patterns once and reuse for both the initial scan
        # and the watchdog event handler. Hot-path scans of large
        # directories used to do ``len(file_patterns)`` fnmatch calls
        # per file; this is one regex match instead.
        self._matches_name = _compile_pattern_matcher(file_patterns)
        self._stability_period = stability_period
        self._on_stable = on_stable_file
        self._state_db = state_db
        self._recursive = recursive
        # Optional so unit tests that build a FileMonitor in isolation
        # don't have to construct a full reporter graph. In production
        # the reporter is always wired by ``runtime.build_runtime``.
        self._reporter = event_reporter

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

        handler = _EventHandler(self._matches_name, self._enqueue, self._recursive)
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

    def _iter_dir_entries(self, root: Path) -> Iterator[os.DirEntry[str]]:
        """Yield ``os.DirEntry`` objects under *root*, optionally recursively.

        ``os.scandir`` returns ``DirEntry`` objects that cache the
        result of one ``lstat`` syscall per entry: ``is_file()`` and
        ``stat()`` then come from cache rather than triggering more
        syscalls. The previous ``Path.rglob('*') + entry.is_file() +
        entry.stat()`` chain costs three stats per file on Windows
        network shares (~hundreds of microseconds each) -- this is
        one. Walking via an explicit stack avoids the recursion-depth
        cap on deeply nested run trees and keeps a single open
        ``scandir`` handle per directory at a time.

        ``OSError`` from a deleted/unreadable directory is logged and
        skipped so a single transient permission glitch doesn't
        abort the whole scan.
        """
        stack: list[Path] = [root]
        while stack:
            current = stack.pop()
            try:
                it = os.scandir(current)
            except OSError as exc:
                logger.warning("scandir failed for %s: %s", current, exc)
                continue
            with it:
                for entry in it:
                    if self._recursive:
                        try:
                            if entry.is_dir(follow_symlinks=False):
                                stack.append(Path(entry.path))
                                continue
                        except OSError:
                            continue
                    yield entry

    def _load_dedup_index(self) -> dict[str, list[tuple[int, float]]]:
        """Bulk-load the union of upload + detected stat keys keyed by relative path.

        One ``SELECT`` per table replaces what used to be two ``SELECT``
        s per scanned file. Multiple rows can exist for the same
        relative path (re-uploads with different content / mtime), so
        the value is a list of ``(size_bytes, mtime)`` tuples and
        membership is checked with the same ~1s mtime tolerance the
        SQL ``has_stat_match`` predicate uses (see
        :data:`_STAT_MTIME_TOLERANCE`).
        """
        index: dict[str, list[tuple[int, float]]] = {}
        for rel_path, size_bytes, mtime in self._state_db.iter_uploaded_stat_keys():
            index.setdefault(rel_path, []).append((size_bytes, mtime))
        for rel_path, size_bytes, mtime in self._state_db.iter_detected_stat_keys():
            index.setdefault(rel_path, []).append((size_bytes, mtime))
        return index

    def _initial_scan(self) -> None:
        """Walk the directory for existing files and enqueue unuploaded ones.

        This catches files that appeared while the watcher was stopped (e.g.
        between a crash and restart, or overnight when running as a service).

        Identity for "already uploaded" is `(relative_path, size, mtime)` —
        a cheap `stat()` rather than a full-content SHA-256. The path is
        relative to the watch directory, so same-named files in different
        subdirectories don't collide. For write-once instrument output this
        is a safe and much faster heuristic. The uploader still computes a
        real SHA-256 on its way out, so content integrity is not
        compromised. See also: `StateDB.has_stat_match`.

        In addition to `uploaded_files`, files recorded in `detected_files`
        (i.e. already part of a reported run's manifest) are also skipped.
        This matters in manual mode where the uploader never runs locally
        and `uploaded_files` stays empty — without this, every restart
        would re-POST / PATCH the full manifest.
        See also: `StateDB.has_detected_stat_match`.

        Implementation notes
        --------------------
        The scan walks via :meth:`_iter_dir_entries` (a thin
        ``os.scandir`` wrapper) and consults a single in-memory
        dedup index built up front by :meth:`_load_dedup_index`.
        Together they replace the previous "one ``Path.is_file()`` +
        one ``entry.stat()`` + two SQL ``SELECT`` s per file" pattern
        with "one cached ``DirEntry.stat()`` + one Python dict lookup"
        -- typically a 5-10x speedup on lab-PC sized trees.
        """
        logger.info(
            "Initial scan starting (dir=%s, patterns=%s, recursive=%s)…",
            self._watch_dir,
            self._patterns,
            self._recursive,
        )
        dedup_index = self._load_dedup_index()
        total = 0
        queued = 0
        skipped = 0
        for entry in self._iter_dir_entries(self._watch_dir):
            try:
                if not entry.is_file(follow_symlinks=False):
                    continue
            except OSError:
                continue
            if not self._matches_name(entry.name):
                continue
            total += 1
            try:
                # ``DirEntry.stat()`` is cached after the first call,
                # so this and a subsequent ``entry.stat()`` in
                # ``_enqueue`` (via ``stat_result=st`` below) share the
                # same syscall.
                st = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            entry_path = Path(entry.path)
            try:
                rel_path = entry_path.relative_to(self._watch_dir).as_posix()
            except ValueError:
                # Symlinks or oddities outside the watch dir: fall back to
                # basename so the lookup degrades gracefully instead of
                # raising.
                rel_path = entry.name
            if _stat_in_dedup_index(dedup_index, rel_path, st.st_size, st.st_mtime):
                skipped += 1
                continue
            # Pass `st` through so `_enqueue` doesn't issue a redundant
            # stat() syscall. ``DirEntry.stat()`` returns the same
            # ``os.stat_result`` shape as ``Path.stat()`` so the call
            # site doesn't care which producer it came from.
            self._enqueue(entry_path, stat_result=st)
            queued += 1
            if total % 100 == 0:
                logger.info(
                    "Initial scan progress: %d scanned, %d queued, %d skipped",
                    total,
                    queued,
                    skipped,
                )

        logger.info(
            "Initial scan complete: %d scanned, %d queued, %d skipped",
            total,
            queued,
            skipped,
        )

    # ------------------------------------------------------------------
    # stability tracking
    # ------------------------------------------------------------------

    def _enqueue(self, path: Path, *, stat_result: os.stat_result | None = None) -> None:
        """Add or refresh a file in the pending-stability dict.

        *stat_result* lets callers that already hold a fresh `stat()`
        (notably `_initial_scan`) avoid a redundant syscall. Watchdog
        event callbacks don't have one and pass `None`.
        """
        if stat_result is None:
            try:
                stat_result = path.stat()
            except OSError:
                return
        with self._lock:
            existing = self._pending.get(path)
            if existing is None:
                self._pending[path] = _PendingFile(
                    path=path, size=stat_result.st_size, mtime=stat_result.st_mtime
                )
            else:
                if stat_result.st_size != existing.size or stat_result.st_mtime != existing.mtime:
                    existing.size = stat_result.st_size
                    existing.mtime = stat_result.st_mtime
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
            if self._reporter is not None:
                self._reporter.report_error(
                    "stability_timeout",
                    f"File {path.name} did not stabilise within {MAX_STABILITY_WAIT_SECONDS}s",
                    path=str(path),
                    max_wait_seconds=MAX_STABILITY_WAIT_SECONDS,
                )

        for path in stable:
            logger.info("File stable: %s", path)
            try:
                self._on_stable(path)
            except Exception as exc:
                logger.exception("Callback failed for %s", path)
                if self._reporter is not None:
                    self._reporter.report_error(
                        "stable_callback_failed",
                        f"Stable-file callback failed for {path.name}: {exc}",
                        path=str(path),
                        error=str(exc),
                    )


def _stat_in_dedup_index(
    index: dict[str, list[tuple[int, float]]],
    relative_path: str,
    size_bytes: int,
    mtime: float,
) -> bool:
    """Return True if *index* contains a matching ``(size, mtime)`` for *relative_path*.

    Mirrors the ``ABS(mtime - ?) < 1.0`` tolerance that
    :meth:`StateDB.has_stat_match` and
    :meth:`StateDB.has_detected_stat_match` apply in SQL so the bulk
    lookup behaves identically to the per-row helpers it replaces in
    the initial-scan hot path.
    """
    candidates = index.get(relative_path)
    if not candidates:
        return False
    for cand_size, cand_mtime in candidates:
        if cand_size == size_bytes and abs(cand_mtime - mtime) < _STAT_MTIME_TOLERANCE:
            return True
    return False
