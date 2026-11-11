"""What the service driver asks of Windows, and how it reads the answers.

The Windows service suite starts the real service and looks at the machine around it: the
Service Control Manager (``sc.exe``), the registry (``reg.exe``), Task Scheduler
(``schtasks.exe``) and the Event Log (PowerShell). Everything here goes through one
:class:`Runner`, a function that runs a command and returns its output, so that the commands
the driver builds and the parsing of what ``sc`` and friends print are tested on any platform
with a fake runner (``watcher/tests/test_e2e_service_driver.py``). Only :func:`run_command`,
the default runner, touches the machine.

Nothing here imports ``win32api`` or ``winreg``: the commands are the ones an operator types,
and their output is read with regular expressions that name the numeric codes (``STATE : 4``)
rather than the localised words, where Windows prints both.
"""

from __future__ import annotations
import base64
import re
import subprocess
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from enum import IntEnum
from typing import Protocol

from data_hub_watcher.constants import SERVICE_NAME
from data_hub_watcher.scheduled_task import UPGRADE_TASK_NAME

__all__ = [
    "ERROR_SERVICE_DOES_NOT_EXIST",
    "ERROR_SERVICE_NEVER_STARTED",
    "ERROR_SERVICE_SPECIFIC_ERROR",
    "REG_CONFIG_PATH",
    "REG_ENV_PATH",
    "SERVICE_DISPLAY_NAME",
    "SERVICE_NAME",
    "SERVICE_REGISTRY_KEY",
    "UPGRADE_TASK_NAME",
    "CommandResult",
    "EventLogEntry",
    "FailureActions",
    "Runner",
    "ScError",
    "ServiceConfig",
    "ServiceState",
    "ServiceStatus",
    "WindowsHost",
    "event_log_script",
    "format_event_entries",
    "parse_event_log",
    "parse_registry_values",
    "parse_sc_failure",
    "parse_sc_failure_flag",
    "parse_sc_qc",
    "parse_sc_queryex",
    "parse_schtasks_list",
    "powershell_command",
    "run_command",
]

# Win32 system error codes the SCM reports, and that `sc.exe` returns as its exit code.
ERROR_SERVICE_DOES_NOT_EXIST = 1060
ERROR_SERVICE_NOT_ACTIVE = 1062
ERROR_SERVICE_SPECIFIC_ERROR = 1066
ERROR_SERVICE_NEVER_STARTED = 1077

# What the service calls itself in its log (`SERVICE_DISPLAY_NAME` in `service.py`). The module
# is not imported: on Windows it imports pywin32, which the suite's own environment doesn't
# need. A unit test keeps this in step with the source.
SERVICE_DISPLAY_NAME = "Data Hub Watcher"

# The values `service install` writes under the service's registry key (see `service.py`).
SERVICE_REGISTRY_KEY = rf"HKLM\SYSTEM\CurrentControlSet\Services\{SERVICE_NAME}"
REG_CONFIG_PATH = "ConfigPath"
REG_ENV_PATH = "EnvPath"

_DEFAULT_TIMEOUT_SECONDS = 60.0


# ---------------------------------------------------------------------------
# Running commands
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CommandResult:
    """The outcome of one command."""

    returncode: int
    stdout: str = ""
    stderr: str = ""

    @property
    def output(self) -> str:
        return self.stdout + self.stderr


class Runner(Protocol):
    """Runs a command to its end. The default is :func:`run_command`; a test passes a fake."""

    def __call__(
        self, argv: Sequence[str], timeout: float = ..., *, encoding: str | None = ...
    ) -> CommandResult: ...


def run_command(
    argv: Sequence[str], timeout: float = _DEFAULT_TIMEOUT_SECONDS, *, encoding: str | None = None
) -> CommandResult:
    """Run ``argv`` and capture its output. The output is decoded with ``encoding`` (the
    system's, by default) and never fails to decode: ``sc`` and ``reg`` print in the console's
    code page."""
    completed = subprocess.run(
        list(argv), capture_output=True, timeout=timeout, check=False, stdin=subprocess.DEVNULL
    )

    def decode(data: bytes) -> str:
        return data.decode(encoding or "utf-8", errors="replace")

    return CommandResult(completed.returncode, decode(completed.stdout), decode(completed.stderr))


