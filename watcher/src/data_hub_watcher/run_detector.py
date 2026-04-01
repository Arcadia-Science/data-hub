"""Run detection: group stable files into instrument runs and report them.

``RunDetector`` receives stable-file notifications from ``FileMonitor``,
groups them by run ID (extracted via prefix regex or parent directory),
reports new / updated runs to the Data Hub API, and — in auto mode —
hands them off to an upload callback immediately after reporting.
"""

from __future__ import annotations
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from data_hub_watcher.api_client import ApiError, DataHubClient
from data_hub_watcher.events import EventReporter, EventType, WatcherEvent
from data_hub_watcher.heartbeat import WatcherCounters
from data_hub_watcher.state import StateDB

logger = logging.getLogger(__name__)


@dataclass
class FileInfo:
    """Metadata about a single detected file within a run."""

    path: Path
    filename: str
    size_bytes: int
    file_id: int | None = None


@dataclass
class RunState:
    """In-memory tracking state for a single run."""

    run_id: str
    files: list[FileInfo] = field(default_factory=list)
    reported: bool = False
    api_run_id: str | None = None
    uploaded_file_count: int = 0


class RunDetector:
    """Groups stable files into runs and reports them to the API.

    Parameters
    ----------
    method:
        ``"prefix"`` or ``"directory"``.
    prefix_pattern:
        Regex with one capture group (only used when *method* is ``"prefix"``).
    instrument_id:
        Instrument ID used in API paths.
    watcher_id:
        Watcher ID for event reporting.
    client:
        ``DataHubClient`` for API calls.
    state_db:
        ``StateDB`` for persistence.
    event_reporter:
        For queuing structured events.
    counters:
        Heartbeat counters to increment on successful reports.
    upload_callback:
        If set, called with ``(run_id, files)`` after a successful report.
        Typically ``Uploader.upload_files`` in auto mode; ``None`` in manual mode.
    watch_directory:
        The root watch directory (used for relative path calculation).
    """

    def __init__(
        self,
        *,
        method: str,
        prefix_pattern: str | None,
        instrument_id: str,
        watcher_id: str,
        client: DataHubClient,
        state_db: StateDB,
        event_reporter: EventReporter,
        counters: WatcherCounters,
        upload_callback: Callable[[str, list[FileInfo]], None] | None = None,
        watch_directory: Path,
    ) -> None:
        self._method = method
        self._prefix_re = re.compile(prefix_pattern) if prefix_pattern else None
        self._instrument_id = instrument_id
        self._watcher_id = watcher_id
        self._client = client
        self._state_db = state_db
        self._reporter = event_reporter
        self._counters = counters
        self._upload_cb = upload_callback
        self._watch_dir = watch_directory

        self._runs: dict[str, RunState] = {}

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
            size = path.stat().st_size
        except OSError:
            logger.warning("File disappeared before run detection: %s", path)
            return

        info = FileInfo(path=path, filename=path.name, size_bytes=size)

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
        if self._method == "prefix":
            return self._extract_prefix(path)
        return self._extract_directory(path)

    def _extract_prefix(self, path: Path) -> str | None:
        if self._prefix_re is None:
            logger.warning("No prefix pattern configured — cannot detect run for %s", path)
            return None
        m = self._prefix_re.match(path.name)
        if not m or not m.group(1):
            logger.warning("File %s does not match prefix pattern — skipping", path.name)
            return None
        return m.group(1)

    def _extract_directory(self, path: Path) -> str | None:
        """In directory mode, the first subdirectory name under the watch dir
        is the run ID.  For example:
            watch_dir/RUN001/data.csv  →  run_id = "RUN001"
        Files sitting directly in the watch dir have no run context and are skipped.
        """
        try:
            rel = path.relative_to(self._watch_dir)
        except ValueError:
            logger.warning("File %s is not inside watch directory — skipping", path)
            return None
        parts = rel.parts
        if len(parts) < 2:
            logger.warning(
                "File %s is directly in watch directory (directory mode needs subdirs) — skipping",
                path,
            )
            return None
        return parts[0]

    # ------------------------------------------------------------------
    # API reporting
    # ------------------------------------------------------------------

    def _file_payload(self, info: FileInfo) -> dict[str, object]:
        try:
            relative_path = str(info.path.relative_to(self._watch_dir))
        except ValueError:
            relative_path = info.filename
        return {
            "relative_path": relative_path,
            "filename": info.filename,
            "size_bytes": info.size_bytes,
        }

    def _report_new_run(self, run: RunState) -> None:
        payload = {
            "run_id": run.run_id,
            "source": "watcher",
            "watcher_id": self._watcher_id,
            "detected_files": [self._file_payload(f) for f in run.files],
        }
        try:
            resp = self._client.report_run(self._instrument_id, payload)
            run.reported = True
            run.api_run_id = resp.id
            self._state_db.record_run_reported(run.run_id)
            self._counters.runs_reported += 1

            file_id_by_name = {rf.filename: rf.id for rf in resp.files}
            for f in run.files:
                if f.filename in file_id_by_name:
                    f.file_id = file_id_by_name[f.filename]

            self._reporter.queue_event(
                WatcherEvent(
                    event_type=EventType.RUN_REPORTED,
                    message=f"Run {run.run_id} reported with {len(run.files)} file(s)",
                    details={"run_id": run.run_id, "file_count": len(run.files)},
                )
            )
            logger.info("Reported new run %s (%d files)", run.run_id, len(run.files))
        except ApiError as exc:
            logger.warning("Failed to report run %s: %s (will retry)", run.run_id, exc.message)
            self._counters.errors += 1
            return

        if self._upload_cb:
            self._upload_cb(run.run_id, list(run.files))
        run.uploaded_file_count = len(run.files)

    def _update_run(self, run: RunState) -> None:
        """PATCH the run with the full file list, then upload only new files.

        The API receives the complete file manifest each time so it can
        reconcile its own state, but the upload callback only gets the files
        that weren't in the previous snapshot to avoid re-uploading.
        """
        payload = {
            "detected_files": [self._file_payload(f) for f in run.files],
        }
        try:
            self._client.update_run(self._instrument_id, run.run_id, payload)
            logger.info("Updated run %s (now %d files)", run.run_id, len(run.files))
        except ApiError as exc:
            logger.warning("Failed to update run %s: %s", run.run_id, exc.message)
            self._counters.errors += 1
            return

        new_files = run.files[run.uploaded_file_count :]
        if self._upload_cb and new_files:
            self._upload_cb(run.run_id, new_files)
        run.uploaded_file_count = len(run.files)

    # ------------------------------------------------------------------
    # crash recovery
    # ------------------------------------------------------------------

    def retry_unreported_runs(self) -> None:
        """Attempt to re-report any runs that failed their initial POST."""
        for run in self._runs.values():
            if not run.reported and run.files:
                logger.info("Retrying unreported run %s", run.run_id)
                self._report_new_run(run)
