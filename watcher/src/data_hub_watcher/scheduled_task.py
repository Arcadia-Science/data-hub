"""Thin wrapper over Windows Task Scheduler (``schtasks.exe``).

Used by the out-of-process upgrade worker (see
:mod:`data_hub_watcher.upgrade_worker`) to register a SYSTEM-owned,
on-demand-only task whose action is the worker PowerShell script. We
shell out to ``schtasks.exe`` rather than using the ``taskschd`` COM
API (via pywin32) for two reasons:

1. ``schtasks.exe`` ships with every supported Windows version and
   has stable behaviour going back to Windows XP. The COM API is
   richer but its idempotency story (in particular, replacing an
   existing task) is finicky and version-sensitive.
2. We already pull in pywin32 only when the ``[windows-service]``
   extra is installed; gating an unrelated COM dependency on the
   same extra would be confusing, while ``subprocess`` works
   regardless of how the watcher was installed.

All public functions are import-safe on every platform — they only
touch ``schtasks.exe`` at call time, so the module can be imported
from cross-platform code paths (e.g. the ``Updater``) and gated on
``sys.platform == "win32"`` at the call sites.
"""

from __future__ import annotations
import logging
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)


# Default task name. Centralised so the install / trigger / uninstall
# helpers can't drift, and so the dashboard can include it verbatim in
# the "stuck task" troubleshooting entry.
UPGRADE_TASK_NAME = "DataHubWatcherUpgrade"

# How long to wait for ``schtasks.exe`` to respond before giving up.
# Local SCM operations are fast (sub-second) but a heavily loaded
# system or a hung Task Scheduler service could in principle wedge,
# and we'd rather surface a clear timeout to the operator than block
# the heartbeat thread indefinitely.
_SCHTASKS_TIMEOUT_SECONDS = 30.0


class ScheduledTaskError(RuntimeError):
    """Raised when ``schtasks.exe`` fails or is unavailable.

    Carries the underlying argv and captured stderr so the caller can
    attach both to a dashboard event without having to log them
    separately. The message is kept short and actionable so it reads
    well as a single-line ``UPDATE_FAILED.reason``.
    """

    def __init__(
        self,
        message: str,
        *,
        argv: list[str] | None = None,
        stderr: str = "",
        returncode: int | None = None,
    ) -> None:
        super().__init__(message)
        self.argv = list(argv) if argv else []
        self.stderr = stderr
        self.returncode = returncode


