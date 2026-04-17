"""Windows Service wrapper for the Data Hub Watcher.

This module is only imported on Windows and requires the `pywin32` optional
dependency (`pip install data-hub-watcher[windows-service]`).

All win32 imports are done lazily inside each function so that:
  1. The module can be imported on any platform for type-checking.
  2. Pyright does not flag undefined variables on non-Windows hosts.

When run as ``python -m data_hub_watcher.service`` by the Windows Service
Control Manager, the ``__main__`` block at the bottom of this file starts
the service control dispatcher.  This avoids depending on
``pythonservice.exe`` (which frequently fails to activate the virtual
environment created by ``uv``).
"""

from __future__ import annotations
import logging
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

from data_hub_watcher.constants import SERVICE_NAME

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)

SERVICE_DISPLAY_NAME = "Data Hub Watcher"
SERVICE_DESCRIPTION = "Monitors instrument directories and uploads data files to Data Hub."

_REG_KEY = rf"SYSTEM\CurrentControlSet\Services\{SERVICE_NAME}"
_REG_CONFIG_PATH = "ConfigPath"
_REG_ENV_PATH = "EnvPath"


def install_service(config_path: Path, env_path: Path) -> None:
    """Install the watcher as a Windows service with automatic start and recovery.

    The service binary path is registered as
    ``"<venv>/python.exe" -m data_hub_watcher.service`` so that the
    virtual-environment's interpreter (and all installed packages) are
    available when the SCM starts the process.

    *config_path* and *env_path* are persisted to the service's registry
    key so that ``SvcDoRun`` can locate them regardless of which Windows
    user account the service runs under (typically Local System).
    """
    import win32service as ws  # type: ignore[import-untyped]
    import win32serviceutil  # type: ignore[import-untyped]

    class_path = f"{__name__}.DataHubWatcherService"

    win32serviceutil.InstallService(
        pythonClassString=class_path,
        serviceName=SERVICE_NAME,
        displayName=SERVICE_DISPLAY_NAME,
        startType=ws.SERVICE_AUTO_START,
        exeName=sys.executable,
        exeArgs="-m data_hub_watcher.service",
        description=SERVICE_DESCRIPTION,
    )

    _store_paths_in_registry(config_path, env_path)
    _configure_recovery()
    logger.info("Service '%s' installed successfully", SERVICE_NAME)


def _store_paths_in_registry(config_path: Path, env_path: Path) -> None:
    """Write *config_path* and *env_path* into the service's registry key."""
    import winreg  # type: ignore[import-untyped]

    key = winreg.OpenKey(  # type: ignore[attr-defined]
        winreg.HKEY_LOCAL_MACHINE,  # type: ignore[attr-defined]
        _REG_KEY,
        0,
        winreg.KEY_SET_VALUE,  # type: ignore[attr-defined]
    )
    try:
        winreg.SetValueEx(key, _REG_CONFIG_PATH, 0, winreg.REG_SZ, str(config_path))  # type: ignore[attr-defined]
        winreg.SetValueEx(key, _REG_ENV_PATH, 0, winreg.REG_SZ, str(env_path))  # type: ignore[attr-defined]
    finally:
        winreg.CloseKey(key)  # type: ignore[attr-defined]


def _read_paths_from_registry() -> tuple[Path, Path]:
    """Read config & env paths previously stored by ``install_service``."""
    import winreg  # type: ignore[import-untyped]

    key = winreg.OpenKey(  # type: ignore[attr-defined]
        winreg.HKEY_LOCAL_MACHINE,  # type: ignore[attr-defined]
        _REG_KEY,
        0,
        winreg.KEY_QUERY_VALUE,  # type: ignore[attr-defined]
    )
    try:
        config_str, _ = winreg.QueryValueEx(key, _REG_CONFIG_PATH)  # type: ignore[attr-defined]
        env_str, _ = winreg.QueryValueEx(key, _REG_ENV_PATH)  # type: ignore[attr-defined]
    finally:
        winreg.CloseKey(key)  # type: ignore[attr-defined]
    return Path(config_str), Path(env_str)


