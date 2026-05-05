"""Unit tests for the Windows service module.

The service module imports ``win32service``, ``win32serviceutil``,
``winreg``, and ``servicemanager`` lazily inside each function so it can
be imported on any platform. These tests exploit that by injecting
``MagicMock`` stand-ins via ``sys.modules`` *before* importing
``data_hub_watcher.service``, then exercise:

* the SCM-facing helpers (``install_service``, ``uninstall_service``,
  ``start_service``, ``stop_service``, ``_configure_recovery``,
  ``query_service_status``) by asserting on the arguments passed to the
  fake win32 modules; and
* the testable startup body ``_run_service_loop`` by patching the
  side-effecting collaborators (config loader, ``DataHubClient``,
  ``build_runtime`` / ``start_runtime`` / ``stop_runtime``) and a fake
  ``servicemanager`` object.

This locks in regressions of the kind that have historically shipped to
production lab PCs (delayed-start + non-crash failure flags, network
dependencies, manual-mode wiring) without needing a Windows runner.
"""

from __future__ import annotations
import importlib
import sys
import threading
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType
from typing import Any
from unittest.mock import MagicMock

import pytest

from data_hub_watcher.api_client import ApiError
from data_hub_watcher.models import (
    InstrumentConfig,
    InstrumentDetailResponse,
    RunDetectionConfig,
    WatcherConfig,
)

# Real winreg.REG_SZ and win32service.SERVICE_RUNNING values. Using the
# real numeric values lets ``query_service_status`` look them up in its
# state_map keyed on those constants without having to special-case the
# fakes.
_REG_SZ = 1
_SERVICE_RUNNING = 4
_SERVICE_STOPPED = 1


def _make_win32_fakes() -> dict[str, ModuleType]:
    """Build ``sys.modules`` stand-ins for the four win32 modules.

    Each returned mock pre-populates the constants the service module
    actually reads (e.g. ``ws.SERVICE_AUTO_START``, ``winreg.REG_SZ``)
    with concrete values so callers can assert on them.
    """
    winreg = MagicMock(name="winreg")
    winreg.HKEY_LOCAL_MACHINE = "HKLM"
    winreg.KEY_SET_VALUE = "KEY_SET_VALUE"
    winreg.KEY_QUERY_VALUE = "KEY_QUERY_VALUE"
    winreg.REG_SZ = _REG_SZ

    ws = MagicMock(name="win32service")
    ws.SERVICE_AUTO_START = "SERVICE_AUTO_START"
    ws.SC_MANAGER_ALL_ACCESS = "SC_MANAGER_ALL_ACCESS"
    ws.SC_MANAGER_CONNECT = "SC_MANAGER_CONNECT"
    ws.SERVICE_ALL_ACCESS = "SERVICE_ALL_ACCESS"
    ws.SERVICE_QUERY_STATUS = "SERVICE_QUERY_STATUS"
    ws.SERVICE_CONFIG_FAILURE_ACTIONS = "SERVICE_CONFIG_FAILURE_ACTIONS"
    ws.SERVICE_CONFIG_FAILURE_ACTIONS_FLAG = "SERVICE_CONFIG_FAILURE_ACTIONS_FLAG"
    ws.SERVICE_STOPPED = _SERVICE_STOPPED
    ws.SERVICE_START_PENDING = 2
    ws.SERVICE_STOP_PENDING = 3
    ws.SERVICE_RUNNING = _SERVICE_RUNNING
    ws.SERVICE_CONTINUE_PENDING = 5
    ws.SERVICE_PAUSE_PENDING = 6
    ws.SERVICE_PAUSED = 7

    win32serviceutil = MagicMock(name="win32serviceutil")
    servicemanager = MagicMock(name="servicemanager")

    # ``pywintypes.error`` is the base SCM exception type. The real class
    # is ``(winerror, funcname, strerror)`` and exposes ``.winerror`` as
    # an attribute. Using a real subclass of Exception (rather than a
    # MagicMock) means the service module's ``except pywintypes.error``
    # actually catches it instead of letting it through as a plain Mock.
    class _PyWinError(Exception):
        def __init__(self, winerror: int, funcname: str = "", strerror: str = "") -> None:
            super().__init__(winerror, funcname, strerror)
            self.winerror = winerror
            self.funcname = funcname
            self.strerror = strerror

    pywintypes = MagicMock(name="pywintypes")
    pywintypes.error = _PyWinError

    return {
        "winreg": winreg,
        "win32service": ws,
        "win32serviceutil": win32serviceutil,
        "servicemanager": servicemanager,
        "pywintypes": pywintypes,
    }


@pytest.fixture
def service_module(monkeypatch: pytest.MonkeyPatch) -> Iterator[ModuleType]:
    """Reload ``data_hub_watcher.service`` with fresh win32 fakes.

    Each test gets its own set of fakes so call counts and recorded
    arguments are isolated. The fakes are injected into ``sys.modules``
    before the reload so that the lazy ``import`` statements inside
    each function pick them up.
    """
    fakes = _make_win32_fakes()
    for name, mod in fakes.items():
        monkeypatch.setitem(sys.modules, name, mod)

    import data_hub_watcher.service as svc

    reloaded = importlib.reload(svc)
    yield reloaded
    # Reload once more on teardown with the real (or absent) win32
    # modules popped so other tests don't see stale state. monkeypatch
    # automatically restores sys.modules.
    importlib.reload(svc)


