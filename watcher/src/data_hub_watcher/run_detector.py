"""Run detection: group stable files into instrument runs and report them.

`RunDetector` receives stable-file notifications from `FileMonitor`,
groups them by run ID (extracted via a regex applied to the POSIX-normalized
relative path), reports new / updated runs to the Data Hub API, and — in
auto mode — hands them off to an upload callback immediately after reporting.

After the server accepts a report, everything the next start needs to carry on
is written in one transaction (`StateDB.record_report`): the run, the file
manifest and, in auto mode, a `pending_uploads` row for each file to upload.
Nothing is remembered before the server has accepted the report, and a write
that fails or is cut short by a kill remembers nothing, so the next start's
initial scan reports the files again. A write that fails while the process
goes on is retried with the backoff of a failed report. Until it has gone
through, nothing is uploaded and no further request is sent for the run.

A run that was deleted on Data Hub is refused with a 409 that says so (`is_run_deleted`).
The first refusal is reported once, and the run is remembered in memory (`DeletedRuns`)
until the process ends: its later files send nothing and report nothing, so a forgotten
run with many files in the folder costs one request and one event, not one per file.
Nothing of it is recorded, so the next start asks again.
"""

from __future__ import annotations
import logging
import os
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePath
from typing import Literal

from data_hub_watcher.api_client import ApiError, DataHubClient, is_run_deleted
from data_hub_watcher.constants import (
    RUN_DELETED_REASON,
    RUN_REPORT_RETRY_BASE_DELAY_SECONDS,
    RUN_REPORT_RETRY_MAX_DELAY_SECONDS,
)
from data_hub_watcher.deleted_runs import DeletedRuns
from data_hub_watcher.events import EventReporter, EventType, WatcherEvent
from data_hub_watcher.heartbeat import WatcherCounters
from data_hub_watcher.state import StateDB

logger = logging.getLogger(__name__)

ReportOperation = Literal["create", "update"]


def file_created_at(st: os.stat_result) -> float:
    """Best-effort on-disk creation time for *st*.

    Prefers `st_birthtime` (macOS, Windows, BSD), which is the true
    creation time. Falls back to `st_mtime` on platforms that don't
    expose birthtime (most Linux filesystems through the legacy stat
    interface) — this is the closest universally-available approximation.
    """
    return getattr(st, "st_birthtime", None) or st.st_mtime


