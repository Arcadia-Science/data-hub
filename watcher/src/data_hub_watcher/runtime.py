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
from dataclasses import dataclass
from pathlib import Path

from data_hub_watcher.api_client import DataHubClient
from data_hub_watcher.constants import HEARTBEAT_INTERVAL_SECONDS, PRUNE_DAYS
from data_hub_watcher.events import EventReporter, EventType, WatcherEvent
from data_hub_watcher.heartbeat import HeartbeatLoop, WatcherCounters
from data_hub_watcher.models import WatcherConfig
from data_hub_watcher.monitor import FileMonitor
from data_hub_watcher.run_detector import RunDetector
from data_hub_watcher.state import StateDB
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

    # In manual mode the server controls which files to upload. We
    # piggyback on the heartbeat tick to poll the server's upload queue,
    # so uploads happen at the same cadence as heartbeats without a
    # separate timer.
    def _poll_upload_queue() -> None:
        try:
            uploader.poll_upload_queue()
        except Exception:
            logger.exception("Upload queue poll failed")

    heartbeat = HeartbeatLoop(
        client=client,
        watcher_id=watcher_id,
        interval_seconds=HEARTBEAT_INTERVAL_SECONDS,
        event_reporter=reporter,
        instrument_id=inst.id,
        watch_directory=str(inst.watch_directory),
        upload_mode=inst.upload_mode,
        counters=counters,
        on_tick=_poll_upload_queue if not is_auto else None,
    )

    return WatcherRuntime(
        state_db=state_db,
        counters=counters,
        reporter=reporter,
        uploader=uploader,
        detector=detector,
        monitor=monitor,
        heartbeat=heartbeat,
    )


def start_runtime(rt: WatcherRuntime, *, started_message: str) -> None:
    """Queue the started event, recover unreported runs, then start threads.

    The `started_message` varies by entry point (`"Watcher started on …"`
    from the CLI vs `"Service started on …"` from the Windows service)
    so operators can tell from the event log which code path launched.
    """
    rt.reporter.queue_event(
        WatcherEvent(
            event_type=EventType.WATCHER_STARTED,
            message=started_message,
        )
    )

    # Rebuild in-memory run state from the local DB before any file
    # events fire. Without this, every restart starts with an empty
    # `_runs` dict and the initial scan would re-POST / re-PATCH runs
    # that were already reported in a previous session. Must happen
    # before `monitor.start()` (which runs the initial scan and may
    # enqueue files) and before `retry_unreported_runs()` (which is
    # unaffected by hydration but cheaper to call on a populated dict).
    rt.detector.hydrate_from_state_db()

    # If the watcher crashed mid-session, some runs may have been detected
    # but never successfully POSTed to the API. Retry those before the
    # normal event loop kicks in so they aren't silently lost.
    rt.detector.retry_unreported_runs()

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
