"""Windows Service wrapper for the Data Hub Watcher.

This module is only imported on Windows and requires the ``pywin32`` optional
dependency (``pip install data-hub-watcher[windows-service]``).

All win32 imports are done lazily inside each function so that:
  1. The module can be imported on any platform for type-checking.
  2. Pyright does not flag undefined variables on non-Windows hosts.
"""

from __future__ import annotations
import logging
import sys
from typing import TYPE_CHECKING, Any

from data_hub_watcher.constants import SERVICE_NAME

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)

SERVICE_DISPLAY_NAME = "Data Hub Watcher"
SERVICE_DESCRIPTION = "Monitors instrument directories and uploads data files to Data Hub."


def install_service() -> None:
    """Install the watcher as a Windows service with automatic start and recovery."""
    import win32service as ws  # type: ignore[import-untyped]
    import win32serviceutil  # type: ignore[import-untyped]

    exe = sys.executable
    class_path = f"{__name__}.DataHubWatcherService"

    win32serviceutil.InstallService(
        pythonClassString=class_path,
        serviceName=SERVICE_NAME,
        displayName=SERVICE_DISPLAY_NAME,
        startType=ws.SERVICE_AUTO_START,
        exeName=exe,
        description=SERVICE_DESCRIPTION,
    )

    _configure_recovery()
    logger.info("Service '%s' installed successfully", SERVICE_NAME)


def _configure_recovery() -> None:
    """Set the service to restart on first and second failure.

    After two consecutive failures the service stops retrying to avoid a
    crash loop (e.g. due to a persistent config or credential issue).
    The failure counter resets after 24 h of healthy uptime.
    """
    import win32service as ws  # type: ignore[import-untyped]

    hscm = ws.OpenSCManager(None, None, ws.SC_MANAGER_ALL_ACCESS)
    try:
        hs = ws.OpenService(hscm, SERVICE_NAME, ws.SERVICE_ALL_ACCESS)
        try:
            # SC_ACTION_RESTART = 1, delay in milliseconds
            actions = [
                (1, 60_000),  # 1st failure: restart after 60 s
                (1, 120_000),  # 2nd failure: restart after 120 s
                (0, 0),  # subsequent: no action
            ]
            ws.ChangeServiceConfig2(
                hs,
                ws.SERVICE_CONFIG_FAILURE_ACTIONS,
                {
                    "ResetPeriod": 86400,
                    "RebootMsg": "",
                    "Command": "",
                    "Actions": actions,
                },
            )
        finally:
            ws.CloseServiceHandle(hs)
    finally:
        ws.CloseServiceHandle(hscm)


def uninstall_service() -> None:
    """Stop (if running) and remove the Windows service."""
    import win32serviceutil  # type: ignore[import-untyped]

    try:
        win32serviceutil.StopService(SERVICE_NAME)
    except Exception:
        pass  # already stopped or doesn't exist
    win32serviceutil.RemoveService(SERVICE_NAME)
    logger.info("Service '%s' removed", SERVICE_NAME)


def start_service() -> None:
    import win32serviceutil  # type: ignore[import-untyped]

    win32serviceutil.StartService(SERVICE_NAME)
    logger.info("Service '%s' started", SERVICE_NAME)


def stop_service() -> None:
    import win32serviceutil  # type: ignore[import-untyped]

    win32serviceutil.StopService(SERVICE_NAME)
    logger.info("Service '%s' stopped", SERVICE_NAME)


def query_service_status() -> dict[str, Any]:
    """Return a dict with service status info for display."""
    import win32service as ws  # type: ignore[import-untyped]
    import win32serviceutil  # type: ignore[import-untyped]

    status = win32serviceutil.QueryServiceStatus(SERVICE_NAME)
    # status is a tuple: (svcType, svcState, ctrlsAccepted, exitCode,
    #                      svcSpecificExitCode, checkPoint, waitHint)
    state_map = {
        ws.SERVICE_STOPPED: "stopped",
        ws.SERVICE_START_PENDING: "start_pending",
        ws.SERVICE_STOP_PENDING: "stop_pending",
        ws.SERVICE_RUNNING: "running",
        ws.SERVICE_CONTINUE_PENDING: "continue_pending",
        ws.SERVICE_PAUSE_PENDING: "pause_pending",
        ws.SERVICE_PAUSED: "paused",
    }
    svc_state = status[1]
    return {
        "service_name": SERVICE_NAME,
        "state": state_map.get(svc_state, f"unknown ({svc_state})"),
        "pid": status[5] if svc_state == ws.SERVICE_RUNNING else None,
    }