def relative_key(path: PurePath, watch_dir: PurePath) -> str:
    """Return *path* as a forward-slash path relative to *watch_dir*.

    This is the key of a file in the state DB (`pending_uploads`,
    `detected_files`, `uploaded_files`, `baseline_files`). The run detector
    writes a file's `pending_uploads` row, the uploader clears it, and the
    monitor's scans look files up by it, so all three compute the key here.
    Falls back to the basename for a path outside the watch directory (e.g.
    one-shot `upload --file /abs/path`) so recording never raises.
    """
    try:
        return path.relative_to(watch_dir).as_posix()
    except ValueError:
        return path.name


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
    # False for a file the report-only rescan found after a config change
    # widened what the watcher sees: it is reported as detected but never
    # handed to the upload callback. Not persisted; a reported file is never
    # uploaded automatically after a restart either.
    upload: bool = True


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
    # next PATCH, from a retry or a new file, carries the backlog.
    patched_file_count: int = 0
    # Last `acquired_at` value (seconds since epoch) we successfully sent
    # to the API for this run. Used so `_update_run` only PATCHes the
    # field when a later-stabilising file reveals an earlier creation
    # time than what the server already knows.
    acquired_at_sent: float | None = None
    # The report the server accepted that the state DB doesn't hold yet, or
    # None when it holds them all. It is "create" while the run's own row
    # isn't there (the write after the POST failed), "update" while only the
    # files of a PATCH are missing. The cursors above move when the server
    # accepts a report, whether or not the write worked, so the run is never
    # POSTed again and the files it accepted are never sent again. While this
    # is set, `_update_run` writes before it sends anything, so at most one
    # report is ever missing and a refused PATCH can't keep that write from
    # being retried. Never persisted. A kill leaves the state DB without that
    # report, and the next start's initial scan finds the files again.
    unrecorded: ReportOperation | None = None
    # True from the first failed write of an accepted report until a write
    # works. Only the first failed write of a row is reported as an event.
    write_failing: bool = False
    # Failed attempts in a row, whether a report or the write of an accepted
    # one, and the wait before the next retry. A write that works, or a 4xx,
    # starts them over. The due time itself lives on `RunDetector._retry_at`.
    retry_attempts: int = 0
    retry_delay: int = 0


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
    deleted_runs:
        The runs the server refused because they were deleted on Data Hub. Share the
        uploader's, so a run found deleted by either is left alone by both. Defaults to
        a set of its own.
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
        deleted_runs: DeletedRuns | None = None,
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
        # Read here on the stability thread, and added to by the uploader's threads too.
        self._deleted_runs = deleted_runs if deleted_runs is not None else DeletedRuns()

        self._runs: dict[str, RunState] = {}
        # Due time (`time.monotonic()`) of the next retry, by run ID. A run has
        # an entry exactly when its `retry_attempts` is non-zero. Only the
        # monitor's stability-checker thread calls into this class, so no lock.
        self._retry_at: dict[str, float] = {}
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

    def on_stable_file(self, path: Path, *, upload: bool = True) -> None:
        """Process a file that has been determined to be stable.

        First file for a given run ID triggers a POST to create the run;
        subsequent files for the same run ID trigger a PATCH to update it.

        With ``upload=False`` the file is reported but never passed to the
        upload callback, even in auto mode (see `FileMonitor`'s
        ``report_only``).
        """
        run_id = self._extract_run_id(path)
        if run_id is None:
            return

        if run_id in self._deleted_runs:
            # Data Hub refused this run as deleted. Nothing is sent, recorded or reported
            # for its files, so the next start finds them still unreported.
            logger.debug("Skipping %s: run %s was deleted on Data Hub", path, run_id)
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
            upload=upload,
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

        # Sent right away even while a retry is waiting, so the run catches up
        # as soon as the server is back. A failure keeps doubling the backoff.
        self._send_report(run)

    def retry_failed_reports(self) -> None:
        """Retry the run that has waited longest, if its retry is due.

        Sends at most one request per call. A request to a slow server can
        block until `DEFAULT_TIMEOUT` runs out, and the monitor's file checks
        share this thread.
        """
        now = time.monotonic()
        due = [(at, run_id) for run_id, at in self._retry_at.items() if at <= now]
        if not due:
            return
        _, run_id = min(due)
        del self._retry_at[run_id]
        run = self._runs[run_id]
        if run_id in self._deleted_runs:
            # The uploader found the run deleted while this retry waited.
            self._clear_retry(run)
            return
        self._send_report(run)

    def _send_report(self, run: RunState) -> None:
        if run.reported:
            self._update_run(run)
        else:
            self._report_new_run(run)

    def _clear_retry(self, run: RunState) -> None:
        run.retry_attempts = 0
        run.retry_delay = 0
        self._retry_at.pop(run.run_id, None)

    def _note_report_success(self, run: RunState) -> None:
        if run.retry_attempts:
            logger.info(
                "Run %s recovered after %d failed attempt(s)", run.run_id, run.retry_attempts
            )
        self._clear_retry(run)

    def _handle_report_failure(
        self, run: RunState, operation: ReportOperation, exc: Exception
    ) -> None:
        """Count a failed POST or PATCH, report it, and schedule a retry if it can help."""
        if is_run_deleted(exc):
            self._handle_run_deleted(run, operation, exc)
            return
        verb = "report" if operation == "create" else "update"
        if isinstance(exc, ApiError):
            status_code, error, retryable = exc.status_code, exc.message, exc.is_transient
            logger.warning("Failed to %s run %s: %s", verb, run.run_id, error)
        else:
            # Anything else the client raises, such as a connection that drops
            # mid-response or a proxy's HTML page instead of JSON, is retried
            # like a connection error.
            status_code, error, retryable = 0, f"{type(exc).__name__}: {exc}", True
            logger.warning("Failed to %s run %s: %s", verb, run.run_id, error, exc_info=exc)
        self._counters.errors += 1
        # Report the first retryable failure in a row and every 4xx, so a long
        # outage doesn't push other events out of the bounded queue. A failed
        # write never hides a failed report here: no request goes out while a
        # write is owed, and a write that works resets `retry_attempts`.
        if run.retry_attempts == 0 or not retryable:
            self._reporter.report_error(
                "run_report_failed",
                f"Failed to {verb} run {run.run_id}: {error}",
                run_id=run.run_id,
                operation=operation,
                status_code=status_code,
                error=error,
                file_count=len(run.files),
            )
        if retryable:
            self._schedule_retry(run)
        else:
            self._clear_retry(run)

    def _handle_run_deleted(self, run: RunState, operation: ReportOperation, exc: ApiError) -> None:
        """Stop reporting *run*, which the server refused because it was deleted on Data Hub.

        Remembers the run for the life of the process, so no later file of it sends a request
        (`on_stable_file`) and no retry does (`retry_failed_reports`). Counts one error and
        queues one ``run_report_failed`` event, with the reason in its details, however many
        files the run has. When the uploader has met the refusal first, it has said so, and
        nothing more is reported. A 409 is never retried, so this ends any retry that was
        scheduled. The run's files are not recorded, so the next start tries once more.
        """
        self._clear_retry(run)
        if not self._deleted_runs.add(run.run_id):
            logger.debug("Run %s was already known to be deleted on Data Hub", run.run_id)
            return
        verb = "report" if operation == "create" else "update"
        logger.warning(
            "Failed to %s run %s: %s (the run was deleted on Data Hub, so its files are not "
            "reported again until the watcher restarts)",
            verb,
            run.run_id,
            exc.message,
        )
        self._counters.errors += 1
        self._reporter.report_error(
            "run_report_failed",
            f"Failed to {verb} run {run.run_id}: {exc.message}",
            run_id=run.run_id,
            operation=operation,
            status_code=exc.status_code,
            error=exc.message,
            file_count=len(run.files),
            reason=RUN_DELETED_REASON,
        )

    def _handle_write_failure(self, run: RunState, exc: Exception) -> None:
        """Count a failed write of a report the server accepted, report it, and retry it.

        While a write is owed `_update_run` sends no request, so the retry and
        a new file of the run only try the write again. They share the backoff
        of a failed POST or PATCH, and a failure keeps doubling it. Only the
        first failed write of a row is reported, so a state DB that stays
        unwritable (a full disk) costs one event, not one per file. The
        detector reports the failure itself, and doesn't raise it, because a
        retry runs from the monitor's tick, which logs an exception and sends
        no event.
        """
        error = f"{type(exc).__name__}: {exc}"
        logger.warning(
            "Failed to record run %s in the state DB: %s", run.run_id, error, exc_info=exc
        )
        self._counters.errors += 1
        if not run.write_failing:
            run.write_failing = True
            self._reporter.report_error(
                "state_write_failed",
                f"Failed to record run {run.run_id} in the state database: {error}",
                run_id=run.run_id,
                error=error,
                file_count=len(run.files),
            )
        self._schedule_retry(run)

    def _schedule_retry(self, run: RunState) -> None:
        run.retry_delay = (
            min(run.retry_delay * 2, RUN_REPORT_RETRY_MAX_DELAY_SECONDS)
            if run.retry_delay
            else RUN_REPORT_RETRY_BASE_DELAY_SECONDS
        )
        run.retry_attempts += 1
        self._retry_at[run.run_id] = time.monotonic() + run.retry_delay
        logger.info(
            "Will retry run %s in %ds (%d failed attempt(s) so far)",
            run.run_id,
            run.retry_delay,
            run.retry_attempts,
        )

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
        payload: dict[str, object] = {
            "relative_path": relative_key(info.path, self._watch_dir),
            "filename": info.filename,
            "size_bytes": info.size_bytes,
        }
        if info.file_created_at:
            payload["file_created_at"] = datetime.fromtimestamp(
                info.file_created_at, tz=timezone.utc
            ).isoformat()
        return payload

    def _record_and_upload(self, run: RunState) -> bool:
        """Remember in the state DB what the server has accepted for *run*, then upload it.

        The server has accepted `run.files[:run.patched_file_count]`. This
        stores that manifest, so that on restart the initial scan can skip
        these files and the run can be hydrated back into `_runs` without
        re-reporting, and (while `run.unrecorded` is "create") the run itself.
        In auto mode it also queues the files not uploaded yet in
        `pending_uploads`, so the next start retries any upload that did not
        finish. Everything goes in one transaction (see
        `StateDB.record_report`), so a write that fails leaves none of it.

        Returns False after a failed write, with a retry scheduled and the
        failure reported. Nothing is uploaded then, so a kill during an upload
        always leaves a `pending_uploads` row, and the caller sends no request
        until a write has gone through. Returns True once the state DB holds
        it, which also ends any retry, and the upload callback has returned.
        """
        accepted = run.files[: run.patched_file_count]
        not_uploaded = accepted[run.uploaded_file_count :]
        upload_new = [f for f in not_uploaded if f.upload]
        rows = [
            (
                relative_key(info.path, self._watch_dir),
                info.filename,
                info.size_bytes,
                info.mtime,
                info.file_created_at or None,
            )
            for info in accepted
        ]
        try:
            self._state_db.record_report(
                run.run_id,
                rows,
                new_run=run.unrecorded == "create",
                pending_relative_paths=(
                    [relative_key(f.path, self._watch_dir) for f in upload_new]
                    if self._upload_cb
                    else []
                ),
            )
        except Exception as exc:
            self._handle_write_failure(run, exc)
            return False
        run.unrecorded = None
        run.write_failing = False
        self._note_report_success(run)

        if self._upload_cb and upload_new:
            succeeded = self._upload_cb(run.run_id, upload_new)
            # Report-only files count as handled so the cursor moves past them.
            run.uploaded_file_count += succeeded + (len(not_uploaded) - len(upload_new))
        else:
            run.uploaded_file_count = len(accepted)
        return True

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
        except Exception as exc:
            self._handle_report_failure(run, "create", exc)
            return

        # The server has the run and every file so far, so the cursors move now
        # and the run is POSTed no more, even if the write below fails.
        run.reported = True
        run.api_run_id = resp.id
        run.patched_file_count = len(run.files)
        run.acquired_at_sent = acquired
        run.unrecorded = "create"
        self._counters.runs_reported += 1

        self._reporter.queue_event(
            WatcherEvent(
                event_type=EventType.RUN_REPORTED,
                message=f"Run {run.run_id} reported",
                details={"run_id": run.run_id},
            )
        )
        logger.info("Reported new run %s (%d files)", run.run_id, len(run.files))

        self._record_and_upload(run)

    def _update_run(self, run: RunState) -> None:
        """PATCH the run with files added since the last successful PATCH.

        Only un-PATCHed entries are sent — the server dedups on
        `(instrument_run_id, relative_path)` via a partial unique index,
        so the full manifest carries no extra information. Skipping the
        API call entirely when the delta is empty avoids a needless round
        trip if `on_stable_file` re-fires for an already-reported file.

        On failure the PATCH cursor is left untouched, so a scheduled retry
        or the next stable file's PATCH carries the backlog (plus the new
        entry). When a PATCH went through and writing it to the state DB
        failed, the cursor has moved, because the server has the files. Then
        nothing more is sent until a write has gone through
        (`RunState.unrecorded`): a scheduled retry only writes, and a new
        file waits in `run.files` until the write works, when one PATCH
        carries everything added since. The write goes first because a PATCH
        that fails for good (a 4xx) cancels the retry, and would leave the
        write undone. The upload callback receives only files the uploader
        hasn't seen yet (`uploaded_file_count` is independent of the PATCH
        cursor, and a failed write leaves it where it was).
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
        if not new_files and earlier_acquired is None and run.unrecorded is None:
            # Nothing is waiting to be sent or written, so a queued retry has
            # no work left.
            self._clear_retry(run)
            return

        # With nothing new for the server, only a write is owed: the retry of
        # a write that failed.
        if new_files or earlier_acquired is not None:
            # The state DB has to hold what the server already accepted before
            # the server is sent more. A failed write ends this call with its
            # retry still scheduled.
            if run.unrecorded and not self._record_and_upload(run):
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
            except Exception as exc:
                self._handle_report_failure(run, "update", exc)
                return
            run.patched_file_count = len(run.files)
            if earlier_acquired is not None:
                run.acquired_at_sent = earlier_acquired
            run.unrecorded = "update"
            logger.info(
                "Updated run %s (sent %d new file(s), %d total)",
                run.run_id,
                len(new_files),
                len(run.files),
            )

        self._record_and_upload(run)

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
                # Auto mode retries unfinished uploads from the state DB's
                # `pending_uploads` on the upload worker, not from here.
                # Manual mode has no `_upload_cb`, so the counter is unused.
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