def _delete_paths_from_registry() -> None:
    """Remove custom registry values written by ``install_service``.

    Silently ignored if the key or values don't exist (e.g. the service
    was installed before registry storage was added).
    """
    import winreg  # type: ignore[import-untyped]

    try:
        key = winreg.OpenKey(  # type: ignore[attr-defined]
            winreg.HKEY_LOCAL_MACHINE,  # type: ignore[attr-defined]
            _REG_KEY,
            0,
            winreg.KEY_SET_VALUE,  # type: ignore[attr-defined]
        )
    except OSError:
        return

    try:
        for name in (_REG_CONFIG_PATH, _REG_ENV_PATH):
            try:
                winreg.DeleteValue(key, name)  # type: ignore[attr-defined]
            except OSError:
                pass
    finally:
        winreg.CloseKey(key)  # type: ignore[attr-defined]


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
    """Stop (if running) and remove the Windows service.

    ``RemoveService`` deletes the ``HKLM\\...\\Services\\<name>`` key,
    which includes the custom ``ConfigPath`` / ``EnvPath`` values written
    by ``install_service``.  We still attempt an explicit cleanup first
    so stale values are removed even if ``RemoveService`` only marks the
    key for deferred deletion.
    """
    import win32serviceutil  # type: ignore[import-untyped]

    try:
        win32serviceutil.StopService(SERVICE_NAME)
    except Exception:
        pass  # already stopped or doesn't exist

    _delete_paths_from_registry()
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

    state_map = {
        ws.SERVICE_STOPPED: "stopped",
        ws.SERVICE_START_PENDING: "start_pending",
        ws.SERVICE_STOP_PENDING: "stop_pending",
        ws.SERVICE_RUNNING: "running",
        ws.SERVICE_CONTINUE_PENDING: "continue_pending",
        ws.SERVICE_PAUSE_PENDING: "pause_pending",
        ws.SERVICE_PAUSED: "paused",
    }

    # Use QueryServiceStatusEx to get the extended status which includes the
    # process ID.  The basic QueryServiceStatus only returns 7 fields
    # (svcType, svcState, ctrlsAccepted, exitCode, svcSpecificExitCode,
    # checkPoint, waitHint) — none of which is a PID.
    hscm = ws.OpenSCManager(None, None, ws.SC_MANAGER_CONNECT)
    try:
        hs = ws.OpenService(hscm, SERVICE_NAME, ws.SERVICE_QUERY_STATUS)
        try:
            # QueryServiceStatusEx returns a SERVICE_STATUS_PROCESS dict with
            # keys like CurrentState, ProcessId, etc.
            status_ex: dict[str, Any] = ws.QueryServiceStatusEx(hs)  # type: ignore[assignment]
            svc_state: int = status_ex["CurrentState"]
            pid: int = status_ex.get("ProcessId", 0)
            return {
                "service_name": SERVICE_NAME,
                "state": state_map.get(svc_state, f"unknown ({svc_state})"),
                "pid": pid if pid and svc_state == ws.SERVICE_RUNNING else None,
            }
        finally:
            ws.CloseServiceHandle(hs)
    finally:
        ws.CloseServiceHandle(hscm)


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
            from dotenv import load_dotenv

            from data_hub_watcher.api_client import ApiError, DataHubClient
            from data_hub_watcher.config_io import config_checksum, load_config
            from data_hub_watcher.constants import (
                API_URLS,
                HEARTBEAT_INTERVAL_SECONDS,
                PRUNE_DAYS,
                STATE_DB_FILENAME,
            )
            from data_hub_watcher.events import EventReporter, EventType, WatcherEvent
            from data_hub_watcher.heartbeat import HeartbeatLoop, WatcherCounters
            from data_hub_watcher.monitor import FileMonitor
            from data_hub_watcher.run_detector import RunDetector
            from data_hub_watcher.state import StateDB
            from data_hub_watcher.uploader import Uploader

            servicemanager.LogInfoMsg(f"{SERVICE_DISPLAY_NAME} starting")

            try:
                path, env_path = _read_paths_from_registry()
            except Exception as exc:
                servicemanager.LogErrorMsg(
                    f"Cannot read config/env paths from registry: {exc}. "
                    "Re-run 'data-hub-watcher service install'."
                )
                return

            load_dotenv(env_path)
            cfg = load_config(path)
            inst = cfg.instrument

            if cfg.environment == "preview":
                base_url = cfg.api_base_url
            else:
                base_url = API_URLS[cfg.environment]
            client = DataHubClient(base_url)

            # Step 1: Check instrument status (mirrors CLI watch startup)
            try:
                detail = client.get_instrument(inst.id)
                if detail.status == "pending":
                    servicemanager.LogErrorMsg(
                        f"Instrument {inst.id!r} is still pending activation. "
                        "Service cannot start until the instrument is activated."
                    )
                    return
            except ApiError as exc:
                servicemanager.LogErrorMsg(f"Cannot reach API during startup: {exc.message}")
                return

            # Step 2: Sync config checksum
            if cfg.watcher_id:
                local_cs = config_checksum(path)
                try:
                    remote = client.get_config_checksum(cfg.watcher_id)
                    if remote is None or remote.config_checksum != local_cs:
                        yaml_content = path.read_text(encoding="utf-8")
                        client.push_config(cfg.watcher_id, yaml_content, local_cs)
                        servicemanager.LogInfoMsg("Config synced to Data Hub")
                except ApiError as exc:
                    servicemanager.LogWarningMsg(f"Could not sync config to API: {exc.message}")

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
                instrument_id=inst.id,
                watch_directory=str(inst.watch_directory),
                upload_mode=inst.upload_mode,
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
                watch_directory=inst.watch_directory,
            )

            detector = RunDetector(
                pattern=inst.run_detection.pattern,
                instrument_id=inst.id,
                watcher_id=cfg.watcher_id or "",
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
# qualified name (`data_hub_watcher.service.DataHubWatcherService`).
_svc_cls = _create_service_class()
if _svc_cls is not None:
    DataHubWatcherService = _svc_cls  # noqa: F841


# --- SCM entry point ---------------------------------------------------------
# The service is registered with a binary path of:
#   "<venv>/python.exe" -m data_hub_watcher.service
# When the SCM starts the process, Python executes this __main__ block which
# hands control to the service dispatcher.

if __name__ == "__main__":
    if _svc_cls is None:
        raise SystemExit("This module must be run on Windows.")

    import servicemanager  # type: ignore[import-untyped]

    servicemanager.Initialize(SERVICE_NAME)  # type: ignore[attr-defined]
    servicemanager.PrepareToHostSingle(_svc_cls)  # type: ignore[attr-defined]
    servicemanager.StartServiceCtrlDispatcher()  # type: ignore[attr-defined]