# ---------------------------------------------------------------------------
# `sc queryex`: the state of the service
# ---------------------------------------------------------------------------


class ServiceState(IntEnum):
    """The ``dwCurrentState`` values the SCM reports. ``sc`` prints the number first."""

    STOPPED = 1
    START_PENDING = 2
    STOP_PENDING = 3
    RUNNING = 4
    CONTINUE_PENDING = 5
    PAUSE_PENDING = 6
    PAUSED = 7


@dataclass(frozen=True)
class ServiceStatus:
    """What ``sc queryex`` says about the service."""

    state: ServiceState
    pid: int | None
    win32_exit_code: int
    service_exit_code: int

    @property
    def exit_code(self) -> int | None:
        """How the last run ended: 0 after a clean stop, and for a failure the win32 code (for
        example 1067 for a killed process), or the service's own code where the win32 code says
        ``ERROR_SERVICE_SPECIFIC_ERROR``, which is how a service reports ``SystemExit(1)``.
        ``None`` when the service has never run."""
        if self.win32_exit_code == ERROR_SERVICE_NEVER_STARTED:
            return None
        if self.win32_exit_code == ERROR_SERVICE_SPECIFIC_ERROR:
            return self.service_exit_code
        return self.win32_exit_code


class ScError(RuntimeError):
    """An ``sc.exe`` (or other) command failed in a way the caller did not expect."""

    def __init__(self, argv: Sequence[str], result: CommandResult) -> None:
        self.argv = tuple(argv)
        self.result = result
        super().__init__(
            f"`{' '.join(argv)}` failed (exit {result.returncode}):\n{result.output.strip()}"
        )


_STATE = re.compile(r"^\s*STATE\s*:\s*(\d+)", re.MULTILINE)
_WIN32_EXIT = re.compile(r"^\s*WIN32_EXIT_CODE\s*:\s*(\d+)", re.MULTILINE)
_SERVICE_EXIT = re.compile(r"^\s*SERVICE_EXIT_CODE\s*:\s*(\d+)", re.MULTILINE)
_PID = re.compile(r"^\s*PID\s*:\s*(\d+)", re.MULTILINE)
_SC_FAILED = re.compile(r"FAILED\s+(\d+)")


def _sc_error_code(result: CommandResult) -> int | None:
    """The Win32 error an ``sc`` command reports (``[SC] ... FAILED 1060:``), if it failed."""
    found = _SC_FAILED.search(result.output)
    if found:
        return int(found.group(1))
    return result.returncode if result.returncode else None


def parse_sc_queryex(result: CommandResult) -> ServiceStatus | None:
    """The status in the output of ``sc queryex <service>``, or ``None`` when the service is
    not installed (error 1060). Any other failure raises :class:`ScError`."""
    code = _sc_error_code(result)
    if code == ERROR_SERVICE_DOES_NOT_EXIST:
        return None
    state = _STATE.search(result.stdout)
    if state is None:
        raise ScError(["sc.exe", "queryex", SERVICE_NAME], result)
    win32 = _WIN32_EXIT.search(result.stdout)
    specific = _SERVICE_EXIT.search(result.stdout)
    pid_match = _PID.search(result.stdout)
    pid = int(pid_match.group(1)) if pid_match else 0
    return ServiceStatus(
        state=ServiceState(int(state.group(1))),
        pid=pid or None,
        win32_exit_code=int(win32.group(1)) if win32 else 0,
        service_exit_code=int(specific.group(1)) if specific else 0,
    )


# ---------------------------------------------------------------------------
# `sc qc`, `sc qfailure`, `sc qfailureflag`: how the service is configured
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ServiceConfig:
    """What ``sc qc <service>`` says about how the service is registered."""

    start_type: str  # AUTO_START, DEMAND_START, ...
    delayed_start: bool
    binary_path: str
    display_name: str
    dependencies: tuple[str, ...]
    start_name: str  # The account: LocalSystem


