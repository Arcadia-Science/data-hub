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
import threading
from pathlib import Path
from typing import Any

from data_hub_watcher.constants import SERVICE_NAME

logger = logging.getLogger(__name__)

SERVICE_DISPLAY_NAME = "Data Hub Watcher"
SERVICE_DESCRIPTION = "Monitors instrument directories and uploads data files to Data Hub."

_REG_KEY = rf"SYSTEM\CurrentControlSet\Services\{SERVICE_NAME}"
_REG_CONFIG_PATH = "ConfigPath"
_REG_ENV_PATH = "EnvPath"

# Windows services that must be running before the watcher can usefully
# contact the Data Hub API. Declaring these as dependencies makes the SCM
# wait for the TCP/IP stack and DNS resolver to be ready before it tries
# to start the watcher. Combined with delayed-auto-start (below), this
# avoids the classic "service starts at boot before the network is up,
# fails its API health check, and stays stopped" failure mode.
_SERVICE_DEPENDENCIES: list[str] = ["Tcpip", "Dnscache"]


def install_service(config_path: Path, env_path: Path) -> None:
    """Install the watcher as a Windows service with automatic start and recovery.

    The service binary path is registered as
    ``"<venv>/python.exe" -m data_hub_watcher.service`` so that the
    virtual-environment's interpreter (and all installed packages) are
    available when the SCM starts the process.

    *config_path* and *env_path* are persisted to the service's registry
    key so that ``SvcDoRun`` can locate them regardless of which Windows
    user account the service runs under (typically Local System).

    The service is registered with ``delayedstart=True`` and a dependency
    on the TCP/IP and DNS-client services so it does not start until the
    network stack is up after a reboot. Without this, lab PCs frequently
    boot the service before any NIC has DHCP-leased an address, the
    initial API call fails, and the service exits.
    """
    import win32service as ws  # type: ignore[import-untyped]
    import win32serviceutil  # type: ignore[import-untyped]

    class_path = f"{__name__}.DataHubWatcherService"

    win32serviceutil.InstallService(
        pythonClassString=class_path,
        serviceName=SERVICE_NAME,
        displayName=SERVICE_DISPLAY_NAME,
        startType=ws.SERVICE_AUTO_START,
        serviceDeps=_SERVICE_DEPENDENCIES,
        exeName=sys.executable,
        exeArgs="-m data_hub_watcher.service",
        description=SERVICE_DESCRIPTION,
        delayedstart=True,
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

    We additionally set ``SERVICE_CONFIG_FAILURE_ACTIONS_FLAG`` so that
    these recovery actions fire when ``SvcDoRun`` exits with a non-zero
    code -- not only when the process actually crashes. Our startup
    sequence reports controlled failures by raising ``SystemExit(1)``,
    so without this flag the SCM would treat them as graceful stops and
    never restart the service.
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
            ws.ChangeServiceConfig2(
                hs,
                ws.SERVICE_CONFIG_FAILURE_ACTIONS_FLAG,
                {"fFailureActionsOnNonCrashFailures": True},
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


def _run_service_loop(stop_event: threading.Event, sm: Any) -> None:
    """Run the watcher service loop until *stop_event* is set.

    This is the testable body of ``DataHubWatcherService.SvcDoRun``.
    Extracted as a top-level function so unit tests can exercise the
    full startup sequence (registry read, env loading, API health
    check, checksum sync, runtime build/start/stop) on any platform
    by injecting a mock *sm* (servicemanager) and patching the
    dependencies it pulls in. ``SvcDoRun`` itself becomes a thin
    wrapper that imports ``servicemanager`` lazily and delegates here.

    Any controlled failure exits the process with a non-zero status
    via ``raise SystemExit(1)``. Combined with the
    ``SERVICE_CONFIG_FAILURE_ACTIONS_FLAG`` set by
    ``_configure_recovery``, the SCM treats such exits as service
    failures and runs the configured restart actions. This is what
    allows the service to recover from a transient API error at boot
    -- the most common reason a freshly-rebooted lab PC fails to
    bring the watcher back up.
    """
    import platform

    from dotenv import load_dotenv

    from data_hub_watcher.api_client import ApiError, DataHubClient
    from data_hub_watcher.config_io import config_checksum, load_config
    from data_hub_watcher.constants import (
        API_URLS,
        STATE_DB_FILENAME,
        env_file_path,
    )
    from data_hub_watcher.runtime import build_runtime, start_runtime, stop_runtime

    sm.LogInfoMsg(f"{SERVICE_DISPLAY_NAME} starting")

    try:
        path, env_path = _read_paths_from_registry()
    except Exception as exc:
        sm.LogErrorMsg(
            f"Cannot read config/env paths from registry: {exc}. "
            "Re-run 'data-hub-watcher service install'."
        )
        raise SystemExit(1) from exc

    # Mirror the CLI's ``load_env`` semantics: load the base
    # ``~/.data-hub/.env`` first (for any shared, non-secret values
    # an operator may keep there), then overlay the registered env
    # file (typically ``.env.<environment>``, or a custom path
    # supplied via ``service install --env-path``) so its values win.
    # Without the base-file load, an operator that splits shared
    # config from per-environment secrets would see the service
    # silently miss the shared half.
    base_env = env_file_path()
    if base_env != env_path and base_env.exists():
        load_dotenv(base_env)
    load_dotenv(env_path, override=True)
    cfg = load_config(path)
    inst = cfg.instrument

    if cfg.environment == "preview":
        # WatcherConfig's model validator guarantees api_base_url is
        # set whenever environment is "preview"; the assertion is here
        # to make that invariant visible to pyright.
        assert cfg.api_base_url is not None
        base_url = cfg.api_base_url
    else:
        base_url = API_URLS[cfg.environment]
    client = DataHubClient(base_url)

    # Step 1: Check instrument status (mirrors CLI watch startup)
    try:
        detail = client.get_instrument(inst.id)
    except ApiError as exc:
        sm.LogErrorMsg(f"Cannot reach API during startup: {exc.message}")
        raise SystemExit(1) from exc

    if detail.status == "pending":
        sm.LogErrorMsg(
            f"Instrument {inst.id!r} is still pending activation. "
            "Service cannot start until the instrument is activated."
        )
        raise SystemExit(1)

    # Step 2: Sync config checksum
    if cfg.watcher_id:
        local_cs = config_checksum(path)
        try:
            remote = client.get_config_checksum(cfg.watcher_id)
            if remote is None or remote.config_checksum != local_cs:
                yaml_content = path.read_text(encoding="utf-8")
                client.push_config(cfg.watcher_id, yaml_content, local_cs)
                sm.LogInfoMsg("Config synced to Data Hub")
        except ApiError as exc:
            sm.LogWarningMsg(f"Could not sync config to API: {exc.message}")

    # build_runtime asserts cfg.watcher_id is set; surface that as
    # a service-manager error rather than a hard crash so operators
    # see a clear message in the Windows event log.
    if not cfg.watcher_id:
        sm.LogErrorMsg("No watcher_id in config. Run 'data-hub-watcher init' first.")
        raise SystemExit(1)

    db_path = path.parent / STATE_DB_FILENAME
    rt = build_runtime(client=client, cfg=cfg, db_path=db_path)

    start_runtime(rt, started_message=f"Service started on {platform.node()}")

    sm.LogInfoMsg(f"{SERVICE_DISPLAY_NAME} is running")

    # Wait for either the SCM's stop_event (operator-initiated stop, or
    # OS shutdown) or the runtime's shutdown_event (in-process updater
    # finished installing a new wheel and wants the SCM to restart us).
    # Polling on a 1-second tick keeps wakeup latency low for both paths.
    while not stop_event.is_set():
        if rt.shutdown_event.wait(timeout=1.0):
            break

    stop_runtime(rt, stopped_message="Service stopped")

    if rt.upgrade_restart_event.is_set():
        sm.LogInfoMsg(f"{SERVICE_DISPLAY_NAME} restarting to load upgraded watcher")
        # Exit non-zero so the SCM's failure-actions config kicks in and
        # restarts the service on the configured 60 s delay. Without
        # SERVICE_CONFIG_FAILURE_ACTIONS_FLAG this would look like a
        # graceful exit and the SCM wouldn't restart us — see the long
        # comment on `_configure_recovery` for details.
        raise SystemExit(1)

    sm.LogInfoMsg(f"{SERVICE_DISPLAY_NAME} stopped")


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
            self._stop_event = threading.Event()

        def SvcDoRun(self) -> None:
            import servicemanager  # type: ignore[import-untyped]

            _run_service_loop(self._stop_event, servicemanager)

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