def _create_service_class() -> type | None:
    """Dynamically create the ServiceFramework subclass on Windows only.

    The class is built at import time (not eagerly at top-of-module) so
    that (a) the module can be imported safely on non-Windows for type
    checking and tests, and (b) win32serviceutil can discover the class
    by its qualified name for service registration.
    """
    if sys.platform != "win32":
        return None

    import win32service as ws  # type: ignore[import-untyped]
    import win32serviceutil  # type: ignore[import-untyped]

    class DataHubWatcherService(win32serviceutil.ServiceFramework):  # type: ignore[misc]
        _svc_name_ = SERVICE_NAME
        _svc_display_name_ = SERVICE_DISPLAY_NAME

        def __init__(self, args: list[str]) -> None:
            super().__init__(args)
            import threading

            self._stop_event = threading.Event()

        def SvcDoRun(self) -> None:
            import platform

            import servicemanager  # type: ignore[import-untyped]

            from data_hub_watcher.api_client import DataHubClient
            from data_hub_watcher.config_io import load_config
            from data_hub_watcher.constants import (
                API_URLS,
                HEARTBEAT_INTERVAL_SECONDS,
                PRUNE_DAYS,
                STATE_DB_FILENAME,
                resolve_config_path,
            )
            from data_hub_watcher.events import EventReporter, EventType, WatcherEvent
            from data_hub_watcher.heartbeat import HeartbeatLoop, WatcherCounters
            from data_hub_watcher.monitor import FileMonitor
            from data_hub_watcher.run_detector import RunDetector
            from data_hub_watcher.state import StateDB
            from data_hub_watcher.uploader import Uploader

            servicemanager.LogInfoMsg(f"{SERVICE_DISPLAY_NAME} starting")

            path = resolve_config_path()
            cfg = load_config(path)
            inst = cfg.instrument

            base_url = API_URLS[cfg.environment]
            client = DataHubClient(base_url)

            db_path = path.parent / STATE_DB_FILENAME
            state_db = StateDB(db_path)
            state_db.prune_uploaded_files(PRUNE_DAYS)

            counters = WatcherCounters()
            reporter = EventReporter(client, cfg.watcher_id or "")

            heartbeat = HeartbeatLoop(
                client=client,
                watcher_id=cfg.watcher_id or "",
                interval_seconds=HEARTBEAT_INTERVAL_SECONDS,
                event_reporter=reporter,
                counters=counters,
            )

            is_auto = inst.upload_mode == "auto"

            uploader = Uploader(
                client=client,
                state_db=state_db,
                event_reporter=reporter,
                counters=counters,
                instrument_id=inst.id,
                watcher_id=cfg.watcher_id or "",
                environment=cfg.environment,
                watch_directory=inst.watch_directory,
            )

            detector = RunDetector(
                method=inst.run_detection.method,
                prefix_pattern=inst.run_detection.prefix_pattern,
                instrument_id=inst.id,
                watcher_id=cfg.watcher_id or "",
                client=client,
                state_db=state_db,
                event_reporter=reporter,
                counters=counters,
                upload_callback=uploader.upload_files if is_auto else None,
                watch_directory=inst.watch_directory,
            )

            is_recursive = inst.run_detection.method == "directory" and not is_auto
            monitor = FileMonitor(
                watch_directory=inst.watch_directory,
                file_patterns=inst.file_patterns,
                stability_period=inst.stability_period_seconds,
                on_stable_file=detector.on_stable_file,
                state_db=state_db,
                recursive=is_recursive,
            )

            reporter.queue_event(
                WatcherEvent(
                    event_type=EventType.WATCHER_STARTED,
                    message=f"Service started on {platform.node()}",
                )
            )

            heartbeat.start()
            monitor.start()

            servicemanager.LogInfoMsg(f"{SERVICE_DISPLAY_NAME} is running")

            self._stop_event.wait()

            monitor.stop()
            reporter.queue_event(
                WatcherEvent(
                    event_type=EventType.WATCHER_STOPPED,
                    message="Service stopped",
                )
            )
            heartbeat.stop()
            reporter.flush()
            state_db.close()

            servicemanager.LogInfoMsg(f"{SERVICE_DISPLAY_NAME} stopped")

        def SvcStop(self) -> None:
            self.ReportServiceStatus(ws.SERVICE_STOP_PENDING)
            self._stop_event.set()

    return DataHubWatcherService


# Materialise the class at module scope so win32serviceutil can find it by
# qualified name (``data_hub_watcher.service.DataHubWatcherService``).
_svc_cls = _create_service_class()
if _svc_cls is not None:
    DataHubWatcherService = _svc_cls  # noqa: F841
