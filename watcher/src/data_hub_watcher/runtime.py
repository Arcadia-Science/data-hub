"""Shared runtime wiring for the watcher's long-running loop.

The CLI `watch` command and the Windows-service `SvcDoRun` entrypoint both
need to assemble the same graph of objects (`StateDB`, `EventReporter`,
`Uploader`, `RunDetector`, `FileMonitor`, `HeartbeatLoop`) and start /
stop them in the same order. Keeping that wiring in one place prevents
the two call sites from drifting — a historical source of bugs, notably
the Windows-service path forgetting to pass `on_tick` to `HeartbeatLoop`
and thereby silently skipping manual-mode upload-queue polling.
"""

from __future__ import annotations
import functools
import json
import logging
import re
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

from data_hub_watcher import config_io
from data_hub_watcher.api_client import ApiError, DataHubClient
from data_hub_watcher.constants import (
    CONFIG_APPLY_DRAIN_TIMEOUT_SECONDS,
    DEFAULT_CONFIG_DIR,
    HEARTBEAT_INTERVAL_SECONDS,
    PRUNE_DAYS,
    UPLOAD_WORKER_STOP_TIMEOUT_SECONDS,
)
from data_hub_watcher.events import EventReporter, EventType, WatcherEvent
from data_hub_watcher.heartbeat import HeartbeatLoop, WatcherCounters
from data_hub_watcher.models import (
    ConfigRevisionResponse,
    WatcherConfig,
    watch_directory_problem,
)
from data_hub_watcher.monitor import FileMonitor
from data_hub_watcher.remote_config import (
    RevisionRejected,
    config_with_revision,
    folder_changed,
    report_only_predicate,
    settings_match,
    widens_scope,
)
from data_hub_watcher.run_detector import RunDetector
from data_hub_watcher.state import CONFIG_REVISION_UNSENT_RESULT_META_KEY, StateDB
from data_hub_watcher.updater import Updater, evaluate_upgrade_marker
from data_hub_watcher.upgrade_worker import (
    clear_upgrade_request,
    clear_upgrade_result,
    read_upgrade_result,
)
from data_hub_watcher.uploader import Uploader, UploadQueueWorker

logger = logging.getLogger(__name__)


@dataclass
class WatcherRuntime:
    """Bundle of all long-lived objects for a running watcher session."""

    state_db: StateDB
    counters: WatcherCounters
    reporter: EventReporter
    uploader: Uploader
    detector: RunDetector
    monitor: FileMonitor
    heartbeat: HeartbeatLoop
    updater: Updater
    # Directory the upgrade machinery uses for its on-disk sentinels
    # (``.upgrade-request.json`` / ``.upgrade-result.json`` / the
    # ``.upgrade-in-progress`` marker). The CLI and the Windows service
    # resolve this differently: the CLI runs as the operator user, so
    # ``DEFAULT_CONFIG_DIR`` resolves to ``~/.data-hub`` and is correct;
    # the service runs as LocalSystem, where ``~`` is the SYSTEM profile
    # rather than the operator's home, so the service reads its config
    # path from the registry and threads ``config_path.parent`` through
    # here. Without that handoff the service would write sentinels to
    # ``C:\Windows\System32\config\systemprofile\.data-hub\`` while the
    # SYSTEM-owned upgrade worker (whose paths are baked in at install
    # time as the operator user) reads from the operator's profile —
    # the two never meet, the worker logs "no request sentinel", and
    # every auto-update tick silently no-ops.
    config_dir: Path
    # Set when the in-process updater has successfully installed a new
    # watcher version and wants the main loop to exit non-zero so the
    # Windows SCM (or a foreground operator running ``watch``) restarts
    # us into the new code. The CLI / service main loops poll this event
    # in their stop wait so a shutdown can be triggered from any thread.
    shutdown_event: threading.Event = field(default_factory=threading.Event)
    upgrade_restart_event: threading.Event = field(default_factory=threading.Event)
    # The thread that polls the upload queue off the heartbeat. Always set by
    # ``build_runtime``; ``None`` only in tests that build a runtime by hand.
    upload_worker: UploadQueueWorker | None = None


@dataclass(frozen=True)
class ShutdownReason:
    """Why the runtime is shutting down + the matching WATCHER_STOPPED message.

    The CLI ``watch`` command and the Windows service both poll the
    runtime's ``shutdown_event`` and need to attribute the resulting
    ``WATCHER_STOPPED`` event to either a normal stop or an
    auto-update-driven restart. Centralising the message text here keeps
    the two paths in sync — historically the service path always logged
    "Service stopped" even on auto-update restarts, which made it
    impossible to correlate an ``update_started`` event with the
    matching ``watcher_stopped`` event in the dashboard.
    """

    is_upgrade_restart: bool
    stopped_message: str


# uv's diagnostic lines start with ``error:`` (or ``Error:`` on a few
# legacy code paths). Anchoring on the prefix lets us pick the actual
# failure headline rather than picking up an incidental "error" /
# "failed" inside an informational stderr line — e.g. progress chatter
# from a vendored library that mentions "no errors so far".
_UV_ERROR_LINE_RE = re.compile(r"^\s*error\s*:\s*(.+)$", re.IGNORECASE)


