"""Run detection: group stable files into instrument runs and report them.

`RunDetector` receives stable-file notifications from `FileMonitor`,
groups them by run ID (extracted via a regex applied to the POSIX-normalized
relative path), reports new / updated runs to the Data Hub API, and — in
auto mode — hands them off to an upload callback immediately after reporting.
"""

from __future__ import annotations
import logging
import os
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from data_hub_watcher.api_client import ApiError, DataHubClient
from data_hub_watcher.events import EventReporter, EventType, WatcherEvent
from data_hub_watcher.heartbeat import WatcherCounters
from data_hub_watcher.state import StateDB

logger = logging.getLogger(__name__)


def file_created_at(st: os.stat_result) -> float:
    """Best-effort on-disk creation time for *st*.

    Prefers `st_birthtime` (macOS, Windows, BSD), which is the true
    creation time. Falls back to `st_mtime` on platforms that don't
    expose birthtime (most Linux filesystems through the legacy stat
    interface) — this is the closest universally-available approximation.
    """
    return getattr(st, "st_birthtime", None) or st.st_mtime


@dataclass
class FileInfo:
    """Metadata about a single detected file within a run."""

    path: Path
    filename: str
    size_bytes: int
    # mtime at stability time. Persisted alongside the run manifest so a
    # future restart's initial scan can cheaply stat-match against it
    # (see `StateDB.has_detected_stat_match`) and skip re-reporting.
    mtime: float = 0.0
    # On-disk creation time (st_birthtime when available, else mtime).
    # Sent to the API and persisted in the state DB so it survives
    # restarts and reflects the original creation time even after the
    # file has been re-stat'd or partially modified.
    file_created_at: float = 0.0


@dataclass
class RunState:
    """In-memory tracking state for a single run."""

    run_id: str
    files: list[FileInfo] = field(default_factory=list)
    reported: bool = False
    api_run_id: str | None = None
    uploaded_file_count: int = 0
    # Number of files at the head of `files` that have been successfully
    # PATCHed to the API. Used as a cursor so `_update_run` can send only
    # newly-stable files instead of re-transmitting the full manifest on
    # every call. On a failed PATCH the cursor is left untouched so the
    # next stable file's PATCH carries the backlog plus the new entry.
    patched_file_count: int = 0
    # Last `acquired_at` value (seconds since epoch) we successfully sent
    # to the API for this run. Used so `_update_run` only PATCHes the
    # field when a later-stabilising file reveals an earlier creation
    # time than what the server already knows.
    acquired_at_sent: float | None = None


def _run_acquired_at(files: list[FileInfo]) -> float | None:
    """Earliest known on-disk creation time across *files*, or None."""
    times = [f.file_created_at for f in files if f.file_created_at]
    return min(times) if times else None


