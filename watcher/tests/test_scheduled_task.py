"""Unit tests for `data_hub_watcher.scheduled_task`.

The wrappers live behind ``schtasks.exe`` so we mock ``subprocess.run``
and assert on the argv we pass — the goal is to lock in the install
flags (``/RU SYSTEM``, ``/RL HIGHEST``, ``/F``, etc.) and the
"task already absent" tolerance for ``/Delete`` so a regression here
shows up as a clear test failure rather than as a stuck or
double-registered task on a real lab PC.
"""

from __future__ import annotations
import subprocess
from pathlib import Path
from typing import Any

import pytest

from data_hub_watcher import scheduled_task as st
from data_hub_watcher.scheduled_task import (
    UPGRADE_TASK_NAME,
    ScheduledTaskError,
    install_upgrade_task,
    task_exists,
    trigger_upgrade_task,
    uninstall_upgrade_task,
)


def _completed(
    *,
    returncode: int = 0,
    stdout: str = "",
    stderr: str = "",
) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(
        args=["schtasks.exe"], returncode=returncode, stdout=stdout, stderr=stderr
    )


# ---------------------------------------------------------------------------
# install_upgrade_task
# ---------------------------------------------------------------------------


class TestInstallUpgradeTask:
    def test_passes_critical_flags(self, monkeypatch: pytest.MonkeyPatch) -> None:
        captured: dict[str, Any] = {}

        def fake_run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
            captured["cmd"] = cmd
            return _completed(returncode=0)

        monkeypatch.setattr(st.subprocess, "run", fake_run)

        install_upgrade_task(Path(r"C:\data-hub\upgrade-worker.ps1"))

        cmd = captured["cmd"]
        assert cmd[0] == "schtasks.exe"
        assert "/Create" in cmd
        # Task name must match the module constant — that's what
        # `trigger_upgrade_task` and the docs all assume.
        assert cmd[cmd.index("/TN") + 1] == UPGRADE_TASK_NAME
        # Run as SYSTEM so the worker can stop/start the service.
        assert cmd[cmd.index("/RU") + 1] == "SYSTEM"
        # Highest privileges so a future move to a less-privileged
        # principal can't silently demote us.
        assert cmd[cmd.index("/RL") + 1] == "HIGHEST"
        # /F overwrites an existing task with the same name so a
        # `service reinstall` is idempotent.
        assert "/F" in cmd
        # The action must reference the script path verbatim so a
        # post-install relocation of the script breaks loudly rather
        # than silently running stale code.
        action = cmd[cmd.index("/TR") + 1]
        assert r"C:\data-hub\upgrade-worker.ps1" in action
        assert "powershell.exe" in action.lower()
        assert "-ExecutionPolicy Bypass" in action
        assert "-NoProfile" in action

    def test_raises_with_diagnostic_payload_on_schtasks_failure(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # When `schtasks /Create` fails (e.g. the operator ran
        # `service install` from a non-Administrator shell), the
        # caller needs the captured stderr + returncode to attach to
        # the dashboard event. Lock in the typed-error contract.
        monkeypatch.setattr(
            st.subprocess,
            "run",
            lambda cmd, **kw: _completed(returncode=1, stderr="ERROR: Access is denied."),
        )

        with pytest.raises(ScheduledTaskError) as excinfo:
            install_upgrade_task(Path(r"C:\data-hub\upgrade-worker.ps1"))

        assert "schtasks /Create failed" in str(excinfo.value)
        assert excinfo.value.returncode == 1
        assert "Access is denied" in excinfo.value.stderr

    def test_raises_when_schtasks_not_on_path(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def boom(cmd: list[str], **kwargs: Any) -> Any:
            raise FileNotFoundError("schtasks.exe")

        monkeypatch.setattr(st.subprocess, "run", boom)
        with pytest.raises(ScheduledTaskError, match="not found"):
            install_upgrade_task(Path(r"C:\data-hub\upgrade-worker.ps1"))


# ---------------------------------------------------------------------------
# trigger_upgrade_task
# ---------------------------------------------------------------------------


class TestTriggerUpgradeTask:
    def test_invokes_schtasks_run_with_default_task_name(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        captured: dict[str, Any] = {}

        def fake_run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
            captured["cmd"] = cmd
            return _completed(returncode=0)

        monkeypatch.setattr(st.subprocess, "run", fake_run)
        trigger_upgrade_task()

        assert captured["cmd"][0] == "schtasks.exe"
        assert captured["cmd"][1] == "/Run"
        assert captured["cmd"][captured["cmd"].index("/TN") + 1] == UPGRADE_TASK_NAME

    def test_raises_on_failure_with_stderr_payload(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Most common failure mode: the task isn't registered (because
        # an old fleet PC auto-updated into the new code without
        # running `service install`). The error must include the
        # captured stderr so the dashboard event reads usefully.
        monkeypatch.setattr(
            st.subprocess,
            "run",
            lambda cmd, **kw: _completed(
                returncode=1,
                stderr="ERROR: The system cannot find the file specified.",
            ),
        )
        with pytest.raises(ScheduledTaskError) as excinfo:
            trigger_upgrade_task()
        assert "schtasks /Run failed" in str(excinfo.value)
        assert "cannot find" in excinfo.value.stderr.lower()


# ---------------------------------------------------------------------------
# uninstall_upgrade_task
# ---------------------------------------------------------------------------


class TestUninstallUpgradeTask:
    def test_returns_quietly_on_success(self, monkeypatch: pytest.MonkeyPatch) -> None:
        captured: dict[str, Any] = {}

        def fake_run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
            captured["cmd"] = cmd
            return _completed(returncode=0)

        monkeypatch.setattr(st.subprocess, "run", fake_run)
        uninstall_upgrade_task()
        assert "/Delete" in captured["cmd"]
        assert "/F" in captured["cmd"]

    def test_silently_ignores_missing_task(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # A half-installed or already-uninstalled host must not block
        # `service uninstall`. The error message variant we observe in
        # practice is 'ERROR: The system cannot find the file specified'.
        monkeypatch.setattr(
            st.subprocess,
            "run",
            lambda cmd, **kw: _completed(
                returncode=1,
                stderr="ERROR: The system cannot find the file specified.",
            ),
        )
        # Must NOT raise.
        uninstall_upgrade_task()

    def test_silently_ignores_does_not_exist_phrasing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Some Windows variants return a slightly different phrasing.
        # Both should be classified as "already absent".
        monkeypatch.setattr(
            st.subprocess,
            "run",
            lambda cmd, **kw: _completed(
                returncode=1,
                stderr="ERROR: The specified task name does not exist.",
            ),
        )
        uninstall_upgrade_task()

    def test_raises_for_unknown_failures(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # An access-denied / RPC error etc. must surface as a clear
        # error so an operator knows why a `service uninstall` left
        # the host in an unclean state.
        monkeypatch.setattr(
            st.subprocess,
            "run",
            lambda cmd, **kw: _completed(
                returncode=1,
                stderr="ERROR: Access is denied.",
            ),
        )
        with pytest.raises(ScheduledTaskError, match="Delete"):
            uninstall_upgrade_task()


# ---------------------------------------------------------------------------
# task_exists
# ---------------------------------------------------------------------------


class TestTaskExists:
    def test_returns_true_when_query_succeeds(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            st.subprocess,
            "run",
            lambda cmd, **kw: _completed(returncode=0, stdout="task info..."),
        )
        assert task_exists() is True

    def test_returns_false_when_query_fails(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            st.subprocess,
            "run",
            lambda cmd, **kw: _completed(
                returncode=1,
                stderr="ERROR: The system cannot find the file specified.",
            ),
        )
        assert task_exists() is False

    def test_propagates_subprocess_unavailable(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # If schtasks.exe itself can't be invoked, callers (the
        # service startup path) need to know — silently returning
        # False would mask a much bigger problem with the host.
        def boom(cmd: list[str], **kwargs: Any) -> Any:
            raise FileNotFoundError("schtasks.exe")

        monkeypatch.setattr(st.subprocess, "run", boom)
        with pytest.raises(ScheduledTaskError):
            task_exists()