def _summarize_worker_failure(result: object) -> str:
    """Produce a short, human-readable reason from an :class:`UpgradeResult`.

    The dashboard event message is one line wide. We try, in order:

    1. The first stderr line matching uv's ``error: <msg>`` convention —
       this is uv's own headline for the actual failure.
    2. As a fallback, the first stderr line whose lowercase text
       contains ``error`` / ``failed`` / ``denied``. Covers tools that
       don't follow the ``error:`` convention (PowerShell traps,
       Windows API errors echoed by the worker).
    3. The worker's own ``error`` field, populated when uv couldn't
       even be launched (e.g. ENOENT) so PowerShell trapped the
       exception.
    4. A generic ``uv exited <N>`` if all we have is the returncode.

    The full stdout/stderr tails are still attached to the event
    details — this helper only picks the headline.
    """
    from data_hub_watcher.upgrade_worker import UpgradeResult

    if not isinstance(result, UpgradeResult):
        return "worker reported failure"

    if result.stderr_tail:
        # Cap each candidate line so the event message stays one line
        # wide — the full text is still in ``worker_stderr_tail`` for
        # the dashboard expand.
        for line in result.stderr_tail.splitlines():
            stripped = line.strip()
            match = _UV_ERROR_LINE_RE.match(stripped)
            if match:
                return stripped[:200]

        for line in result.stderr_tail.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            lowered = stripped.lower()
            if "error" in lowered or "failed" in lowered or "denied" in lowered:
                return stripped[:200]

    if result.error:
        return f"worker exception: {result.error[:200]}"

    if result.returncode not in (0, None):
        return f"uv exited {result.returncode}"

    return "worker reported failure"


def _expecting_worker_result(outcome: object) -> bool:
    """Return whether the marker we just consumed was a worker dispatch.

    Today this is only true on Windows (the worker is the sole
    out-of-process upgrade path). Pulled out as a helper so we can
    grow it later (e.g. a per-marker ``via_worker`` flag) without
    duplicating the gating logic at every call site.
    """
    return sys.platform == "win32"


def classify_shutdown(rt: WatcherRuntime, *, role: str) -> ShutdownReason:
    """Pick the right ``stopped_message`` for the WATCHER_STOPPED event.

    *role* is the human-readable noun for this entrypoint
    (``"Watcher"`` for the CLI, ``"Service"`` for the Windows service)
    so the message reads naturally in the events stream regardless of
    which path triggered the shutdown.

    Note: the CLI's signal-initiated stop has its own "stopped by user"
    message and does not go through this helper — at that point we
    already know the cause is an operator signal, not the auto-updater.
    """
    if rt.upgrade_restart_event.is_set():
        return ShutdownReason(
            is_upgrade_restart=True,
            stopped_message=f"{role} restarting for auto-update",
        )
    return ShutdownReason(
        is_upgrade_restart=False,
        stopped_message=f"{role} stopped",
    )


def _upgrade_restart_requester(
    shutdown_event: threading.Event, upgrade_restart_event: threading.Event
) -> Callable[[str], None]:
    """The callback the in-process updater calls once a new version is installed."""

    def request(target_version: str) -> None:
        logger.info(
            "Auto-update: requesting service restart to load watcher %s",
            target_version,
        )
        upgrade_restart_event.set()
        shutdown_event.set()

    return request


def build_runtime(
    *,
    client: DataHubClient,
    cfg: WatcherConfig,
    db_path: Path,
    config_dir: Path | None = None,
    reporter: EventReporter | None = None,
    shutdown_event: threading.Event | None = None,
    upgrade_restart_event: threading.Event | None = None,
    report_only: Callable[[str, float], bool] | None = None,
    config_revision: Callable[[], int | None] | None = None,
    on_config_revision: Callable[[int | None], None] | None = None,
) -> WatcherRuntime:
    """Construct the full runtime graph from a validated config.

    The caller is responsible for ensuring `cfg.watcher_id` is set — the
    CLI does this explicitly via a click error, and the service does it
    via a registry lookup. We assert here as a safety net so a silent
    misconfiguration becomes a loud crash.

    *config_dir* is the directory used by the auto-update machinery
    for its on-disk sentinels. Defaults to ``DEFAULT_CONFIG_DIR`` for
    the CLI ``watch`` entrypoint (where ``~`` resolves to the operator's
    home). The Windows service must pass an explicit value derived from
    its registry-stored config path — see the field-level comment on
    :class:`WatcherRuntime` for why.

    The remaining keyword arguments let :class:`WatcherSupervisor` rebuild the
    runtime in place: *reporter* and the two events are shared across
    rebuilds, *report_only* marks files for the first scan to report without
    uploading (see :class:`FileMonitor`), and *config_revision* /
    *on_config_revision* connect the heartbeat to the config-revision check.
    """
    if not cfg.watcher_id:
        raise ValueError("cfg.watcher_id must be set before building the runtime")

    effective_config_dir = config_dir if config_dir is not None else DEFAULT_CONFIG_DIR

    inst = cfg.instrument
    watcher_id = cfg.watcher_id

    state_db = StateDB(db_path)
    state_db.prune_uploaded_files(PRUNE_DAYS)

    # On a `new-only` environment's first start, the monitor folds backlog
    # baselining into its initial scan (one walk) instead of uploading the
    # pre-existing files. Gated on an empty DB so a real upload/run history is
    # never re-baselined; the gate is read once here, before the scan runs.
    seed_baseline = cfg.resolve_initial_scan() == "new-only" and not state_db.baseline_established()

    counters = WatcherCounters()
    if reporter is None:
        reporter = EventReporter(client, watcher_id)

    if shutdown_event is None:
        shutdown_event = threading.Event()
    if upgrade_restart_event is None:
        upgrade_restart_event = threading.Event()
    request_upgrade_restart = _upgrade_restart_requester(shutdown_event, upgrade_restart_event)

    updater = Updater(
        client=client,
        reporter=reporter,
        counters=counters,
        state_db=state_db,
        cfg=cfg,
        config_dir=effective_config_dir,
        request_upgrade_restart=request_upgrade_restart,
    )

    is_auto = inst.upload_mode == "auto"

    # Shared with the ``UploadQueueWorker`` so a shutdown can interrupt an
    # in-flight upload's backoff and abort between queued files.
    upload_stop_event = threading.Event()

    uploader = Uploader(
        client=client,
        state_db=state_db,
        event_reporter=reporter,
        counters=counters,
        instrument_id=inst.id,
        watcher_id=watcher_id,
        watch_directory=inst.watch_directory,
        # The most S3 PUTs (files and parts) this watcher runs at once.
        # Defaulted on the model, so older configs inherit it.
        upload_parallelism=inst.upload_parallelism,
        stop_event=upload_stop_event,
    )

    # Both modes poll the server queue so "Request upload" works everywhere.
    # Auto mode also uploads through the run detector's callback on the
    # stability-checker thread, and retries unfinished uploads at startup.
    upload_worker = UploadQueueWorker(
        uploader,
        stop_event=upload_stop_event,
        retry_pending_on_start=is_auto,
    )

    detector = RunDetector(
        pattern=inst.run_detection.pattern,
        instrument_id=inst.id,
        watcher_id=watcher_id,
        client=client,
        state_db=state_db,
        event_reporter=reporter,
        counters=counters,
        upload_callback=uploader.upload_files if is_auto else None,
        watch_directory=inst.watch_directory,
    )

    monitor = FileMonitor(
        watch_directory=inst.watch_directory,
        file_patterns=inst.file_patterns,
        stability_period=inst.stability_period_seconds,
        max_stability_wait_seconds=inst.max_stability_wait_seconds,
        on_stable_file=detector.on_stable_file,
        on_tick=detector.retry_failed_reports,
        state_db=state_db,
        recursive=inst.run_detection.recursive,
        event_reporter=reporter,
        seed_baseline=seed_baseline,
        report_only=report_only,
        on_report_only_file=functools.partial(detector.on_stable_file, upload=False),
    )

    # Feeds the in-process auto-updater on every tick. Upload-queue polling
    # used to run here too but moved to ``UploadQueueWorker`` so a slow
    # upload can't delay a heartbeat.
    def _on_tick() -> None:
        try:
            updater.on_tick()
        except Exception:
            logger.exception("Updater tick failed")

    heartbeat = HeartbeatLoop(
        client=client,
        watcher_id=watcher_id,
        interval_seconds=HEARTBEAT_INTERVAL_SECONDS,
        event_reporter=reporter,
        instrument_id=inst.id,
        watch_directory=str(inst.watch_directory),
        upload_mode=inst.upload_mode,
        counters=counters,
        on_tick=_on_tick,
        config_revision=config_revision,
        on_config_revision=on_config_revision,
    )

    return WatcherRuntime(
        state_db=state_db,
        counters=counters,
        reporter=reporter,
        uploader=uploader,
        detector=detector,
        monitor=monitor,
        heartbeat=heartbeat,
        updater=updater,
        config_dir=effective_config_dir,
        shutdown_event=shutdown_event,
        upgrade_restart_event=upgrade_restart_event,
        upload_worker=upload_worker,
    )