def _run_schtasks(args: list[str]) -> subprocess.CompletedProcess[str]:
    """Invoke ``schtasks.exe`` with *args*; raise on argv-level failures only.

    Returns the :class:`subprocess.CompletedProcess` so callers can
    inspect ``returncode`` themselves — different ``schtasks`` verbs
    have different "this is fine" exit codes (notably ``/Query`` and
    ``/Delete`` both return 1 for "task does not exist") and bundling
    that classification here would force every caller to second-guess
    us. We only raise for the cases where ``schtasks`` itself couldn't
    even be invoked.
    """
    cmd = ["schtasks.exe", *args]
    try:
        return subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=False,
            timeout=_SCHTASKS_TIMEOUT_SECONDS,
        )
    except FileNotFoundError as exc:
        # Vanishingly rare on a real Windows host but worth a typed
        # error since the diagnosis is unambiguous: PATH is wrong or
        # the host is missing system32.
        raise ScheduledTaskError(
            "schtasks.exe not found on PATH",
            argv=cmd,
            stderr=str(exc),
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise ScheduledTaskError(
            f"schtasks.exe timed out after {_SCHTASKS_TIMEOUT_SECONDS:.0f}s",
            argv=cmd,
            stderr=(exc.stderr.decode("utf-8", errors="replace") if exc.stderr else ""),
        ) from exc


def install_upgrade_task(
    script_path: Path,
    *,
    task_name: str = UPGRADE_TASK_NAME,
) -> None:
    """Register the upgrade worker as an on-demand SYSTEM-owned task.

    Idempotent: ``/F`` overwrites an existing task with the same name
    so a ``service reinstall`` (or a future change to the worker
    script) cleanly replaces the previous registration without leaving
    the host with two competing definitions.

    Raises :class:`ScheduledTaskError` when ``schtasks.exe`` itself
    fails — the caller (typically ``install_service``) surfaces this
    to the operator as an actionable error rather than silently
    leaving the host without an upgrade path.

    Notes on the chosen schtasks flags:

    * ``/SC ONCE`` + ``/ST 00:00`` + ``/SD <past-date>``: ``schtasks``
      requires a schedule even for tasks that will only ever be run
      on demand. A one-shot trigger in the past is the documented
      idiom for "this task only ever fires when an explicit
      ``/Run`` invokes it".
    * ``/RU SYSTEM``: the worker needs to ``Stop-Service`` /
      ``Start-Service`` the watcher; SYSTEM is the only built-in
      principal guaranteed to have those rights and to also be able
      to write under ``%UserProfile%\\.data-hub`` regardless of which
      account installed the service.
    * ``/RL HIGHEST``: makes the task run with the highest privileges
      its principal supports. Belt-and-braces for SYSTEM, but means
      a future move to a less-privileged service account (e.g.
      Network Service) won't silently hit a permission ceiling.
    * ``/IT N``: the task is non-interactive, so it doesn't need to
      run while a user is logged on. Fleet lab PCs frequently sit at
      a locked screen with no interactive session for days at a time.
    """
    powershell_path = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
    action = f'"{powershell_path}" -ExecutionPolicy Bypass -NoProfile -File "{script_path}"'

    args = [
        "/Create",
        "/TN",
        task_name,
        "/TR",
        action,
        "/SC",
        "ONCE",
        "/ST",
        "00:00",
        "/SD",
        "01/01/2020",
        "/RU",
        "SYSTEM",
        "/RL",
        "HIGHEST",
        "/F",
    ]
    logger.info(
        "Registering Windows scheduled task %s for upgrade worker %s",
        task_name,
        script_path,
    )
    result = _run_schtasks(args)
    if result.returncode != 0:
        raise ScheduledTaskError(
            f"schtasks /Create failed for {task_name!r}",
            argv=["schtasks.exe", *args],
            stderr=(result.stderr or result.stdout or "").strip(),
            returncode=result.returncode,
        )


def trigger_upgrade_task(*, task_name: str = UPGRADE_TASK_NAME) -> None:
    """Run the upgrade task immediately (asynchronously).

    ``schtasks /Run`` returns as soon as Task Scheduler accepts the
    request — the worker process keeps running independently. This is
    exactly what we want: the watcher's heartbeat thread does not
    block on the upgrade.

    Raises :class:`ScheduledTaskError` when ``schtasks`` fails to even
    accept the request (typically because the task isn't registered).
    """
    args = ["/Run", "/TN", task_name]
    logger.info("Triggering Windows scheduled task %s", task_name)
    result = _run_schtasks(args)
    if result.returncode != 0:
        raise ScheduledTaskError(
            f"schtasks /Run failed for {task_name!r}",
            argv=["schtasks.exe", *args],
            stderr=(result.stderr or result.stdout or "").strip(),
            returncode=result.returncode,
        )


def uninstall_upgrade_task(*, task_name: str = UPGRADE_TASK_NAME) -> None:
    """Remove the upgrade task. Idempotent: missing task is treated as success.

    Used by ``uninstall_service`` and indirectly by ``service
    reinstall``. We deliberately swallow the "task does not exist"
    error code rather than raising, so a half-installed host (e.g. an
    operator who ran ``service install`` before this code shipped) can
    still go through ``service uninstall`` without an extra cleanup
    step.
    """
    args = ["/Delete", "/TN", task_name, "/F"]
    logger.info("Removing Windows scheduled task %s", task_name)
    result = _run_schtasks(args)
    if result.returncode == 0:
        return
    # schtasks /Delete prints "ERROR: The system cannot find the file
    # specified." to stderr (and exits 1) when the task isn't there.
    # That's not an error from our perspective — we just want the
    # task gone.
    combined = f"{result.stdout or ''}\n{result.stderr or ''}".lower()
    if "cannot find" in combined or "does not exist" in combined:
        logger.debug("Scheduled task %s was already absent", task_name)
        return
    raise ScheduledTaskError(
        f"schtasks /Delete failed for {task_name!r}",
        argv=["schtasks.exe", *args],
        stderr=(result.stderr or result.stdout or "").strip(),
        returncode=result.returncode,
    )


def task_exists(*, task_name: str = UPGRADE_TASK_NAME) -> bool:
    """Return whether *task_name* is registered with Task Scheduler.

    Used by the service startup path to lazily reinstall the task on
    fleet PCs that auto-updated into this code without re-running
    ``service install``. A ``False`` return triggers the recovery
    branch; a :class:`ScheduledTaskError` is treated as "we can't
    tell" and surfaces upstream so the failure is at least visible.
    """
    args = ["/Query", "/TN", task_name]
    result = _run_schtasks(args)
    return result.returncode == 0
