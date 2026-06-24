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
import logging
import re
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path

from data_hub_watcher.api_client import ApiError, DataHubClient
from data_hub_watcher.constants import (
    DEFAULT_CONFIG_DIR,
    HEARTBEAT_INTERVAL_SECONDS,
    PRUNE_DAYS,
)
from data_hub_watcher.events import EventReporter, EventType, WatcherEvent
from data_hub_watcher.heartbeat import HeartbeatLoop, WatcherCounters
from data_hub_watcher.models import WatcherConfig
from data_hub_watcher.monitor import FileMonitor, seed_baseline_files
from data_hub_watcher.run_detector import RunDetector
from data_hub_watcher.state import StateDB
from data_hub_watcher.updater import Updater, evaluate_upgrade_marker
from data_hub_watcher.upgrade_worker import (
    clear_upgrade_request,
    clear_upgrade_result,
    read_upgrade_result,
)
from data_hub_watcher.uploader import Uploader

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


def build_runtime(
    *,
    client: DataHubClient,
    cfg: WatcherConfig,
    db_path: Path,
    config_dir: Path | None = None,
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
    """
    if not cfg.watcher_id:
        raise ValueError("cfg.watcher_id must be set before building the runtime")

    effective_config_dir = config_dir if config_dir is not None else DEFAULT_CONFIG_DIR

    inst = cfg.instrument
    watcher_id = cfg.watcher_id

    state_db = StateDB(db_path)
    state_db.prune_uploaded_files(PRUNE_DAYS)

    # In a `new-only` environment (staging/preview by default), record the
    # pre-existing backlog as skip on first start so the initial scan doesn't
    # flood the target with historical data. Gated on an empty DB so we never
    # re-baseline once real uploads/runs exist for this environment.
    if cfg.resolve_initial_scan() == "new-only" and not state_db.baseline_established():
        seed_baseline_files(
            state_db,
            inst.watch_directory,
            inst.file_patterns,
            inst.run_detection.recursive,
        )

    counters = WatcherCounters()
    reporter = EventReporter(client, watcher_id)

    shutdown_event = threading.Event()
    upgrade_restart_event = threading.Event()

    def _request_upgrade_restart(target_version: str) -> None:
        logger.info(
            "Auto-update: requesting service restart to load watcher %s",
            target_version,
        )
        upgrade_restart_event.set()
        shutdown_event.set()

    updater = Updater(
        client=client,
        reporter=reporter,
        counters=counters,
        state_db=state_db,
        cfg=cfg,
        config_dir=effective_config_dir,
        request_upgrade_restart=_request_upgrade_restart,
    )

    is_auto = inst.upload_mode == "auto"

    uploader = Uploader(
        client=client,
        state_db=state_db,
        event_reporter=reporter,
        counters=counters,
        instrument_id=inst.id,
        watcher_id=watcher_id,
        watch_directory=inst.watch_directory,
        # Per-instrument knob, defaulted on the model so older configs
        # transparently inherit the new parallel-upload behaviour.
        upload_parallelism=inst.upload_parallelism,
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
        on_stable_file=detector.on_stable_file,
        state_db=state_db,
        recursive=inst.run_detection.recursive,
        event_reporter=reporter,
    )

    # The heartbeat's `on_tick` hook is now multi-purpose:
    #   1. In manual mode, poll the server's upload queue (uploads
    #      naturally inherit the heartbeat cadence).
    #   2. Always: feed the in-process auto-updater so it can count
    #      idle ticks and run a server update-check roughly hourly.
    # Each side wraps its own try/except so a failure on one side
    # never blocks the other.
    def _on_tick() -> None:
        if not is_auto:
            try:
                uploader.poll_upload_queue()
            except Exception:
                logger.exception("Upload queue poll failed")
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
    rt.monitor.start()


def sync_config_to_api(
    client: DataHubClient,
    watcher_id: str,
    path: Path,
    reporter: EventReporter,
    *,
    trigger: str = "startup",
) -> bool:
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

    Returns ``True`` if the remote was updated (push attempted),
    ``False`` if the remote already matched and no push was issued.
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
        return False

    if remote is not None and remote.config_checksum == local_checksum:
        return False

    try:
        yaml_content = path.read_text(encoding="utf-8")
        client.push_config(watcher_id, yaml_content, local_checksum)
    except ApiError as exc:
        reporter.report_error(
            "config_sync_failed",
            f"Could not push config to API: {exc.message}",
            checksum=local_checksum,
            error=exc.message,
        )
        return True

    reporter.queue_event(
        WatcherEvent(
            event_type=EventType.CONFIG_SYNCED,
            message=f"Config synced (trigger={trigger})",
            details={"trigger": trigger},
        )
    )
    return True


def stop_runtime(rt: WatcherRuntime, *, stopped_message: str) -> None:
    """Shut everything down in reverse order and flush pending events."""
    rt.monitor.stop()
    rt.reporter.queue_event(
        WatcherEvent(
            event_type=EventType.WATCHER_STOPPED,
            message=stopped_message,
        )
    )
    rt.heartbeat.stop()
    rt.reporter.flush()
    rt.state_db.close()