def start_runtime(rt: WatcherRuntime, *, started_message: str) -> None:
    """Queue the started event, recover unreported runs, then start threads.

    The `started_message` varies by entry point (`"Watcher started on …"`
    from the CLI vs `"Service started on …"` from the Windows service)
    so operators can tell from the event log which code path launched.

    Also inspects the on-disk upgrade marker before any threads start so
    a recently-attempted self-update is reported as
    ``UPDATE_SUCCEEDED`` / ``UPDATE_FAILED`` from this fresh process,
    not from the doomed old process that asked for the restart.
    """
    rt.reporter.queue_event(
        WatcherEvent(
            event_type=EventType.WATCHER_STARTED,
            message=started_message,
        )
    )

    outcome = evaluate_upgrade_marker(rt.config_dir)
    if outcome.found:
        # Out-of-process upgrades (the Windows uv-tool worker) drop a
        # ``.upgrade-result.json`` sentinel alongside the marker. The
        # worker's exit code is more authoritative than the marker
        # comparison: a partial install can update some files (and
        # even report a matching version on restart) while uv itself
        # exited non-zero halfway through — historically those
        # "partial" failures masqueraded as "expected X, running Y"
        # and the actual installer error never surfaced to the
        # dashboard. Trust the worker's ``succeeded`` flag whenever
        # it's present.
        worker_result = read_upgrade_result(rt.config_dir)

        worker_failed = worker_result is not None and not worker_result.succeeded
        worker_warned = (
            worker_result is not None
            and worker_result.succeeded
            and (worker_result.returncode not in (0, None) or worker_result.error)
        )

        if worker_failed:
            assert worker_result is not None
            # Worker explicitly reported failure. Build a concrete
            # reason from its captured output so the dashboard event
            # tells the operator exactly which uv error fired,
            # rather than the generic "expected X, running Y" that
            # the marker comparison alone would produce.
            reason = _summarize_worker_failure(worker_result)
            details: dict[str, object] = {
                "previous_version": outcome.previous_version,
                "target_version": outcome.target_version,
                "reason": reason,
                "via_worker": True,
                "worker_returncode": worker_result.returncode,
                "worker_stdout_tail": worker_result.stdout_tail,
                "worker_stderr_tail": worker_result.stderr_tail,
                "worker_error": worker_result.error,
                "worker_request_id": worker_result.request_id,
                # The marker's own classification is preserved as
                # ``marker_reason`` so the dashboard can show "uv
                # said: X / marker said: Y" when they disagree.
                "marker_succeeded": outcome.succeeded,
                "marker_reason": outcome.reason,
            }
            rt.reporter.queue_event(
                WatcherEvent(
                    event_type=EventType.UPDATE_FAILED,
                    message=f"Watcher upgrade to {outcome.target_version} failed: {reason}",
                    details=details,
                )
            )
        elif outcome.succeeded:
            details = {
                "previous_version": outcome.previous_version,
                "target_version": outcome.target_version,
            }
            if worker_result is not None:
                details["via_worker"] = True
                details["worker_returncode"] = worker_result.returncode
                details["worker_stdout_tail"] = worker_result.stdout_tail
                details["worker_stderr_tail"] = worker_result.stderr_tail
                details["worker_request_id"] = worker_result.request_id
                # If the worker reported success but had non-empty
                # stderr or a non-zero returncode that we tolerated
                # (e.g. uv printing a deprecation warning to stderr),
                # surface that as a soft warning alongside the
                # success event so an operator can investigate
                # without being paged.
                if worker_warned:
                    details["worker_warning"] = True
            rt.reporter.queue_event(
                WatcherEvent(
                    event_type=EventType.UPDATE_SUCCEEDED,
                    message=(
                        f"Restarted into upgraded watcher "
                        f"{outcome.previous_version} -> {outcome.target_version}"
                    ),
                    details=details,
                )
            )
        else:
            # No worker result OR worker said success but the
            # restart didn't actually load the new version. In
            # either case the marker's "expected X, running Y"
            # classification is the most informative signal.
            details = {
                "previous_version": outcome.previous_version,
                "target_version": outcome.target_version,
                "reason": outcome.reason,
            }
            if worker_result is not None:
                details["via_worker"] = True
                details["worker_returncode"] = worker_result.returncode
                details["worker_stdout_tail"] = worker_result.stdout_tail
                details["worker_stderr_tail"] = worker_result.stderr_tail
                details["worker_error"] = worker_result.error
                details["worker_request_id"] = worker_result.request_id
            elif _expecting_worker_result(outcome):
                # Marker says we dispatched via the worker (target
                # known, this is a Windows host) but no result
                # sentinel landed. Either the worker crashed mid-run
                # or never started. Surface that explicitly so an
                # operator knows to check ``upgrade-worker.log``.
                details["worker_result_missing"] = True
            rt.reporter.queue_event(
                WatcherEvent(
                    event_type=EventType.UPDATE_FAILED,
                    message=f"Watcher upgrade did not take effect: {outcome.reason}",
                    details=details,
                )
            )

        # Always clear both worker sentinels on the post-restart
        # inspection so a stale result from a prior upgrade can't
        # leak into the next one. Mirrors the marker's "consumed on
        # read" lifecycle in ``evaluate_upgrade_marker``.
        clear_upgrade_result(rt.config_dir)
        clear_upgrade_request(rt.config_dir)

    # Rebuild in-memory run state from the local DB before any file
    # events fire. Without this, every restart starts with an empty
    # `_runs` dict and the initial scan would re-POST / re-PATCH runs
    # that were already reported in a previous session. Must happen
    # before `monitor.start()`, which runs the initial scan and may
    # route files through `_update_run` based on hydrated state.
    rt.detector.hydrate_from_state_db()

    rt.heartbeat.start()
    # Start upload polling before the (potentially long) initial scan so
    # queued uploads keep draining while the scan walks the backlog.
    if rt.upload_worker is not None:
        rt.upload_worker.start()
    rt.monitor.start()


