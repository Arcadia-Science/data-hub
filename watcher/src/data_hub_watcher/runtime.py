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
import threading
from dataclasses import dataclass, field
from pathlib import Path

from data_hub_watcher.api_client import DataHubClient
from data_hub_watcher.constants import (
    DEFAULT_CONFIG_DIR,
    HEARTBEAT_INTERVAL_SECONDS,
    PRUNE_DAYS,
)
from data_hub_watcher.events import EventReporter, EventType, WatcherEvent
from data_hub_watcher.heartbeat import HeartbeatLoop, WatcherCounters
from data_hub_watcher.models import WatcherConfig
from data_hub_watcher.monitor import FileMonitor
from data_hub_watcher.run_detector import RunDetector
from data_hub_watcher.state import StateDB
from data_hub_watcher.updater import Updater, evaluate_upgrade_marker
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
    # Set when the in-process updater has successfully installed a new
    # watcher version and wants the main loop to exit non-zero so the
    # Windows SCM (or a foreground operator running ``watch``) restarts
    # us into the new code. The CLI / service main loops poll this event
    # in their stop wait so a shutdown can be triggered from any thread.
    shutdown_event: threading.Event = field(default_factory=threading.Event)
    upgrade_restart_event: threading.Event = field(default_factory=threading.Event)


def build_runtime(
    *,
    client: DataHubClient,
    cfg: WatcherConfig,
    db_path: Path,
) -> WatcherRuntime:
    """Construct the full runtime graph from a validated config.

    The caller is responsible for ensuring `cfg.watcher_id` is set — the
    CLI does this explicitly via a click error, and the service does it
    via a registry lookup. We assert here as a safety net so a silent
    misconfiguration becomes a loud crash.
    """
    if not cfg.watcher_id:
        raise ValueError("cfg.watcher_id must be set before building the runtime")

    inst = cfg.instrument
    watcher_id = cfg.watcher_id

    state_db = StateDB(db_path)
    state_db.prune_uploaded_files(PRUNE_DAYS)

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
        config_dir=DEFAULT_CONFIG_DIR,
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

    outcome = evaluate_upgrade_marker(DEFAULT_CONFIG_DIR)
    if outcome.found:
        if outcome.succeeded:
            rt.reporter.queue_event(
                WatcherEvent(
                    event_type=EventType.UPDATE_SUCCEEDED,
                    message=(
                        f"Restarted into upgraded watcher "
                        f"{outcome.previous_version} -> {outcome.target_version}"
                    ),
                    details={
                        "previous_version": outcome.previous_version,
                        "target_version": outcome.target_version,
                    },
                )
            )
        else:
            rt.reporter.queue_event(
                WatcherEvent(
                    event_type=EventType.UPDATE_FAILED,
                    message=f"Watcher upgrade did not take effect: {outcome.reason}",
                    details={
                        "previous_version": outcome.previous_version,
                        "target_version": outcome.target_version,
                        "reason": outcome.reason,
                    },
                )
            )

    # Rebuild in-memory run state from the local DB before any file
    # events fire. Without this, every restart starts with an empty
    # `_runs` dict and the initial scan would re-POST / re-PATCH runs
    # that were already reported in a previous session. Must happen
    # before `monitor.start()`, which runs the initial scan and may
    # route files through `_update_run` based on hydrated state.
    rt.detector.hydrate_from_state_db()

    rt.heartbeat.start()
    rt.monitor.start()


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