# --- Registry round-trip + helpers ------------------------------------------


class TestRegistryRoundTrip:
    """``_store_paths_in_registry`` + ``_read_paths_from_registry`` form a pair."""

    def test_store_then_read_returns_same_paths(self, service_module: ModuleType) -> None:
        winreg = sys.modules["winreg"]
        config_path = Path("C:/data-hub/config.yaml")
        env_path = Path("C:/data-hub/.env.staging")

        # Build a fake registry key that records writes and replays them
        # for the corresponding read.
        stored: dict[str, str] = {}
        fake_key = MagicMock(name="reg_key")
        winreg.OpenKey.return_value = fake_key

        def _set(key: Any, name: str, _reserved: int, _type: int, value: str) -> None:
            stored[name] = value

        def _query(key: Any, name: str) -> tuple[str, int]:
            return stored[name], _REG_SZ

        winreg.SetValueEx.side_effect = _set
        winreg.QueryValueEx.side_effect = _query

        service_module._store_paths_in_registry(config_path, env_path)
        got_cfg, got_env = service_module._read_paths_from_registry()

        assert got_cfg == config_path
        assert got_env == env_path

    def test_store_writes_under_hklm_with_set_value_access(
        self, service_module: ModuleType
    ) -> None:
        winreg = sys.modules["winreg"]
        winreg.OpenKey.return_value = MagicMock()

        service_module._store_paths_in_registry(Path("c.yaml"), Path("e.env"))

        winreg.OpenKey.assert_called_once_with(
            "HKLM",
            service_module._REG_KEY,
            0,
            "KEY_SET_VALUE",
        )
        names_written = [call.args[1] for call in winreg.SetValueEx.call_args_list]
        assert names_written == [
            service_module._REG_CONFIG_PATH,
            service_module._REG_ENV_PATH,
        ]
        # Both writes use the string registry value type.
        for call in winreg.SetValueEx.call_args_list:
            assert call.args[3] == _REG_SZ

    def test_delete_paths_silently_ignores_missing_key(self, service_module: ModuleType) -> None:
        winreg = sys.modules["winreg"]
        winreg.OpenKey.side_effect = OSError("key not found")

        # Must not raise even if the key doesn't exist.
        service_module._delete_paths_from_registry()

        winreg.DeleteValue.assert_not_called()

    def test_delete_paths_removes_both_values(self, service_module: ModuleType) -> None:
        winreg = sys.modules["winreg"]
        winreg.OpenKey.return_value = MagicMock()

        service_module._delete_paths_from_registry()

        deleted_names = [call.args[1] for call in winreg.DeleteValue.call_args_list]
        assert deleted_names == [
            service_module._REG_CONFIG_PATH,
            service_module._REG_ENV_PATH,
        ]


# --- install_service argument shape -----------------------------------------