@dataclass(frozen=True)
class ConfigSyncResult:
    """Outcome of :func:`sync_config_to_api`."""

    # A push was attempted (the remote checksum differed or was missing).
    pushed: bool
    # The checksum check, and the push if one was attempted, succeeded.
    ok: bool
    # Checksum of the local file, or `None` if the check failed first.
    checksum: str | None = None
    # `config_revision` from the push response: the server's highest revision.
    # `None` without a push, or from a server that predates config revisions.
    config_revision: int | None = None


def sync_config_to_api(
    client: DataHubClient,
    watcher_id: str,
    path: Path,
    reporter: EventReporter,
    *,
    trigger: str = "startup",
    based_on_revision: int | None = None,
) -> ConfigSyncResult:
    """Push the local config to the API if it differs from the remote.

    Reporter-aware sibling of ``cli._push_config_to_api`` used by the
    long-running ``watch`` and Windows-service entrypoints. On a
    successful push it queues ``EventType.CONFIG_SYNCED`` (mirroring
    the operator-facing CLI helper) so a dashboard observer can tell
    the watcher caught up to a freshly-edited config. On any API
    failure -- the checksum probe or the push itself -- it queues a
    structured ``kind=config_sync_failed`` ``ERROR`` event so the
    failure is visible centrally rather than only as a yellow startup
    message that nobody reads on a headless lab PC.

    The push carries *based_on_revision* (the highest config revision this
    watcher had applied) and the file's modification time. The server uses
    them to settle an edit made on the PC while a web change was pending.
    """
    # Lazy import so monkey-patching ``config_io.config_checksum`` in
    # tests is observed inside this function (a top-level
    # ``from config_io import config_checksum`` would bind the original
    # at import time and miss the patch).
    from data_hub_watcher.config_io import config_checksum

    try:
        local_checksum = config_checksum(path)
        remote = client.get_config_checksum(watcher_id)
    except ApiError as exc:
        reporter.report_error(
            "config_sync_failed",
            f"Could not check remote config checksum: {exc.message}",
            error=exc.message,
        )
        return ConfigSyncResult(pushed=False, ok=False)

    if remote is not None and remote.config_checksum == local_checksum:
        return ConfigSyncResult(pushed=False, ok=True, checksum=local_checksum)

    try:
        yaml_content = path.read_text(encoding="utf-8")
        modified_at = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
        response = client.push_config(
            watcher_id,
            yaml_content,
            local_checksum,
            based_on_revision=based_on_revision,
            modified_at=modified_at,
        )
    except ApiError as exc:
        reporter.report_error(
            "config_sync_failed",
            f"Could not push config to API: {exc.message}",
            checksum=local_checksum,
            error=exc.message,
        )
        return ConfigSyncResult(pushed=True, ok=False, checksum=local_checksum)

    reporter.queue_event(
        WatcherEvent(
            event_type=EventType.CONFIG_SYNCED,
            message=f"Config synced (trigger={trigger})",
            details={"trigger": trigger},
        )
    )
    revision = getattr(response, "config_revision", None)
    return ConfigSyncResult(
        pushed=True,
        ok=True,
        checksum=local_checksum,
        config_revision=revision if isinstance(revision, int) else None,
    )