_SC_FIELD = re.compile(r"^\s+([A-Z0-9_]+)\s*:\s*(.*?)\s*$")
_SC_CONTINUATION = re.compile(r"^\s+:\s*(\S.*?)\s*$")


def parse_sc_qc(text: str) -> ServiceConfig:
    """Read the output of ``sc qc <service>``.

    ``START_TYPE`` reads ``2   AUTO_START  (DELAYED)`` for a delayed automatic start, and the
    dependencies are listed one per line, the first after ``DEPENDENCIES :`` and the others
    after a bare ``:``.
    """
    fields: dict[str, str] = {}
    dependencies: list[str] = []
    in_dependencies = False
    for line in text.splitlines():
        continuation = _SC_CONTINUATION.match(line)
        if continuation and in_dependencies:
            dependencies.append(continuation.group(1))
            continue
        field = _SC_FIELD.match(line)
        in_dependencies = False
        if field is None:
            continue
        name, value = field.groups()
        if name == "DEPENDENCIES":
            in_dependencies = True
            if value:
                dependencies.append(value)
        else:
            fields.setdefault(name, value)
    start = fields.get("START_TYPE", "")
    type_name = re.search(r"[A-Z_]{4,}", start)
    return ServiceConfig(
        start_type=type_name.group(0) if type_name else start,
        delayed_start="(DELAYED)" in start.upper(),
        binary_path=fields.get("BINARY_PATH_NAME", ""),
        display_name=fields.get("DISPLAY_NAME", ""),
        dependencies=tuple(dependencies),
        start_name=fields.get("SERVICE_START_NAME", ""),
    )


@dataclass(frozen=True)
class FailureActions:
    """The service's recovery settings (``sc qfailure`` and ``sc qfailureflag``).

    ``restart_delays_ms`` are the delays of the restart actions in order. ``other_actions``
    lists anything else the service would do on a failure (``RUN PROCESS`` or ``REBOOT``),
    which the product never sets.
    """

    reset_period_seconds: int | None
    restart_delays_ms: tuple[int, ...]
    other_actions: tuple[str, ...]
    on_noncrash_failures: bool | None = None


_RESET_PERIOD = re.compile(r"RESET_PERIOD[^:]*:\s*(\d+|INFINITE)", re.IGNORECASE)
_FAILURE_ACTION = re.compile(
    r"(RESTART|RUN PROCESS|REBOOT)\s*--\s*Delay\s*=\s*(\d+)", re.IGNORECASE
)
_NONCRASH = re.compile(r"NONCRASH_FAILURES\s*:\s*(TRUE|FALSE|1|0)", re.IGNORECASE)


def parse_sc_failure(text: str, *, on_noncrash_failures: bool | None = None) -> FailureActions:
    """Read the output of ``sc qfailure <service>``: the reset period and each action with its
    delay (``RESTART -- Delay = 60000 milliseconds.``). A "no action" entry prints nothing that
    matters, so what is returned is the actions the SCM would take."""
    reset = _RESET_PERIOD.search(text)
    restarts: list[int] = []
    others: list[str] = []
    for kind, delay in _FAILURE_ACTION.findall(text):
        if kind.upper() == "RESTART":
            restarts.append(int(delay))
        else:
            others.append(f"{kind.upper()} after {delay} ms")
    reset_seconds = None
    if reset is not None and reset.group(1).isdigit():
        reset_seconds = int(reset.group(1))
    return FailureActions(
        reset_period_seconds=reset_seconds,
        restart_delays_ms=tuple(restarts),
        other_actions=tuple(others),
        on_noncrash_failures=on_noncrash_failures,
    )


def parse_sc_failure_flag(text: str) -> bool | None:
    """Whether recovery also runs when the service stops with a non-zero exit code and did
    not crash (``sc qfailureflag``). ``None`` if the output doesn't say."""
    found = _NONCRASH.search(text)
    if found is None:
        return None
    return found.group(1).upper() in ("TRUE", "1")