class TestInstallService:
    """``install_service`` must register the service with very specific kwargs.

    The exact shape is what makes a freshly-rebooted lab PC bring the
    watcher back up reliably (delayed start + network deps + recovery).
    Regressions here have repeatedly broken production.
    """

    def test_install_passes_expected_kwargs_to_win32serviceutil(
        self,
        service_module: ModuleType,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        win32serviceutil = sys.modules["win32serviceutil"]
        sys.modules["winreg"].OpenKey.return_value = MagicMock()
        # The upgrade-worker registration is exercised in its own
        # test below; this test only cares about the SCM kwargs and
        # would otherwise try to invoke the real `schtasks.exe`.
        monkeypatch.setattr(service_module, "_install_upgrade_worker", lambda: None)

        service_module.install_service(Path("c.yaml"), Path("e.env"))

        win32serviceutil.InstallService.assert_called_once()
        kwargs = win32serviceutil.InstallService.call_args.kwargs
        assert kwargs["pythonClassString"] == ("data_hub_watcher.service.DataHubWatcherService")
        assert kwargs["serviceName"] == service_module.SERVICE_NAME
        assert kwargs["displayName"] == service_module.SERVICE_DISPLAY_NAME
        assert kwargs["startType"] == "SERVICE_AUTO_START"
        assert kwargs["serviceDeps"] == ["Tcpip", "Dnscache"]
        assert kwargs["exeArgs"] == "-m data_hub_watcher.service"
        assert kwargs["delayedstart"] is True
        assert kwargs["description"] == service_module.SERVICE_DESCRIPTION

    def test_install_persists_paths_and_configures_recovery(
        self,
        service_module: ModuleType,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        sys.modules["winreg"].OpenKey.return_value = MagicMock()
        store_calls: list[tuple[Path, Path]] = []
        recovery_calls: list[None] = []
        worker_calls: list[None] = []

        monkeypatch.setattr(
            service_module,
            "_store_paths_in_registry",
            lambda p, e: store_calls.append((p, e)),
        )
        monkeypatch.setattr(
            service_module,
            "_configure_recovery",
            lambda: recovery_calls.append(None),
        )
        monkeypatch.setattr(
            service_module,
            "_install_upgrade_worker",
            lambda: worker_calls.append(None),
        )

        service_module.install_service(Path("c.yaml"), Path("e.env"))

        assert store_calls == [(Path("c.yaml"), Path("e.env"))]
        assert recovery_calls == [None]
        # Critical regression guard: `install_service` must always
        # register the upgrade worker. A fleet PC installed without
        # it would silently fall back to the broken in-process
        # upgrade path on the next auto-update tick.
        assert worker_calls == [None]


class TestInstallUpgradeWorker:
    """The upgrade-worker scheduled task is wired in alongside the SCM bits.

    These tests exercise the small ``_install_upgrade_worker`` /
    ``_uninstall_upgrade_worker`` helpers directly, mocking out the
    schtasks + filesystem side-effects so we assert on the call
    contract rather than touching the real system.
    """

    def test_install_writes_script_and_registers_task(
        self,
        service_module: ModuleType,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
    ) -> None:
        # Redirect the well-known config dir into a temp dir so the
        # rendered script lands somewhere we can inspect.
        monkeypatch.setattr(service_module, "DEFAULT_CONFIG_DIR", tmp_path)

        install_calls: list[Path] = []
        monkeypatch.setattr(
            "data_hub_watcher.scheduled_task.install_upgrade_task",
            lambda script_path: install_calls.append(script_path),
        )

        service_module._install_upgrade_worker()

        # Script is on disk under the patched config dir.
        from data_hub_watcher.upgrade_worker import upgrade_worker_script_path

        script_path = upgrade_worker_script_path(tmp_path)
        assert script_path.exists()
        assert "Stop-Service" in script_path.read_text(encoding="utf-8")
        # Task installer was handed the same path.
        assert install_calls == [script_path]

    def test_uninstall_removes_task_and_script(
        self,
        service_module: ModuleType,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
    ) -> None:
        monkeypatch.setattr(service_module, "DEFAULT_CONFIG_DIR", tmp_path)

        from data_hub_watcher.upgrade_worker import upgrade_worker_script_path

        script_path = upgrade_worker_script_path(tmp_path)
        script_path.parent.mkdir(parents=True, exist_ok=True)
        script_path.write_text("# stub", encoding="utf-8")

        uninstall_calls: list[None] = []
        monkeypatch.setattr(
            "data_hub_watcher.scheduled_task.uninstall_upgrade_task",
            lambda: uninstall_calls.append(None),
        )

        service_module._uninstall_upgrade_worker()

        assert uninstall_calls == [None]
        assert not script_path.exists()

    def test_uninstall_swallows_scheduled_task_errors(
        self,
        service_module: ModuleType,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
    ) -> None:
        # A half-installed host or one where Task Scheduler refuses to
        # talk to us must not block ``service uninstall`` — leaving
        # the host with a partially-uninstalled service is strictly
        # worse than silently missing the worker cleanup.
        monkeypatch.setattr(service_module, "DEFAULT_CONFIG_DIR", tmp_path)

        from data_hub_watcher.scheduled_task import ScheduledTaskError

        def boom() -> None:
            raise ScheduledTaskError("nope", argv=["schtasks.exe"], stderr="rpc dead")

        monkeypatch.setattr(
            "data_hub_watcher.scheduled_task.uninstall_upgrade_task",
            boom,
        )
        # Must not raise.
        service_module._uninstall_upgrade_worker()


class TestRepairUpgradeWorkerOnStartup:
    """The startup self-repair re-installs the task when it goes missing.

    Lab PCs that auto-update into the worker-aware code without an
    explicit ``service install`` first won't have the task registered.
    The startup hook fixes this on the next service tick so the next
    auto-update can succeed.
    """

    def test_repair_skipped_when_task_already_registered(
        self,
        service_module: ModuleType,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        sm = MagicMock(name="servicemanager")
        monkeypatch.setattr("data_hub_watcher.scheduled_task.task_exists", lambda: True)
        install_calls: list[Path] = []
        monkeypatch.setattr(
            "data_hub_watcher.scheduled_task.install_upgrade_task",
            lambda script_path: install_calls.append(script_path),
        )

        service_module._repair_upgrade_worker_if_missing(sm)

        assert install_calls == []

    def test_repair_re_registers_when_task_missing(
        self,
        service_module: ModuleType,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
    ) -> None:
        monkeypatch.setattr(service_module, "DEFAULT_CONFIG_DIR", tmp_path)
        sm = MagicMock(name="servicemanager")
        monkeypatch.setattr("data_hub_watcher.scheduled_task.task_exists", lambda: False)
        install_calls: list[Path] = []
        monkeypatch.setattr(
            "data_hub_watcher.scheduled_task.install_upgrade_task",
            lambda script_path: install_calls.append(script_path),
        )

        service_module._repair_upgrade_worker_if_missing(sm)

        from data_hub_watcher.upgrade_worker import upgrade_worker_script_path

        assert install_calls == [upgrade_worker_script_path(tmp_path)]
        assert upgrade_worker_script_path(tmp_path).exists()

    def test_repair_swallows_query_errors(
        self,
        service_module: ModuleType,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # If we can't even query Task Scheduler we should NOT block
        # service startup — the host should keep running its current
        # version and surface the issue via LogWarningMsg + the next
        # auto-update event.
        from data_hub_watcher.scheduled_task import ScheduledTaskError

        sm = MagicMock(name="servicemanager")

        def boom() -> bool:
            raise ScheduledTaskError("rpc dead")

        monkeypatch.setattr("data_hub_watcher.scheduled_task.task_exists", boom)
        # Must not raise.
        service_module._repair_upgrade_worker_if_missing(sm)
        sm.LogWarningMsg.assert_called_once()

    def test_repair_swallows_install_failures(
        self,
        service_module: ModuleType,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
    ) -> None:
        from data_hub_watcher.scheduled_task import ScheduledTaskError

        monkeypatch.setattr(service_module, "DEFAULT_CONFIG_DIR", tmp_path)
        sm = MagicMock(name="servicemanager")
        monkeypatch.setattr("data_hub_watcher.scheduled_task.task_exists", lambda: False)

        def boom(script_path: Path) -> None:
            raise ScheduledTaskError("Access is denied")

        monkeypatch.setattr("data_hub_watcher.scheduled_task.install_upgrade_task", boom)
        # Must not raise even when re-registration fails.
        service_module._repair_upgrade_worker_if_missing(sm)
        sm.LogWarningMsg.assert_called_once()


# --- _configure_recovery actions + non-crash failure flag --------------------


class TestConfigureRecovery:
    """Lock in the recovery contract added in commit 1712c70.

    The watcher's two-restart-then-stop policy + the
    ``fFailureActionsOnNonCrashFailures`` flag are what make a lab PC
    survive a transient API outage at boot. Without the flag, the SCM
    treats our ``SystemExit(1)`` as a graceful stop.
    """

    def test_configure_recovery_sets_two_restarts_then_no_action(
        self, service_module: ModuleType
    ) -> None:
        ws = sys.modules["win32service"]
        fake_scm = MagicMock(name="scm_handle")
        fake_svc = MagicMock(name="service_handle")
        ws.OpenSCManager.return_value = fake_scm
        ws.OpenService.return_value = fake_svc

        service_module._configure_recovery()

        ws.OpenSCManager.assert_called_once_with(None, None, "SC_MANAGER_ALL_ACCESS")
        ws.OpenService.assert_called_once_with(
            fake_scm, service_module.SERVICE_NAME, "SERVICE_ALL_ACCESS"
        )

        # Two ChangeServiceConfig2 calls: one for the actions, one for the flag.
        assert ws.ChangeServiceConfig2.call_count == 2
        actions_call, flag_call = ws.ChangeServiceConfig2.call_args_list

        # First call: failure-actions list.
        assert actions_call.args[1] == "SERVICE_CONFIG_FAILURE_ACTIONS"
        actions_payload = actions_call.args[2]
        assert actions_payload["ResetPeriod"] == 86400
        assert actions_payload["Actions"] == [
            (1, 60_000),
            (1, 120_000),
            (0, 0),
        ]

        # Second call: the non-crash failure flag must be enabled. This
        # is the bit that makes the SCM honour our SystemExit(1) as a
        # failure and trigger the actions above.
        assert flag_call.args[1] == "SERVICE_CONFIG_FAILURE_ACTIONS_FLAG"
        assert flag_call.args[2] == {"fFailureActionsOnNonCrashFailures": True}

    def test_configure_recovery_closes_handles(self, service_module: ModuleType) -> None:
        ws = sys.modules["win32service"]
        fake_scm = MagicMock()
        fake_svc = MagicMock()
        ws.OpenSCManager.return_value = fake_scm
        ws.OpenService.return_value = fake_svc

        service_module._configure_recovery()

        # Both handles must be closed even on the happy path.
        closed = [call.args[0] for call in ws.CloseServiceHandle.call_args_list]
        assert fake_svc in closed
        assert fake_scm in closed


# --- uninstall / start / stop ------------------------------------------------


class TestServiceLifecycle:
    def test_uninstall_stops_clears_registry_and_removes(
        self,
        service_module: ModuleType,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        win32serviceutil = sys.modules["win32serviceutil"]
        delete_calls: list[None] = []
        worker_calls: list[None] = []
        monkeypatch.setattr(
            service_module,
            "_delete_paths_from_registry",
            lambda: delete_calls.append(None),
        )
        monkeypatch.setattr(
            service_module,
            "_uninstall_upgrade_worker",
            lambda: worker_calls.append(None),
        )

        service_module.uninstall_service()

        win32serviceutil.StopService.assert_called_once_with(service_module.SERVICE_NAME)
        assert delete_calls == [None]
        # Uninstall must also tear down the upgrade worker so a
        # subsequent reinstall starts from a clean slate.
        assert worker_calls == [None]
        win32serviceutil.RemoveService.assert_called_once_with(service_module.SERVICE_NAME)

    def test_uninstall_swallows_stop_errors(
        self,
        service_module: ModuleType,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        win32serviceutil = sys.modules["win32serviceutil"]
        win32serviceutil.StopService.side_effect = RuntimeError("not running")
        monkeypatch.setattr(service_module, "_delete_paths_from_registry", lambda: None)
        monkeypatch.setattr(service_module, "_uninstall_upgrade_worker", lambda: None)

        # Even if StopService raises (e.g. service already stopped or
        # doesn't exist), uninstall must still proceed to RemoveService.
        service_module.uninstall_service()

        win32serviceutil.RemoveService.assert_called_once()

    def test_start_service_delegates(self, service_module: ModuleType) -> None:
        win32serviceutil = sys.modules["win32serviceutil"]
        service_module.start_service()
        win32serviceutil.StartService.assert_called_once_with(service_module.SERVICE_NAME)

    def test_stop_service_delegates(self, service_module: ModuleType) -> None:
        win32serviceutil = sys.modules["win32serviceutil"]
        service_module.stop_service()
        win32serviceutil.StopService.assert_called_once_with(service_module.SERVICE_NAME)


# --- wait_for_service_removed -----------------------------------------------


class TestWaitForServiceRemoved:
    """Polls SCM until DeleteService finalises.

    The SCM marks the service for deletion synchronously but only
    finishes the delete once every open handle is closed.  Without the
    poll, ``service reinstall`` races into ``CreateService`` and dies
    with the inscrutable error 1072 ("marked for deletion") whenever a
    Services console (services.msc) or AV agent has the service open on
    the host.
    """

    @staticmethod
    def _patch_clock(monkeypatch: pytest.MonkeyPatch, service_module: ModuleType) -> list[float]:
        """Replace ``time.monotonic`` / ``time.sleep`` with a deterministic clock.

        Returns the list backing the clock so individual tests can
        observe how many "ticks" the loop ran for.
        """
        clock = [0.0]

        def fake_monotonic() -> float:
            return clock[0]

        def fake_sleep(seconds: float) -> None:
            clock[0] += seconds

        monkeypatch.setattr(service_module.time, "monotonic", fake_monotonic)
        monkeypatch.setattr(service_module.time, "sleep", fake_sleep)
        return clock

    def test_returns_true_immediately_when_service_does_not_exist(
        self,
        service_module: ModuleType,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        ws = sys.modules["win32service"]
        pywintypes = sys.modules["pywintypes"]
        ws.OpenSCManager.return_value = MagicMock(name="scm")
        ws.OpenService.side_effect = pywintypes.error(1060, "OpenService", "does not exist")

        clock = self._patch_clock(monkeypatch, service_module)
        result = service_module.wait_for_service_removed(timeout_seconds=5.0)

        assert result is True
        assert ws.OpenService.call_count == 1
        # No retries needed -> no time spent waiting.
        assert clock[0] == 0.0
        # SCM handle must be closed even on the fast-path success.
        ws.CloseServiceHandle.assert_called_once_with(ws.OpenSCManager.return_value)

    def test_polls_until_service_disappears(
        self,
        service_module: ModuleType,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        ws = sys.modules["win32service"]
        pywintypes = sys.modules["pywintypes"]
        scm_handle = MagicMock(name="scm")
        svc_handle = MagicMock(name="svc")
        ws.OpenSCManager.return_value = scm_handle

        # Three "still marked for deletion" responses, then the service
        # is finally gone. The loop must close its OpenService handle on
        # each successful open so it doesn't itself become the thing
        # holding deletion open.
        responses: list[Any] = [
            svc_handle,
            svc_handle,
            svc_handle,
            pywintypes.error(1060, "OpenService", "does not exist"),
        ]

        def open_service(*_args: Any, **_kwargs: Any) -> Any:
            r = responses.pop(0)
            if isinstance(r, Exception):
                raise r
            return r

        ws.OpenService.side_effect = open_service

        self._patch_clock(monkeypatch, service_module)
        result = service_module.wait_for_service_removed(
            timeout_seconds=10.0, poll_interval_seconds=0.5
        )

        assert result is True
        assert ws.OpenService.call_count == 4
        # Service handle closed once per successful open (3) + SCM
        # handle closed once at the end = 4 total.
        close_targets = [c.args[0] for c in ws.CloseServiceHandle.call_args_list]
        assert close_targets.count(svc_handle) == 3
        assert close_targets.count(scm_handle) == 1

    def test_returns_false_after_timeout(
        self,
        service_module: ModuleType,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        ws = sys.modules["win32service"]
        ws.OpenSCManager.return_value = MagicMock(name="scm")
        # Service stays openable forever -> we should give up cleanly.
        ws.OpenService.return_value = MagicMock(name="svc")

        self._patch_clock(monkeypatch, service_module)
        result = service_module.wait_for_service_removed(
            timeout_seconds=2.0, poll_interval_seconds=0.5
        )

        assert result is False
        # SCM handle must still be released so we don't leak it back to
        # the caller (who will likely retry).
        assert any(
            c.args[0] is ws.OpenSCManager.return_value for c in ws.CloseServiceHandle.call_args_list
        )

    def test_unrelated_pywin_error_propagates(
        self,
        service_module: ModuleType,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # Access denied (5) is the kind of error operators need to see —
        # silently swallowing it would mask a permissions problem.
        ws = sys.modules["win32service"]
        pywintypes = sys.modules["pywintypes"]
        ws.OpenSCManager.return_value = MagicMock(name="scm")
        ws.OpenService.side_effect = pywintypes.error(5, "OpenService", "Access is denied")

        self._patch_clock(monkeypatch, service_module)

        with pytest.raises(pywintypes.error) as excinfo:
            service_module.wait_for_service_removed(timeout_seconds=2.0)

        assert excinfo.value.winerror == 5
        # Even on the error path the SCM handle must be released.
        ws.CloseServiceHandle.assert_called_once_with(ws.OpenSCManager.return_value)


# --- query_service_status ----------------------------------------------------


class TestQueryServiceStatus:
    def test_running_state_returns_pid(self, service_module: ModuleType) -> None:
        ws = sys.modules["win32service"]
        ws.OpenSCManager.return_value = MagicMock()
        ws.OpenService.return_value = MagicMock()
        ws.QueryServiceStatusEx.return_value = {
            "CurrentState": _SERVICE_RUNNING,
            "ProcessId": 4321,
        }

        result = service_module.query_service_status()

        assert result == {
            "service_name": service_module.SERVICE_NAME,
            "state": "running",
            "pid": 4321,
        }

    def test_stopped_state_returns_none_pid(self, service_module: ModuleType) -> None:
        ws = sys.modules["win32service"]
        ws.OpenSCManager.return_value = MagicMock()
        ws.OpenService.return_value = MagicMock()
        # Real services often report a stale pid even when stopped; the
        # code must zero it out so callers don't show a phantom process.
        ws.QueryServiceStatusEx.return_value = {
            "CurrentState": _SERVICE_STOPPED,
            "ProcessId": 9999,
        }

        result = service_module.query_service_status()

        assert result["state"] == "stopped"
        assert result["pid"] is None


# --- _run_service_loop -------------------------------------------------------


def _make_config(
    tmp_path: Path,
    *,
    watcher_id: str | None = "w-test",
    environment: str = "staging",
) -> WatcherConfig:
    """Build a minimal valid `WatcherConfig` rooted in *tmp_path*.

    Mirrors the helper in ``test_runtime.py`` so the two suites share
    the same fixture shape.
    """
    watch_dir = tmp_path / "data"
    watch_dir.mkdir()
    (watch_dir / "RUN001_sample.csv").write_text("a,b\n1,2\n")
    instrument = InstrumentConfig(
        id="test-instrument",
        watch_directory=watch_dir,
        file_patterns=["*.csv"],
        upload_mode="auto",
        run_detection=RunDetectionConfig(pattern=r"^([^_]+)", recursive=False),
    )
    return WatcherConfig(
        version=1,
        environment=environment,  # type: ignore[arg-type]
        watcher_id=watcher_id,
        instrument=instrument,
    )


def _make_instrument_detail(status: str = "active") -> InstrumentDetailResponse:
    return InstrumentDetailResponse(
        id="test-instrument",
        display_name="Test Instrument",
        status=status,  # type: ignore[arg-type]
        run_count=0,
        watcher_count=1,
    )


class _LoopHarness:
    """Patches the collaborators of ``_run_service_loop``.

    Keeps the patches in one place so each test only needs to override
    the one thing it cares about (failing API call, missing watcher_id,
    etc.). Returns a populated ``servicemanager`` mock so tests can
    assert which log functions were called.
    """

    def __init__(
        self,
        service_module: ModuleType,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
    ) -> None:
        self.svc = service_module
        self.monkeypatch = monkeypatch
        self.tmp_path = tmp_path
        self.config_path = tmp_path / "config.yaml"
        self.env_path = tmp_path / ".env.staging"
        self.config_path.write_text("# placeholder, content is mocked away\n")
        self.env_path.write_text("")
        self.cfg = _make_config(tmp_path)
        self.client = MagicMock(name="DataHubClient")
        self.client.get_instrument.return_value = _make_instrument_detail("active")
        self.client.get_config_checksum.return_value = None
        self.runtime = MagicMock(name="WatcherRuntime")
        # Replace the auto-update plumbing fields with real Events so the
        # service loop's wait-and-test sequence behaves naturally rather
        # than always seeing truthy MagicMock attributes.
        self.runtime.shutdown_event = threading.Event()
        self.runtime.upgrade_restart_event = threading.Event()
        self.start_calls: list[Any] = []
        self.stop_calls: list[Any] = []
        self.sm = MagicMock(name="servicemanager")

        # Patch the registry read at the service-module level so the
        # winreg fake doesn't need to participate.
        monkeypatch.setattr(
            service_module,
            "_read_paths_from_registry",
            lambda: (self.config_path, self.env_path),
        )

        # Stub out the upgrade-worker self-repair so existing
        # ``_run_service_loop`` tests don't try to invoke ``schtasks.exe``
        # — that helper has its own dedicated test class above.
        self.repair_calls: list[Any] = []
        monkeypatch.setattr(
            service_module,
            "_repair_upgrade_worker_if_missing",
            lambda sm: self.repair_calls.append(sm),
        )

        # Patch source modules of the lazy imports inside _run_service_loop.
        from data_hub_watcher import api_client, config_io, constants, runtime

        monkeypatch.setattr(api_client, "DataHubClient", lambda *_a, **_kw: self.client)
        monkeypatch.setattr(config_io, "load_config", lambda _p: self.cfg)
        monkeypatch.setattr(config_io, "config_checksum", lambda _p: "deadbeef")
        # env_file_path is called with no argument in _run_service_loop;
        # return a path that's not on disk so the "if base_env != env_path
        # and base_env.exists()" branch short-circuits.
        monkeypatch.setattr(
            constants,
            "env_file_path",
            lambda environment=None: tmp_path / ".env.nonexistent",
        )
        monkeypatch.setattr(
            runtime,
            "build_runtime",
            lambda **_kw: self.runtime,
        )
        monkeypatch.setattr(
            runtime,
            "start_runtime",
            lambda rt, started_message="": self.start_calls.append((rt, started_message)),
        )
        monkeypatch.setattr(
            runtime,
            "stop_runtime",
            lambda rt, stopped_message="": self.stop_calls.append((rt, stopped_message)),
        )

        # load_dotenv is imported directly inside the function from
        # `dotenv`, so patch it on the dotenv module.
        import dotenv

        self.dotenv_calls: list[Any] = []
        monkeypatch.setattr(
            dotenv,
            "load_dotenv",
            lambda *args, **kwargs: self.dotenv_calls.append((args, kwargs)),
        )


@pytest.fixture
def harness(
    service_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> _LoopHarness:
    return _LoopHarness(service_module, monkeypatch, tmp_path)


class TestRunServiceLoopHappyPath:
    def test_full_startup_through_stop(self, harness: _LoopHarness) -> None:
        stop_event = threading.Event()
        # Pre-set the stop event so loop returns immediately after start.
        stop_event.set()

        harness.svc._run_service_loop(stop_event, harness.sm)

        # The full sequence ran in order:
        harness.client.get_instrument.assert_called_once_with("test-instrument")
        # Checksum sync was attempted (remote was None -> push_config).
        harness.client.get_config_checksum.assert_called_once_with("w-test")
        harness.client.push_config.assert_called_once()
        assert len(harness.start_calls) == 1
        assert len(harness.stop_calls) == 1
        # Sanity-check the start/stop messages reach the runtime so the
        # API event log shows the boot/shutdown.
        assert "Service started" in harness.start_calls[0][1]
        assert harness.stop_calls[0][1] == "Service stopped"
        # No error logs.
        harness.sm.LogErrorMsg.assert_not_called()

    def test_overlays_env_files_in_order(self, harness: _LoopHarness) -> None:
        # base_env defaults to a non-existent path in the harness, so
        # only the registered env_path should be loaded. Make the base
        # exist to verify the overlay behaviour.
        from data_hub_watcher import constants

        base_env = harness.tmp_path / ".env.base"
        base_env.write_text("")
        harness.monkeypatch.setattr(constants, "env_file_path", lambda environment=None: base_env)

        stop_event = threading.Event()
        stop_event.set()
        harness.svc._run_service_loop(stop_event, harness.sm)

        # Two load_dotenv calls: base first (no override), then registered
        # env_path with override=True.
        assert len(harness.dotenv_calls) == 2
        first_args, first_kwargs = harness.dotenv_calls[0]
        second_args, second_kwargs = harness.dotenv_calls[1]
        assert first_args == (base_env,)
        assert "override" not in first_kwargs or first_kwargs["override"] is False
        assert second_args == (harness.env_path,)
        assert second_kwargs == {"override": True}


class TestRunServiceLoopFailures:
    def test_registry_read_failure_exits_with_error_log(self, harness: _LoopHarness) -> None:
        def boom() -> tuple[Path, Path]:
            raise OSError("registry key missing")

        harness.monkeypatch.setattr(harness.svc, "_read_paths_from_registry", boom)

        with pytest.raises(SystemExit) as excinfo:
            harness.svc._run_service_loop(threading.Event(), harness.sm)

        assert excinfo.value.code == 1
        harness.sm.LogErrorMsg.assert_called_once()
        msg = harness.sm.LogErrorMsg.call_args.args[0]
        assert "registry" in msg.lower()
        assert "service install" in msg
        # No runtime should have been built.
        assert harness.start_calls == []

    def test_api_unreachable_at_startup_exits(self, harness: _LoopHarness) -> None:
        # This is the boot-before-network failure mode that the
        # SERVICE_CONFIG_FAILURE_ACTIONS_FLAG exists to recover from.
        harness.client.get_instrument.side_effect = ApiError("connection refused", status_code=0)

        with pytest.raises(SystemExit) as excinfo:
            harness.svc._run_service_loop(threading.Event(), harness.sm)

        assert excinfo.value.code == 1
        harness.sm.LogErrorMsg.assert_called_once()
        assert "API" in harness.sm.LogErrorMsg.call_args.args[0]
        assert harness.start_calls == []

    def test_pending_instrument_exits(self, harness: _LoopHarness) -> None:
        harness.client.get_instrument.return_value = _make_instrument_detail("pending")

        with pytest.raises(SystemExit) as excinfo:
            harness.svc._run_service_loop(threading.Event(), harness.sm)

        assert excinfo.value.code == 1
        harness.sm.LogErrorMsg.assert_called_once()
        assert "pending" in harness.sm.LogErrorMsg.call_args.args[0]
        assert harness.start_calls == []

    def test_missing_watcher_id_exits_after_status_check(self, harness: _LoopHarness) -> None:
        # Rebuild config without a watcher_id. The startup must reach
        # the explicit guard (not crash inside build_runtime's assert)
        # so operators get a clear log line.
        from data_hub_watcher import config_io

        extra = harness.tmp_path / "extra"
        extra.mkdir()
        cfg = _make_config(extra, watcher_id=None)
        harness.monkeypatch.setattr(config_io, "load_config", lambda _p: cfg)

        with pytest.raises(SystemExit) as excinfo:
            harness.svc._run_service_loop(threading.Event(), harness.sm)

        assert excinfo.value.code == 1
        harness.sm.LogErrorMsg.assert_called_once()
        assert "watcher_id" in harness.sm.LogErrorMsg.call_args.args[0]
        assert harness.start_calls == []


class TestRunServiceLoopUpgradeRestart:
    """The in-process auto-updater asks the runtime to exit non-zero on
    success so the SCM's failure-actions config restarts the service
    into the new wheel. Lock that contract in here."""

    def test_upgrade_restart_event_causes_systemexit_one(self, harness: _LoopHarness) -> None:
        # Simulate the heartbeat-thread Updater finishing a successful
        # upgrade by pre-setting both events. The loop should bail out
        # of the wait, run stop_runtime, then raise SystemExit(1) so the
        # SCM treats this as a failure and applies its restart policy.
        harness.runtime.shutdown_event.set()
        harness.runtime.upgrade_restart_event.set()
        stop_event = threading.Event()  # NOT pre-set

        with pytest.raises(SystemExit) as excinfo:
            harness.svc._run_service_loop(stop_event, harness.sm)

        assert excinfo.value.code == 1
        # Cleanup must still run before the non-zero exit so the heartbeat
        # thread, file monitor, etc. have a chance to flush their state.
        assert len(harness.stop_calls) == 1
        # The WATCHER_STOPPED event must distinguish an upgrade restart
        # from a normal stop, otherwise the dashboard can't correlate it
        # with the preceding update_started event. The message is
        # produced by `classify_shutdown` and shared with the CLI watch
        # path so the two entrypoints can't drift.
        assert harness.stop_calls[0][1] == "Service restarting for auto-update"
        # And the operator-facing log line must distinguish this from a
        # normal stop so the Windows event log shows what happened.
        log_messages = [c.args[0] for c in harness.sm.LogInfoMsg.call_args_list]
        assert any("upgraded" in m.lower() for m in log_messages)


class TestRunServiceLoopChecksumSync:
    def test_checksum_api_error_is_a_warning_not_a_fatal(self, harness: _LoopHarness) -> None:
        # If the API is reachable enough to answer get_instrument but
        # the checksum endpoint blips, the service must still come up.
        # This is an explicit design choice: don't punish operators for
        # transient sync failures, the next heartbeat will retry.
        # The failure now surfaces as a kind=config_sync_failed event
        # on the runtime's reporter rather than only as a Windows event
        # log warning, so the dashboard can flag stale configs across
        # the fleet.
        harness.client.get_config_checksum.side_effect = ApiError("transient 500", status_code=500)

        stop_event = threading.Event()
        stop_event.set()
        harness.svc._run_service_loop(stop_event, harness.sm)

        # Service still came up.
        assert len(harness.start_calls) == 1
        harness.sm.LogErrorMsg.assert_not_called()
        # And the structured event was queued so the failure is
        # visible centrally.
        report_error_calls = harness.runtime.reporter.report_error.call_args_list
        kinds = [c.args[0] for c in report_error_calls]
        assert "config_sync_failed" in kinds

    def test_matching_checksum_skips_push(self, harness: _LoopHarness) -> None:
        # When the remote checksum already matches, push_config must
        # NOT be called -- otherwise every reboot would no-op rewrite
        # the config and flood the audit log.
        from data_hub_watcher.models import ConfigChecksumResponse

        harness.client.get_config_checksum.return_value = ConfigChecksumResponse(
            config_checksum="deadbeef"
        )

        stop_event = threading.Event()
        stop_event.set()
        harness.svc._run_service_loop(stop_event, harness.sm)

        harness.client.push_config.assert_not_called()
        assert len(harness.start_calls) == 1