def stop_runtime(rt: WatcherRuntime, *, stopped_message: str) -> None:
    """Shut everything down in reverse order and flush pending events."""
    rt.monitor.stop()
    # ``StateDB.close`` assumes writer threads have joined; a large upload
    # outliving the join once wrote post-close. Stop the worker first, and if
    # it won't stop in time, skip the close rather than race it (the OS reaps).
    # The worker's file and part threads are daemon threads, so a PUT still in
    # flight does not hold the process open past this join. That file is
    # retried at the next start, from ``pending_uploads`` or the server's queue.
    upload_worker_stopped = True
    if rt.upload_worker is not None:
        upload_worker_stopped = rt.upload_worker.stop(timeout=UPLOAD_WORKER_STOP_TIMEOUT_SECONDS)
        if not upload_worker_stopped:
            logger.warning(
                "Upload worker still running at shutdown; leaving the state DB "
                "open so the in-flight upload can finish without a closed-DB error"
            )
    rt.reporter.queue_event(
        WatcherEvent(
            event_type=EventType.WATCHER_STOPPED,
            message=stopped_message,
        )
    )
    rt.heartbeat.stop()
    rt.reporter.flush()
    if upload_worker_stopped:
        rt.state_db.close()


# ---------------------------------------------------------------------------
# Supervisor: config revisions, the waiting state and in-place rebuilds
# ---------------------------------------------------------------------------


@dataclass
class _WaitingMode:
    """What runs while the watch folder is missing: a heartbeat and the updater."""

    reason: str
    heartbeat: HeartbeatLoop
    updater: Updater


def _read_config_identity(path: Path) -> tuple[str | None, str | None, str | None] | None:
    """``(environment, watcher_id, instrument_id)`` from the config file, or `None`.

    Reads the YAML directly rather than through `load_config`, which also
    walks the watch folder to warn about files that don't match.
    """
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        return None
    if not isinstance(data, dict):
        return None
    environment = data.get("environment")
    watcher_ids = data.get("watcher_ids")
    if isinstance(watcher_ids, dict):
        watcher_id = watcher_ids.get(environment)
    else:
        watcher_id = data.get("watcher_id")
    instrument = data.get("instrument")
    instrument_id = instrument.get("id") if isinstance(instrument, dict) else None
    return environment, watcher_id, instrument_id