# ---------------------------------------------------------------------------
# `reg query` and `schtasks /Query`
# ---------------------------------------------------------------------------

_REG_VALUE = re.compile(r"^\s{4}(.+?)\s{4}(REG_[A-Z_]+)(?:\s{4}(.*))?$")


def parse_registry_values(text: str) -> dict[str, str]:
    """The values directly under the key in the output of ``reg query <key>``, by name. Values
    of the subkeys that ``reg`` lists after them are left out."""
    values: dict[str, str] = {}
    in_key = False
    for line in text.splitlines():
        if line.startswith("HKEY_"):
            if in_key:
                break  # The first key is the one asked about; the rest are subkeys.
            in_key = True
            continue
        found = _REG_VALUE.match(line) if in_key else None
        if found:
            values[found.group(1)] = (found.group(3) or "").strip()
    return values


_SCHTASKS_FIELD = re.compile(r"^([A-Za-z][A-Za-z ]*?):\s+(.*?)\s*$")


def parse_schtasks_list(text: str) -> dict[str, str]:
    """The fields of ``schtasks /Query /TN <task> /V /FO LIST`` (``Task To Run``,
    ``Run As User``, ``Status`` ...). The first value of a repeated field wins."""
    fields: dict[str, str] = {}
    for line in text.splitlines():
        found = _SCHTASKS_FIELD.match(line)
        if found:
            fields.setdefault(found.group(1).strip(), found.group(2))
    return fields


# ---------------------------------------------------------------------------
# The Event Log, through PowerShell
# ---------------------------------------------------------------------------

POWERSHELL = "powershell.exe"

# Which Application log entries belong to the service: the ones the troubleshooting guide
# tells an operator to look for (`docs/site/content/docs/troubleshoot-a-watcher.mdx`).
_EVENT_SCRIPT = r"""
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$start = [DateTimeOffset]::FromUnixTimeSeconds(__SINCE__).LocalDateTime
$mine = 'DataHubWatcher|Data Hub Watcher'
$application = @{ LogName = 'Application'; StartTime = $start }
$system = @{ LogName = 'System'; ProviderName = 'Service Control Manager'; StartTime = $start }
$found = @()
$found += Get-WinEvent -FilterHashtable $application |
  Where-Object { $_.ProviderName -match 'Python|DataHubWatcher' -or $_.Message -match $mine }
if (__SYSTEM__) {
  $found += Get-WinEvent -FilterHashtable $system |
    Where-Object { $_.Message -match $mine }
}
foreach ($e in ($found | Sort-Object TimeCreated)) {
  $text = $e.Message
  if (-not $text) { $text = ($e.Properties | ForEach-Object { $_.Value }) -join ' ' }
  $when = $e.TimeCreated.ToUniversalTime().ToString('o')
  "### $($e.RecordId) $when $($e.LogName) id=$($e.Id) $($e.ProviderName)"
  $text
}
"""


def event_log_script(since_epoch: float, *, include_system: bool = True) -> str:
    """The PowerShell script that lists the service's Event Log entries since a time: the
    Application log's, and with ``include_system`` the Service Control Manager's in the System
    log."""
    return _EVENT_SCRIPT.replace("__SINCE__", str(int(since_epoch))).replace(
        "__SYSTEM__", "$true" if include_system else "$false"
    )


def powershell_command(script: str) -> list[str]:
    """``powershell.exe`` arguments that run ``script`` without any quoting to get wrong."""
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    return [
        POWERSHELL,
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encoded,
    ]


@dataclass(frozen=True)
class EventLogEntry:
    """One Event Log entry about the service."""

    record_id: int
    time: str  # ISO 8601, UTC
    log: str  # Application or System
    event_id: int
    provider: str
    message: str


_EVENT_HEADER = re.compile(r"^### (\d+) (\S+) (\S+) id=(\d+) ?(.*)$")