class RunDetector:
    """Groups stable files into runs and reports them to the API.

    Parameters
    ----------
    pattern:
        Regex with exactly one capture group applied to the POSIX-normalized
        relative path (relative to *watch_directory*). Capture group 1 is
        the run ID.
    instrument_id:
        Instrument ID used in API paths.
    watcher_id:
        Watcher ID for event reporting.
    client:
        `DataHubClient` for API calls.
    state_db:
        `StateDB` for persistence.
    event_reporter:
        For queuing structured events.
    counters:
        Heartbeat counters to increment on successful reports.
    upload_callback:
        If set, called with `(run_id, files)` after a successful report.
        Typically `Uploader.upload_files` in auto mode; `None` in manual mode.
    watch_directory:
        The root watch directory (used for relative path calculation).
    """

    def __init__(
        self,
        *,
        pattern: str,
        instrument_id: str,
        watcher_id: str,
        client: DataHubClient,
        state_db: StateDB,
        event_reporter: EventReporter,
        counters: WatcherCounters,
        upload_callback: Callable[[str, list[FileInfo]], int] | None = None,
        watch_directory: Path,
    ) -> None:
        self._pattern = re.compile(pattern)
        self._instrument_id = instrument_id
        self._watcher_id = watcher_id
        self._client = client
        self._state_db = state_db
        self._reporter = event_reporter
        self._counters = counters
        self._upload_cb = upload_callback
        self._watch_dir = watch_directory

        self._runs: dict[str, RunState] = {}
        # Set of parent-directory POSIX paths we've already surfaced a
        # ``kind=pattern_mismatch`` event for. Pattern misses are
        # routine for excluded files, so without throttling a
        # misconfigured pattern (or a deeply nested directory of
        # ignored output) would flood the queue. One event per
        # parent-directory per process is enough for an operator to
        # spot the problem in the dashboard.
        self._pattern_mismatch_dirs: set[str] = set()

    # ------------------------------------------------------------------
    # public entry point (called by FileMonitor)
    # ------------------------------------------------------------------

    def on_stable_file(self, path: Path) -> None:
        """Process a file that has been determined to be stable.

        First file for a given run ID triggers a POST to create the run;
        subsequent files for the same run ID trigger a PATCH to update it.
        """
        run_id = self._extract_run_id(path)
        if run_id is None:
            return

        try:
            st = path.stat()
        except OSError:
            logger.warning("File disappeared before run detection: %s", path)
            return

        info = FileInfo(
            path=path,
            filename=path.name,
            size_bytes=st.st_size,
            mtime=st.st_mtime,
            file_created_at=file_created_at(st),
        )

        run = self._runs.get(run_id)
        if run is None:
            run = RunState(run_id=run_id)
            self._runs[run_id] = run

        # Guard against duplicate stable-file callbacks for the same path
        # (can happen if the file is modified again after stabilising).
        if any(f.path == path for f in run.files):
            return
        run.files.append(info)

        if not run.reported:
            self._report_new_run(run)
        else:
            self._update_run(run)

    # ------------------------------------------------------------------
    # run-ID extraction
    # ------------------------------------------------------------------

    def _extract_run_id(self, path: Path) -> str | None:
        try:
            rel = path.relative_to(self._watch_dir).as_posix()
        except ValueError:
            logger.warning("File %s is not inside watch directory — skipping", path)
            return None
        m = self._pattern.search(rel)
        if not m or not m.group(1):
            # Pattern misses are routine (excluded files inside the
            # watch tree), so this is a debug-level local log. The
            # surfaced event is throttled to one per parent directory
            # per process — that's enough for an operator to catch a
            # misconfigured pattern without flooding the dashboard.
            logger.debug("File %s did not match run_detection.pattern — skipping", rel)
            parent = Path(rel).parent.as_posix()
            if parent not in self._pattern_mismatch_dirs:
                self._pattern_mismatch_dirs.add(parent)
                self._reporter.report_error(
                    "pattern_mismatch",
                    f"File {rel} did not match run_detection.pattern",
                    relative_path=rel,
                )
            return None
        return m.group(1)

    # ------------------------------------------------------------------
    # API reporting
    # ------------------------------------------------------------------

    def _file_payload(self, info: FileInfo) -> dict[str, object]:
        try:
            relative_path = info.path.relative_to(self._watch_dir).as_posix()
        except ValueError:
            relative_path = info.filename
        payload: dict[str, object] = {
            "relative_path": relative_path,
            "filename": info.filename,
            "size_bytes": info.size_bytes,
        }
        if info.file_created_at:
            payload["file_created_at"] = datetime.fromtimestamp(
                info.file_created_at, tz=timezone.utc
            ).isoformat()
        return payload

    def _relative_path(self, info: FileInfo) -> str:
        try:
            return info.path.relative_to(self._watch_dir).as_posix()
        except ValueError:
            return info.filename

    def _persist_detected_files(self, run: RunState) -> None:
        """Record the current `run.files` manifest in the state DB.

        Called after every successful POST / PATCH so that on restart
        the initial scan can skip these files and the run can be
        hydrated back into `_runs` without re-reporting.
        """
        rows = [
            (
                self._relative_path(info),
                info.filename,
                info.size_bytes,
                info.mtime,
                info.file_created_at or None,
            )
            for info in run.files
        ]
        self._state_db.record_detected_files(run.run_id, rows)

    def _report_new_run(self, run: RunState) -> None:
        acquired = _run_acquired_at(run.files)
        payload: dict[str, object] = {
            "run_id": run.run_id,
            "source": "watcher",
            "watcher_id": self._watcher_id,
            "detected_files": [self._file_payload(f) for f in run.files],
        }
        if acquired is not None:
            payload["acquired_at"] = datetime.fromtimestamp(acquired, tz=timezone.utc).isoformat()
        try:
            resp = self._client.report_run(self._instrument_id, payload)
            run.reported = True
            run.api_run_id = resp.id
            run.patched_file_count = len(run.files)
            run.acquired_at_sent = acquired
            self._state_db.record_run_reported(run.run_id)
            self._persist_detected_files(run)
            self._counters.runs_reported += 1

            self._reporter.queue_event(
                WatcherEvent(
                    event_type=EventType.RUN_REPORTED,
                    message=f"Run {run.run_id} reported",
                    details={"run_id": run.run_id},
                )
            )
            logger.info("Reported new run %s (%d files)", run.run_id, len(run.files))
        except ApiError as exc:
            logger.warning("Failed to report run %s: %s (will retry)", run.run_id, exc.message)
            self._counters.errors += 1
            self._reporter.report_error(
                "run_report_failed",
                f"Failed to report run {run.run_id}: {exc.message}",
                run_id=run.run_id,
                operation="create",
                status_code=exc.status_code,
                error=exc.message,
                file_count=len(run.files),
            )
            return

        if self._upload_cb:
            succeeded = self._upload_cb(run.run_id, list(run.files))
            run.uploaded_file_count = succeeded
        else:
            run.uploaded_file_count = len(run.files)

    def _update_run(self, run: RunState) -> None:
        """PATCH the run with files added since the last successful PATCH.

        Only un-PATCHed entries are sent — the server dedups on
        `(instrument_run_id, relative_path)` via a partial unique index,
        so the full manifest carries no extra information. Skipping the
        API call entirely when the delta is empty avoids a needless round
        trip if `on_stable_file` re-fires for an already-reported file.

        On failure the PATCH cursor is left untouched, so the next
        stable file's PATCH naturally carries the backlog plus the new
        entry. The upload callback continues to receive only files the
        uploader hasn't seen yet (`uploaded_file_count` is independent
        of the PATCH cursor).
        """
        new_files = run.files[run.patched_file_count :]
        # An out-of-order stable file may carry an older birthtime than
        # anything we've sent so far; surface that to the server even if
        # the file delta itself is empty (rare but possible).
        acquired = _run_acquired_at(run.files)
        earlier_acquired: float | None = (
            acquired
            if acquired is not None
            and (run.acquired_at_sent is None or acquired < run.acquired_at_sent)
            else None
        )
        if not new_files and earlier_acquired is None:
            return

        payload: dict[str, object] = {
            "detected_files": [self._file_payload(f) for f in new_files],
        }
        if earlier_acquired is not None:
            payload["acquired_at"] = datetime.fromtimestamp(
                earlier_acquired, tz=timezone.utc
            ).isoformat()
        try:
            self._client.update_run(self._instrument_id, run.run_id, payload)
            run.patched_file_count = len(run.files)
            if earlier_acquired is not None:
                run.acquired_at_sent = earlier_acquired
            self._persist_detected_files(run)
            logger.info(
                "Updated run %s (sent %d new file(s), %d total)",
                run.run_id,
                len(new_files),
                len(run.files),
            )
        except ApiError as exc:
            logger.warning("Failed to update run %s: %s", run.run_id, exc.message)
            self._counters.errors += 1
            self._reporter.report_error(
                "run_report_failed",
                f"Failed to update run {run.run_id}: {exc.message}",
                run_id=run.run_id,
                operation="update",
                status_code=exc.status_code,
                error=exc.message,
                file_count=len(run.files),
            )
            return

        upload_new = run.files[run.uploaded_file_count :]
        if self._upload_cb and upload_new:
            succeeded = self._upload_cb(run.run_id, upload_new)
            run.uploaded_file_count += succeeded
        else:
            run.uploaded_file_count = len(run.files)

    # ------------------------------------------------------------------
    # hydration
    # ------------------------------------------------------------------

    def hydrate_from_state_db(self) -> None:
        """Rebuild `_runs` from the `detected_files` table on startup.

        Without this, every restart starts with `_runs = {}` and the
        first stable file per previously-reported run triggers a
        duplicate POST, with subsequent files triggering a storm of
        PATCHes. After hydration, `_runs` already knows about every run
        we've reported, and any genuinely-new file coming through the
        initial scan + watcher correctly routes to `_update_run` (PATCH)
        instead of `_report_new_run` (POST).

        Only runs with a recorded manifest are hydrated. Legacy runs
        that exist in the `runs` table but predate the `detected_files`
        schema fall back to the pre-hydration path — they will
        re-report once, after which their manifest will be persisted
        and future restarts will skip them.
        """
        count = 0
        for run_id in self._state_db.get_reported_run_ids_with_files():
            records = self._state_db.get_detected_files_for_run(run_id)
            if not records:
                continue
            files = [
                FileInfo(
                    path=self._watch_dir / rec.relative_path,
                    filename=rec.filename,
                    size_bytes=rec.size_bytes,
                    mtime=rec.mtime,
                    file_created_at=rec.file_created_at or 0.0,
                )
                for rec in records
            ]
            self._runs[run_id] = RunState(
                run_id=run_id,
                files=files,
                reported=True,
                # On restart every hydrated file is either already
                # uploaded (auto mode, uploader-side dedup will skip it
                # anyway if not) or server-driven (manual mode, where
                # `_upload_cb` is None and this counter is unused).
                uploaded_file_count=len(files),
                # Every hydrated file came from `detected_files`, which
                # is only written after a successful POST/PATCH — so the
                # PATCH cursor starts at the end of the manifest.
                patched_file_count=len(files),
                # Equivalently, the server's `acquired_at` is the floor of
                # what we've persisted in `detected_files`. Seeding the
                # cursor here avoids a redundant PATCH on the first stable
                # file after restart.
                acquired_at_sent=_run_acquired_at(files),
            )
            count += 1
        if count:
            logger.info("Hydrated %d run(s) from state DB", count)