class WatcherSupervisor:
    """Runs one watcher session and rebuilds it in place when its config changes.

    The CLI ``watch`` command and the Windows service both create one of these,
    call :meth:`start`, then call :meth:`poll` in a loop until it returns
    `True` or the operator stops them, and finally call :meth:`stop`.

    It adds three things on top of :func:`build_runtime` / :func:`start_runtime`:

    * **Config revisions.** The heartbeat reply carries the server's latest
      config revision. When it is higher than the last revision this watcher
      has seen, :meth:`poll` calls :meth:`apply_config_revision`, which fetches
      it, validates it, writes ``config.yaml`` and rebuilds the runtime.
    * **The waiting state.** If the watch folder is missing or unreadable at
      startup, only a heartbeat (status ``waiting``) and the updater run. Each
      heartbeat tick checks the folder again, and a new revision can fix it.
    * **Startup sync.** Before the monitor starts, the config is pushed with
      ``based_on_revision`` and ``modified_at``, and a pending revision is
      applied first.

    Applying happens on the thread that calls :meth:`poll`, never on the
    heartbeat thread, because the rebuild has to stop and join the heartbeat.
    """

    def __init__(
        self,
        *,
        client: DataHubClient,
        cfg: WatcherConfig,
        config_path: Path,
        db_path: Path,
        config_dir: Path | None = None,
        role: str,
        host: str,
    ) -> None:
        if not cfg.watcher_id:
            raise ValueError("cfg.watcher_id must be set before starting the watcher")
        self.client = client
        self.cfg = cfg
        self.config_path = config_path
        self.db_path = db_path
        self.config_dir = config_dir if config_dir is not None else DEFAULT_CONFIG_DIR
        self.role = role
        self.host = host
        self.watcher_id: str = cfg.watcher_id
        # Shared by every runtime this supervisor builds, so events queued just
        # before a rebuild are flushed by the next heartbeat.
        self.reporter = EventReporter(client, self.watcher_id)
        self.shutdown_event = threading.Event()
        self.upgrade_restart_event = threading.Event()
        self.rt: WatcherRuntime | None = None
        self._waiting: _WaitingMode | None = None
        # Opened in `start`. Separate from each runtime's own `StateDB` handle
        # (same file) because it has to outlive rebuilds and the waiting state.
        self._state: StateDB | None = None
        self._seen: int | None = None
        self._applied: int | None = None
        self._unsent_result: dict[str, Any] | None = None
        # The latest revision the heartbeat reported, for when the server then
        # has no revision to return (so the same number isn't retried forever).
        self._latest_hint: int | None = None
        # Set from the heartbeat thread, handled on the `poll` thread.
        self._wake = threading.Event()
        self._revision_due = threading.Event()
        self._folder_check_due = threading.Event()
        self._result_retry_due = threading.Event()
        # Set when `start` applies a widening revision before anything runs,
        # so the first runtime's scan reports newly matching files only.
        self._startup_report_only: Callable[[str, float], bool] | None = None

    # ------------------------------------------------------------------
    # public API
    # ------------------------------------------------------------------

    @property
    def waiting_reason(self) -> str | None:
        """Why the watcher is waiting, or `None` while it is watching."""
        return self._waiting.reason if self._waiting is not None else None

    @property
    def applied_revision(self) -> int | None:
        return self._applied

    @property
    def seen_revision(self) -> int | None:
        return self._seen

    def start(self) -> None:
        """Sync config, apply a pending revision, then start watching or waiting."""
        self._state = StateDB(self.db_path)
        if self._state.claim_config_revisions(self.watcher_id):
            logger.info(
                "Dropped config revision bookkeeping from a different watcher registration"
            )
        self._seen = self._state.config_revision_seen()
        self._applied = self._state.config_revision_applied()
        self._unsent_result = self._load_unsent_result()
        if self._unsent_result is not None:
            self._send_unsent_result()

        sync = self._push_config(trigger="startup")
        # Without a push there is no revision number to compare, so ask for the
        # latest revision directly. A push that reports a revision we haven't
        # seen means the server has something newer, such as a web change made
        # while this PC was off.
        if not sync.pushed or (
            sync.config_revision is not None and sync.config_revision > self._known_revision()
        ):
            self._latest_hint = sync.config_revision
            try:
                self.apply_config_revision()
            except Exception:
                # A bad reply must not keep the watcher from starting.
                logger.exception("Checking for a config revision at startup failed")

        self._start_watching_or_wait(started_message=f"{self.role} started on {self.host}")

    def poll(self, timeout: float = 1.0) -> bool:
        """Handle pending work, waiting up to *timeout* for some.

        Returns `True` once the runtime asks to shut down (an auto-update
        restart), so the caller can stop and exit.
        """
        self._wake.wait(timeout)
        self._wake.clear()
        if self._shutdown_requested():
            return True
        try:
            if self._result_retry_due.is_set():
                self._result_retry_due.clear()
                self._send_unsent_result()
            if self._revision_due.is_set():
                self._revision_due.clear()
                self.apply_config_revision()
            if self._folder_check_due.is_set():
                self._folder_check_due.clear()
                self._check_waiting_folder()
        except Exception:
            # Keep the main loop alive; the next heartbeat retries.
            logger.exception("Handling a config change failed")
        return self._shutdown_requested()

    def wake(self) -> None:
        """Make a blocked :meth:`poll` return early (used by signal handlers)."""
        self._wake.set()

    def classify_shutdown(self) -> ShutdownReason:
        if self.rt is not None:
            return classify_shutdown(self.rt, role=self.role)
        if self.upgrade_restart_event.is_set():
            return ShutdownReason(
                is_upgrade_restart=True,
                stopped_message=f"{self.role} restarting for auto-update",
            )
        return ShutdownReason(is_upgrade_restart=False, stopped_message=f"{self.role} stopped")

    def stop(self, *, stopped_message: str) -> None:
        """Stop whatever is running and flush events."""
        if self.rt is not None:
            stop_runtime(self.rt, stopped_message=stopped_message)
            self.rt = None
        elif self._waiting is not None:
            self.reporter.queue_event(
                WatcherEvent(event_type=EventType.WATCHER_STOPPED, message=stopped_message)
            )
            self._waiting.heartbeat.stop()
            self._waiting = None
            self.reporter.flush()
        if self._state is not None:
            self._state.close()

    # ------------------------------------------------------------------
    # config revisions
    # ------------------------------------------------------------------

    def apply_config_revision(self) -> bool:
        """Fetch the latest config revision and apply it if it is pending.

        Returns whether a revision was applied. A revision that fails
        validation is reported as ``rejected`` and the current config keeps
        running. Either way the revision is recorded as seen, so it is never
        fetched again.
        """
        try:
            latest, pending = self._fetch_pending_revision()
        except ApiError as exc:
            # Not recorded as seen: the next heartbeat tries again.
            logger.warning("Could not fetch the latest config revision: %s", exc.message)
            return False

        if pending is None:
            if latest is not None:
                self._note_resolved_revision(latest)
            elif self._latest_hint is not None:
                self._record_seen(self._latest_hint)
            return False
        return self._apply(pending)

    def _fetch_pending_revision(
        self,
    ) -> tuple[ConfigRevisionResponse | None, ConfigRevisionResponse | None]:
        """Return ``(latest, pending)``, where *pending* is the revision to apply.

        Usually the latest revision is the pending one. The exception is an
        offline conflict the web change won: the server keeps the web revision
        pending and stores the PC's edit after it as ``superseded``, so the
        pending revision is found in the history instead.
        """
        latest = self.client.get_latest_config_revision(self.watcher_id)
        if latest is None or latest.status == "pending":
            return latest, latest
        if latest.status != "superseded":
            return latest, None
        revisions = self.client.list_config_revisions(self.watcher_id)
        pending = [r for r in revisions if r.status == "pending"]
        return latest, max(pending, key=lambda r: r.revision, default=None)

    def _note_resolved_revision(self, revision: ConfigRevisionResponse) -> None:
        """Record a revision that needs no action as seen.

        If it is ``applied`` and its settings are the ones running here (for
        example the revision the server made from this watcher's own push),
        it is recorded as applied too.
        """
        self._record_seen(revision.revision)
        if revision.status == "applied" and settings_match(self.cfg.instrument, revision.settings):
            self._record_applied(revision.revision)

    def _apply(self, revision: ConfigRevisionResponse) -> bool:
        number = revision.revision
        if self._applied is not None and number <= self._applied:
            # Already running it; the earlier result call may have been lost.
            self._record_seen(number)
            self._report_result(number, "applied")
            return False

        old_cfg = self.cfg
        if settings_match(old_cfg.instrument, revision.settings):
            # Nothing to change, so skip the rebuild.
            self._record_applied(number)
            self._report_result(number, "applied")
            return False
        try:
            self._check_config_file_identity()
            new_cfg = config_with_revision(old_cfg, revision.settings)
        except RevisionRejected as exc:
            self._reject(number, str(exc))
            return False

        old_inst, new_inst = old_cfg.instrument, new_cfg.instrument
        report_only = (
            report_only_predicate(old_inst, new_inst, cutoff=time.time())
            if widens_scope(old_inst, new_inst)
            else None
        )

        try:
            config_io.save_config(new_cfg, self.config_path)
        except OSError as exc:
            self._reject(number, f"Could not write {self.config_path}: {exc}")
            return False

        logger.info("Applying config revision %d from Data Hub", number)
        running = self.rt is not None or self._waiting is not None
        self._teardown_for_rebuild()
        if folder_changed(old_inst, new_inst):
            self._forget_old_folder_uploads()
        self.cfg = new_cfg

        if running:
            try:
                self._start_watching_or_wait(
                    started_message=(
                        f"{self.role} restarted on {self.host} with config revision {number}"
                    ),
                    report_only=report_only,
                )
            except Exception as exc:
                logger.exception("Could not start with config revision %d", number)
                self._roll_back(old_cfg)
                self._reject(number, f"Could not start with the new config: {exc}")
                return False
        else:
            # Called from `start`, before anything runs: `start` builds the
            # runtime with the new config right after this.
            self._startup_report_only = report_only

        self._record_applied(number)
        logger.info("Config revision %d applied", number)
        self._report_result(number, "applied")
        sync = self._push_config(trigger="config_revision")
        if running and sync.config_revision is not None:
            # The push may have created a `pc` revision (for example when the
            # folder was stored in a different form) or crossed a newer web
            # change. Either way the next poll sorts it out.
            if sync.config_revision > self._known_revision():
                self._latest_hint = sync.config_revision
                self._revision_due.set()
                self._wake.set()
        return True

    def _check_config_file_identity(self) -> None:
        """Refuse to overwrite a config file that now belongs to another watcher.

        `config set-environment` on the PC rewrites ``config.yaml`` and asks
        the operator to restart. Saving a revision on top would quietly undo
        that switch.
        """
        identity = _read_config_identity(self.config_path)
        if identity is None:
            return
        running = (self.cfg.environment, self.watcher_id, self.cfg.instrument.id)
        if identity != running:
            raise RevisionRejected(
                "config.yaml on the PC was changed to a different environment, "
                "watcher or instrument; restart the watcher to load it"
            )

    def _reject(self, number: int, reason: str) -> None:
        logger.warning(
            "Rejected config revision %d from Data Hub; keeping the current config: %s",
            number,
            reason,
        )
        self._record_seen(number)
        self._report_result(number, "rejected", reason)

    def _roll_back(self, old_cfg: WatcherConfig) -> None:
        """Restore the previous config after the new one failed to start."""
        self._teardown_for_rebuild()
        self.cfg = old_cfg
        try:
            config_io.save_config(old_cfg, self.config_path)
        except OSError:
            logger.exception("Could not restore %s", self.config_path)
        self._start_or_wait_on_error(
            started_message=f"{self.role} restarted on {self.host} with its previous config"
        )

    def _start_or_wait_on_error(self, *, started_message: str) -> None:
        """Start watching, falling back to the waiting state if that fails.

        The fallback keeps heartbeats going, so the dashboard shows what
        happened and another config change can still reach this PC.
        """
        try:
            self._start_watching_or_wait(started_message=started_message)
        except Exception as exc:
            logger.exception("Could not start watching")
            self._teardown_for_rebuild()
            self._enter_waiting(f"could not start watching: {exc}", started_message=started_message)

    def _forget_old_folder_uploads(self) -> None:
        if self._state is None:
            return
        removed = self._state.clear_pending_uploads()
        if removed:
            logger.info(
                "Dropped %d unfinished upload(s) from the previous watch folder",
                removed,
            )

    def _known_revision(self) -> int:
        return max(self._seen or 0, self._applied or 0)

    def _record_seen(self, number: int) -> None:
        if self._state is not None:
            self._state.record_config_revision_seen(number)
        if self._seen is None or number > self._seen:
            self._seen = number

    def _record_applied(self, number: int) -> None:
        if self._state is not None:
            self._state.record_config_revision_applied(number)
        self._applied = number
        if self._seen is None or number > self._seen:
            self._seen = number

    def _on_heartbeat_revision(self, latest: int | None) -> None:
        """Heartbeat-thread callback with the reply's ``config_revision``."""
        if self._unsent_result is not None:
            self._result_retry_due.set()
            self._wake.set()
        if latest is not None and latest > self._known_revision():
            self._latest_hint = latest
            self._revision_due.set()
            self._wake.set()

    # ------------------------------------------------------------------
    # revision results
    # ------------------------------------------------------------------

    def _report_result(self, number: int, status: str, reason: str | None = None) -> None:
        self._unsent_result = {"revision": number, "status": status, "reason": reason}
        self._persist_unsent_result()
        self._send_unsent_result()

    def _send_unsent_result(self) -> None:
        result = self._unsent_result
        if result is None:
            return
        try:
            self.client.report_config_revision_result(
                self.watcher_id,
                int(result["revision"]),
                str(result["status"]),
                result.get("reason"),
            )
        except ApiError as exc:
            if exc.is_transient:
                logger.warning(
                    "Could not report config revision %s as %s yet: %s",
                    result["revision"],
                    result["status"],
                    exc.message,
                )
                return
            # 404 (unknown revision) or 409 (already resolved another way):
            # retrying would fail the same way.
            logger.warning(
                "Server refused the %s result for config revision %s: %s",
                result["status"],
                result["revision"],
                exc.message,
            )
        self._unsent_result = None
        self._persist_unsent_result()

    def _load_unsent_result(self) -> dict[str, Any] | None:
        assert self._state is not None
        raw = self._state.get_meta(CONFIG_REVISION_UNSENT_RESULT_META_KEY)
        if raw is None:
            return None
        try:
            data = json.loads(raw)
        except ValueError:
            return None
        return data if isinstance(data, dict) and "revision" in data else None

    def _persist_unsent_result(self) -> None:
        if self._state is None:
            return
        if self._unsent_result is None:
            self._state.delete_meta(CONFIG_REVISION_UNSENT_RESULT_META_KEY)
        else:
            self._state.set_meta(
                CONFIG_REVISION_UNSENT_RESULT_META_KEY, json.dumps(self._unsent_result)
            )

    # ------------------------------------------------------------------
    # config push
    # ------------------------------------------------------------------

    def _push_config(self, *, trigger: str) -> ConfigSyncResult:
        previous_checksum = self._state.synced_config_checksum() if self._state else None
        result = sync_config_to_api(
            self.client,
            self.watcher_id,
            self.config_path,
            self.reporter,
            trigger=trigger,
            based_on_revision=self._applied,
        )
        if (
            trigger == "startup"
            and result.pushed
            and previous_checksum is not None
            and result.checksum != previous_checksum
        ):
            logger.info(
                "config.yaml was edited on this PC since it was last synced; "
                "pushed it based on config revision %s",
                self._applied,
            )
        if result.ok and result.checksum is not None and self._state is not None:
            self._state.record_synced_config_checksum(result.checksum)
        return result

    # ------------------------------------------------------------------
    # running, waiting and rebuilding
    # ------------------------------------------------------------------

    def _shutdown_requested(self) -> bool:
        event = self.rt.shutdown_event if self.rt is not None else self.shutdown_event
        return event.is_set()

    def _start_watching_or_wait(
        self,
        *,
        started_message: str,
        report_only: Callable[[str, float], bool] | None = None,
    ) -> None:
        if report_only is None and self._startup_report_only is not None:
            report_only = self._startup_report_only
        self._startup_report_only = None
        problem = watch_directory_problem(self.cfg.instrument.watch_directory)
        if problem is not None:
            self._enter_waiting(problem, started_message=started_message)
            return
        rt = build_runtime(
            client=self.client,
            cfg=self.cfg,
            db_path=self.db_path,
            config_dir=self.config_dir,
            reporter=self.reporter,
            shutdown_event=self.shutdown_event,
            upgrade_restart_event=self.upgrade_restart_event,
            report_only=report_only,
            config_revision=lambda: self._applied,
            on_config_revision=self._on_heartbeat_revision,
        )
        try:
            start_runtime(rt, started_message=started_message)
        except Exception:
            # Leave nothing half-started behind, then let the caller decide.
            self.rt = rt
            self._teardown_for_rebuild()
            raise
        self.rt = rt

    def _enter_waiting(self, reason: str, *, started_message: str) -> None:
        logger.warning(
            "%s. Waiting: heartbeats continue, and watching starts once the folder "
            "exists or a config change from Data Hub fixes it.",
            reason,
        )
        assert self._state is not None
        counters = WatcherCounters()
        updater = Updater(
            client=self.client,
            reporter=self.reporter,
            counters=counters,
            state_db=self._state,
            cfg=self.cfg,
            config_dir=self.config_dir,
            request_upgrade_restart=_upgrade_restart_requester(
                self.shutdown_event, self.upgrade_restart_event
            ),
        )

        def on_tick() -> None:
            try:
                updater.on_tick()
            except Exception:
                logger.exception("Updater tick failed")
            self._folder_check_due.set()
            self._wake.set()

        inst = self.cfg.instrument
        heartbeat = HeartbeatLoop(
            client=self.client,
            watcher_id=self.watcher_id,
            interval_seconds=HEARTBEAT_INTERVAL_SECONDS,
            event_reporter=self.reporter,
            instrument_id=inst.id,
            watch_directory=str(inst.watch_directory),
            upload_mode=inst.upload_mode,
            counters=counters,
            on_tick=on_tick,
            status="waiting",
            status_reason=reason,
            config_revision=lambda: self._applied,
            on_config_revision=self._on_heartbeat_revision,
        )
        self.reporter.queue_event(
            WatcherEvent(event_type=EventType.WATCHER_STARTED, message=started_message)
        )
        self.reporter.report_error(
            "watch_directory_unavailable",
            f"Waiting: {reason}",
            watch_directory=str(inst.watch_directory),
            reason=reason,
        )
        self._waiting = _WaitingMode(reason=reason, heartbeat=heartbeat, updater=updater)
        heartbeat.start()

    def _check_waiting_folder(self) -> None:
        if self._waiting is None:
            return
        if watch_directory_problem(self.cfg.instrument.watch_directory) is not None:
            return
        logger.info(
            "Watch folder %s is available again; starting to watch",
            self.cfg.instrument.watch_directory,
        )
        self._teardown_for_rebuild()
        self._start_or_wait_on_error(started_message=f"{self.role} resumed on {self.host}")

    def _teardown_for_rebuild(self) -> None:
        """Stop the running loops without reporting the watcher as stopped.

        In-progress uploads get up to ``CONFIG_APPLY_DRAIN_TIMEOUT_SECONDS``
        to finish. The upload stop signal is shared, so queued files and the
        rest of an auto-mode batch wait for the next runtime, which retries
        them.
        """
        rt, self.rt = self.rt, None
        if rt is not None:
            deadline = time.monotonic() + CONFIG_APPLY_DRAIN_TIMEOUT_SECONDS
            uploads_stopped = True
            if rt.upload_worker is not None:
                uploads_stopped = rt.upload_worker.stop(timeout=CONFIG_APPLY_DRAIN_TIMEOUT_SECONDS)
            monitor_stopped = rt.monitor.stop(timeout=max(1.0, deadline - time.monotonic()))
            rt.heartbeat.stop(send_stopped=False)
            rt.reporter.flush()
            if uploads_stopped and monitor_stopped:
                rt.state_db.close()
            else:
                logger.warning(
                    "An upload was still running after %ds; rebuilding anyway and "
                    "leaving it to finish on its own",
                    CONFIG_APPLY_DRAIN_TIMEOUT_SECONDS,
                )
        waiting, self._waiting = self._waiting, None
        if waiting is not None:
            waiting.heartbeat.stop(send_stopped=False)


def run_supervisor(supervisor: WatcherSupervisor, stop_event: threading.Event) -> None:
    """Poll *supervisor* until *stop_event* is set or the runtime asks to shut down."""
    while not stop_event.is_set():
        if supervisor.poll(timeout=1.0):
            return