def parse_event_log(text: str) -> list[EventLogEntry]:
    """Read what :func:`event_log_script` prints: a ``### `` line per entry, then its text."""
    entries: list[EventLogEntry] = []
    header: re.Match[str] | None = None
    body: list[str] = []

    def finish() -> None:
        if header is not None:
            record, stamp, log, event_id, provider = header.groups()
            entries.append(
                EventLogEntry(
                    int(record), stamp, log, int(event_id), provider, "\n".join(body).strip()
                )
            )

    for line in text.splitlines():
        found = _EVENT_HEADER.match(line)
        if found:
            finish()
            header, body = found, []
        elif header is not None:
            body.append(line)
    finish()
    return entries


def format_event_entries(entries: Sequence[EventLogEntry]) -> str:
    """Event Log entries as text for a file: one header line each, then the message."""
    parts = [
        f"{e.time} [{e.log}] {e.provider} (id {e.event_id}, record {e.record_id})\n{e.message}\n"
        for e in entries
    ]
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# The machine
# ---------------------------------------------------------------------------


class WindowsHost:
    """The commands a Windows service test runs, over a :class:`Runner`.

    Every method is one command (or one command and its parsing), so a test with a fake runner
    sees exactly what the driver would run. ``service`` and ``task`` default to the product's
    names.
    """

    def __init__(
        self,
        runner: Callable[..., CommandResult] | None = None,
        *,
        service: str = SERVICE_NAME,
        task: str = UPGRADE_TASK_NAME,
    ) -> None:
        self._run: Callable[..., CommandResult] = runner or run_command
        self.service = service
        self.task = task

    @property
    def registry_key(self) -> str:
        return rf"HKLM\SYSTEM\CurrentControlSet\Services\{self.service}"

    # -- the SCM -------------------------------------------------------------

    def status(self) -> ServiceStatus | None:
        """The service's state, pid and exit code; ``None`` if it is not installed."""
        return parse_sc_queryex(self._run(["sc.exe", "queryex", self.service]))

    def config(self) -> ServiceConfig | None:
        """How the service is registered (``sc qc``); ``None`` if it is not installed."""
        result = self._run(["sc.exe", "qc", self.service])
        if _sc_error_code(result) == ERROR_SERVICE_DOES_NOT_EXIST:
            return None
        if result.returncode != 0:
            raise ScError(["sc.exe", "qc", self.service], result)
        return parse_sc_qc(result.stdout)

    def failure_actions(self) -> FailureActions:
        """The recovery actions and the non-crash flag (``sc qfailure`` and ``sc qfailureflag``)."""
        actions = self._run(["sc.exe", "qfailure", self.service])
        if actions.returncode != 0:
            raise ScError(["sc.exe", "qfailure", self.service], actions)
        flag = self._run(["sc.exe", "qfailureflag", self.service])
        if flag.returncode != 0:
            raise ScError(["sc.exe", "qfailureflag", self.service], flag)
        return parse_sc_failure(
            actions.stdout, on_noncrash_failures=parse_sc_failure_flag(flag.stdout)
        )

    def disable_failure_actions(self) -> None:
        """Take every recovery action away (``sc failure <service> reset= 0 actions= ""``), so a
        killed or refused service stays down, as a ``watch`` process does."""
        self._must(["sc.exe", "failure", self.service, "reset=", "0", "actions=", ""])

    def set_restart_actions(
        self, delays_ms: Sequence[int], *, reset_seconds: int = 86400, noncrash: bool = True
    ) -> None:
        """Restart after each of ``delays_ms`` on the first failures, and treat a non-zero exit
        as a failure too (``noncrash``), as the product does with its own 60 s and 120 s."""
        actions = "/".join(f"restart/{delay}" for delay in delays_ms)
        self._must(
            ["sc.exe", "failure", self.service, "reset=", str(reset_seconds), "actions=", actions]
        )
        self._must(["sc.exe", "failureflag", self.service, "1" if noncrash else "0"])

    def stop(self) -> None:
        """Ask the service to stop (``sc stop``), without waiting. A service that is not running
        is not an error."""
        result = self._run(["sc.exe", "stop", self.service])
        if result.returncode not in (0, ERROR_SERVICE_NOT_ACTIVE, ERROR_SERVICE_DOES_NOT_EXIST):
            raise ScError(["sc.exe", "stop", self.service], result)

    def delete(self) -> None:
        """Mark the service for deletion (``sc delete``), for a ``service uninstall`` that
        failed. A service that is already gone is not an error."""
        result = self._run(["sc.exe", "delete", self.service])
        if result.returncode not in (0, ERROR_SERVICE_DOES_NOT_EXIST):
            raise ScError(["sc.exe", "delete", self.service], result)

    def kill_tree(self, pid: int) -> None:
        """End the service's process and what it started (``taskkill /F /T /PID``). It is what
        a crash is to the SCM. ``/T`` because the interpreter of a virtual environment is a
        launcher that starts the real one: killing only the launcher would leave the watcher
        running with nobody to stop it."""
        result = self._run(["taskkill.exe", "/F", "/T", "/PID", str(pid)])
        # 128 means there is no such process: it went away on its own.
        if result.returncode not in (0, 128):
            raise ScError(["taskkill.exe", "/F", "/T", "/PID", str(pid)], result)

    # -- the registry -----------------------------------------------------------

    def registry_values(self) -> dict[str, str]:
        """The values under the service's registry key, by name (empty if there is no key)."""
        result = self._run(["reg.exe", "query", self.registry_key])
        if result.returncode != 0:
            return {}
        return parse_registry_values(result.stdout)

    def set_registry_value(self, name: str, value: str) -> None:
        """Write a string value under the service's registry key."""
        self._must(
            ["reg.exe", "add", self.registry_key, "/v", name, "/t", "REG_SZ", "/d", value, "/f"]
        )

    def delete_registry_value(self, name: str) -> None:
        """Delete one value under the service's registry key."""
        self._must(["reg.exe", "delete", self.registry_key, "/v", name, "/f"])

    def set_environment(self, variables: Mapping[str, str]) -> None:
        """Give the service process these environment variables, through the ``Environment``
        multi-string value the SCM reads under the service key. ``PYTHONPATH`` is how a test
        makes the interpreter of a service start something else first."""
        data = r"\0".join(f"{name}={value}" for name, value in variables.items())
        self._must(
            [
                "reg.exe",
                "add",
                self.registry_key,
                "/v",
                "Environment",
                "/t",
                "REG_MULTI_SZ",
                "/d",
                data,
                "/f",
            ]
        )

    # -- the upgrade worker's scheduled task -------------------------------------

    def task_exists(self) -> bool:
        return self._run(["schtasks.exe", "/Query", "/TN", self.task]).returncode == 0

    def task_details(self) -> dict[str, str]:
        """The fields of the task (``Task To Run``, ``Run As User`` ...); empty if absent."""
        result = self._run(["schtasks.exe", "/Query", "/TN", self.task, "/V", "/FO", "LIST"])
        return parse_schtasks_list(result.stdout) if result.returncode == 0 else {}

    def delete_task(self) -> None:
        """Delete the task, ending a run of it first. A task that is not there is not an error."""
        self._run(["schtasks.exe", "/End", "/TN", self.task])
        result = self._run(["schtasks.exe", "/Delete", "/TN", self.task, "/F"])
        if result.returncode != 0 and self.task_exists():
            raise ScError(["schtasks.exe", "/Delete", "/TN", self.task, "/F"], result)

    # -- the Event Log -------------------------------------------------------------

    def event_log(self, since_epoch: float, *, include_system: bool = True) -> list[EventLogEntry]:
        """The service's entries in the Application log (and with ``include_system`` the SCM's
        in the System log) since a time."""
        result = self._run(
            powershell_command(event_log_script(since_epoch, include_system=include_system)),
            120.0,
            encoding="utf-8",
        )
        if result.returncode != 0:
            raise ScError([POWERSHELL, "(event log)"], result)
        return parse_event_log(result.stdout)

    # -- helpers -----------------------------------------------------------------

    def _must(self, argv: Sequence[str]) -> CommandResult:
        result = self._run(argv)
        if result.returncode != 0:
            raise ScError(argv, result)
        return result
