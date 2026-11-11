"""Unit tests for the Windows service driver of the end-to-end suite, on any platform.

The driver (``e2e_support.service_driver``) and everything it asks of Windows
(``e2e_support.windows_scm``) are tried against a stand-in for the machine: a ``FakeMachine``
that answers ``sc.exe``, ``reg.exe``, ``schtasks.exe``, ``taskkill`` and PowerShell the way
Windows prints, and a fake ``data-hub-watcher service ...`` that changes the same machine. What
this checks: the commands the driver builds, how it reads what Windows prints, the order of
install and uninstall, the offsets it reads the shared log from, and the layout of the profile
it gives each PC. That the real commands behave like the stand-in is what the Windows run of
the suite shows.
"""

from __future__ import annotations
import base64
import os
import stat
import sys
import textwrap
from collections.abc import Iterator, Sequence
from pathlib import Path

import pytest

from data_hub_watcher.config_io import load_config
from data_hub_watcher.models import InstrumentConfig, RunDetectionConfig, WatcherConfig
from e2e_support import drivers, windows_scm
from e2e_support.drivers import CliResult, ToolInstall
from e2e_support.service_driver import (
    READY_LINE,
    START_LINE,
    WindowsServiceDriver,
)
from e2e_support.waiting import WaitTimeout
from e2e_support.windows_scm import (
    CommandResult,
    ScError,
    ServiceState,
    WindowsHost,
    event_log_script,
    format_event_entries,
    parse_event_log,
    parse_registry_values,
    parse_sc_failure,
    parse_sc_failure_flag,
    parse_sc_qc,
    parse_sc_queryex,
    parse_schtasks_list,
    powershell_command,
)

# ---------------------------------------------------------------------------
# What Windows prints (as `sc`, `reg` and `schtasks` print it)
# ---------------------------------------------------------------------------

QUERYEX_RUNNING = """
SERVICE_NAME: DataHubWatcher
        TYPE               : 10  WIN32_OWN_PROCESS
        STATE              : 4  RUNNING
                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)
        WIN32_EXIT_CODE    : 0  (0x0)
        SERVICE_EXIT_CODE  : 0  (0x0)
        CHECKPOINT         : 0x0
        WAIT_HINT          : 0x0
        PID                : 4132
        FLAGS              :
"""

QUERYEX_STOPPED = """
SERVICE_NAME: DataHubWatcher
        TYPE               : 10  WIN32_OWN_PROCESS
        STATE              : 1  STOPPED
        WIN32_EXIT_CODE    : {win32}  (0x0)
        SERVICE_EXIT_CODE  : {specific}  (0x0)
        CHECKPOINT         : 0x0
        WAIT_HINT          : 0x0
        PID                : 0
        FLAGS              :
"""

SC_NOT_INSTALLED = """[SC] EnumQueryServicesStatus:OpenService FAILED 1060:

The specified service does not exist as an installed service.
"""

SC_QC = """[SC] QueryServiceConfig SUCCESS

SERVICE_NAME: DataHubWatcher
        TYPE               : 10  WIN32_OWN_PROCESS
        START_TYPE         : 2   AUTO_START  (DELAYED)
        ERROR_CONTROL      : 1   NORMAL
        BINARY_PATH_NAME   : "C:\\tools\\uv\\tools\\data-hub-watcher\\Scripts\\python.exe" -m data_hub_watcher.service
        LOAD_ORDER_GROUP   :
        TAG                : 0
        DISPLAY_NAME       : Data Hub Watcher
        DEPENDENCIES       : Tcpip
                           : Dnscache
        SERVICE_START_NAME : LocalSystem
"""  # noqa: E501

SC_QFAILURE = """[SC] QueryServiceConfig2 SUCCESS

SERVICE_NAME: DataHubWatcher
        RESET_PERIOD (in seconds)    : 86400
        REBOOT_MESSAGE               :
        COMMAND_LINE                 :
        FAILURE_ACTIONS              : RESTART -- Delay = 60000 milliseconds.
                                       RESTART -- Delay = 120000 milliseconds.
"""

SC_QFAILUREFLAG = """[SC] QueryServiceConfig2 SUCCESS

SERVICE_NAME: DataHubWatcher
        FAILURE_ACTIONS_ON_NONCRASH_FAILURES: TRUE
"""

REG_QUERY = r"""
HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\DataHubWatcher
    Type    REG_DWORD    0x10
    ImagePath    REG_EXPAND_SZ    "C:\x\python.exe" -m data_hub_watcher.service
    ConfigPath    REG_SZ    C:\Users\runner\.data-hub\config.yaml
    EnvPath    REG_SZ    C:\Users\runner\.data-hub\.env.production

HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\DataHubWatcher\Security
"""

SCHTASKS_LIST = """
Folder: \\
HostName:                             RUNNER
TaskName:                             \\DataHubWatcherUpgrade
Status:                               Ready
Task To Run:                          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -ExecutionPolicy Bypass -NoProfile -File "C:\\u\\upgrade-worker.ps1"
Run As User:                          SYSTEM
"""  # noqa: E501


class TestReadingWhatWindowsPrints:
    def test_a_running_service_has_its_state_and_pid(self) -> None:
        status = parse_sc_queryex(CommandResult(0, QUERYEX_RUNNING))

        assert status is not None
        assert (status.state, status.pid, status.exit_code) == (ServiceState.RUNNING, 4132, 0)

    def test_a_stopped_service_has_no_pid_and_says_how_it_ended(self) -> None:
        text = QUERYEX_STOPPED.format(win32=1067, specific=0)

        status = parse_sc_queryex(CommandResult(0, text))

        assert status is not None
        assert (status.state, status.pid, status.exit_code) == (ServiceState.STOPPED, None, 1067)

    def test_the_service_specific_code_is_the_exit_code_of_a_system_exit(self) -> None:
        # `SystemExit(1)` in the service ends it with ERROR_SERVICE_SPECIFIC_ERROR and code 1.
        status = parse_sc_queryex(CommandResult(0, QUERYEX_STOPPED.format(win32=1066, specific=1)))

        assert status is not None
        assert status.exit_code == 1

    def test_a_service_that_never_ran_has_no_exit_code(self) -> None:
        status = parse_sc_queryex(CommandResult(0, QUERYEX_STOPPED.format(win32=1077, specific=0)))

        assert status is not None
        assert status.exit_code is None

    def test_no_service_is_none_and_any_other_failure_is_an_error(self) -> None:
        assert parse_sc_queryex(CommandResult(1060, SC_NOT_INSTALLED)) is None
        with pytest.raises(ScError):
            parse_sc_queryex(CommandResult(5, "[SC] OpenService FAILED 5:\n\nAccess is denied.\n"))

    def test_the_config_has_the_delayed_start_dependencies_and_account(self) -> None:
        config = parse_sc_qc(SC_QC)

        assert config.start_type == "AUTO_START"
        assert config.delayed_start is True
        assert config.dependencies == ("Tcpip", "Dnscache")
        assert config.display_name == "Data Hub Watcher"
        assert config.start_name == "LocalSystem"
        assert config.binary_path.endswith("-m data_hub_watcher.service")
        assert "python.exe" in config.binary_path

    def test_an_undelayed_start_is_not_delayed(self) -> None:
        config = parse_sc_qc(SC_QC.replace("  (DELAYED)", ""))

        assert (config.start_type, config.delayed_start) == ("AUTO_START", False)

    def test_the_recovery_actions_and_the_flag(self) -> None:
        actions = parse_sc_failure(
            SC_QFAILURE, on_noncrash_failures=parse_sc_failure_flag(SC_QFAILUREFLAG)
        )

        assert actions.restart_delays_ms == (60_000, 120_000)
        assert actions.other_actions == ()
        assert actions.reset_period_seconds == 86_400
        assert actions.on_noncrash_failures is True
        assert parse_sc_failure_flag(SC_QFAILUREFLAG.replace("TRUE", "FALSE")) is False
        assert parse_sc_failure_flag("nothing here") is None

    def test_other_recovery_actions_are_named(self) -> None:
        text = (
            SC_QFAILURE
            + "                                       REBOOT -- Delay = 5000 milliseconds.\n"
        )

        assert parse_sc_failure(text).other_actions == ("REBOOT after 5000 ms",)

    def test_no_actions_at_all(self) -> None:
        text = "SERVICE_NAME: DataHubWatcher\n        RESET_PERIOD (in seconds)    : 0\n"

        actions = parse_sc_failure(text)

        assert (actions.restart_delays_ms, actions.reset_period_seconds) == ((), 0)

    def test_registry_values_stop_at_the_first_key(self) -> None:
        values = parse_registry_values(REG_QUERY)

        assert values["ConfigPath"] == r"C:\Users\runner\.data-hub\config.yaml"
        assert values["EnvPath"] == r"C:\Users\runner\.data-hub\.env.production"
        assert values["Type"] == "0x10"
        assert parse_registry_values("ERROR: The system was unable to find the key.") == {}

    def test_the_scheduled_task_fields(self) -> None:
        fields = parse_schtasks_list(SCHTASKS_LIST)

        assert fields["Run As User"] == "SYSTEM"
        assert fields["Status"] == "Ready"
        assert fields["Task To Run"].endswith('-File "C:\\u\\upgrade-worker.ps1"')


# ---------------------------------------------------------------------------
# The Event Log
# ---------------------------------------------------------------------------

EVENT_OUTPUT = """### 101 2026-01-01T10:00:00.0000000Z Application id=1 Python Service
Data Hub Watcher is running
### 102 2026-01-01T10:00:05.0000000Z Application id=7000 DataHubWatcher
The instance's SvcRun() method failed
Traceback (most recent call last):
  File "x.py", line 1, in <module>
click.exceptions.ClickException: Config file not found
### 103 2026-01-01T10:00:06.0000000Z System id=7034 Service Control Manager
The Data Hub Watcher service terminated unexpectedly.
"""


class TestEventLog:
    def test_entries_have_their_log_provider_and_the_whole_message(self) -> None:
        entries = parse_event_log(EVENT_OUTPUT)

        assert [(e.record_id, e.log, e.event_id, e.provider) for e in entries] == [
            (101, "Application", 1, "Python Service"),
            (102, "Application", 7000, "DataHubWatcher"),
            (103, "System", 7034, "Service Control Manager"),
        ]
        assert "Traceback (most recent call last)" in entries[1].message
        assert entries[1].message.endswith("Config file not found")
        assert parse_event_log("") == []

    def test_entries_are_written_for_a_person_to_read(self) -> None:
        text = format_event_entries(parse_event_log(EVENT_OUTPUT))

        assert "[Application] Python Service (id 1, record 101)" in text
        assert "Data Hub Watcher is running" in text

    def test_the_command_runs_the_script_without_quoting_to_get_wrong(self) -> None:
        argv = powershell_command(event_log_script(1_700_000_000.9))

        assert argv[0] == "powershell.exe"
        assert argv[-2] == "-EncodedCommand"
        script = base64.b64decode(argv[-1]).decode("utf-16-le")
        assert "FromUnixTimeSeconds(1700000000)" in script
        assert "Get-WinEvent" in script
        assert "LogName = 'Application'" in script
        assert "if ($true)" in script
        assert "__" not in script
        # Looking only for what the service host reported leaves the System log out.
        application_only = base64.b64decode(
            powershell_command(event_log_script(1_700_000_000, include_system=False))[-1]
        ).decode("utf-16-le")
        assert "if ($false)" in application_only


# ---------------------------------------------------------------------------
# The commands the host builds
# ---------------------------------------------------------------------------


class Recorder:
    """A runner that records each command and answers with what it is given."""

    def __init__(self, *answers: CommandResult) -> None:
        self.answers = list(answers)
        self.calls: list[list[str]] = []

    def __call__(
        self, argv: Sequence[str], timeout: float = 60.0, *, encoding: str | None = None
    ) -> CommandResult:
        self.calls.append(list(argv))
        return self.answers.pop(0) if self.answers else CommandResult(0)


class TestTheCommandsTheHostRuns:
    def test_recovery_is_taken_away_with_the_documented_sc_command(self) -> None:
        run = Recorder()

        WindowsHost(run).disable_failure_actions()

        assert run.calls == [["sc.exe", "failure", "DataHubWatcher", "reset=", "0", "actions=", ""]]

    def test_a_short_restart_is_a_restart_action_and_the_flag(self) -> None:
        run = Recorder()

        WindowsHost(run).set_restart_actions([5000, 5000])

        assert run.calls == [
            [
                "sc.exe",
                "failure",
                "DataHubWatcher",
                "reset=",
                "86400",
                "actions=",
                "restart/5000/restart/5000",
            ],
            ["sc.exe", "failureflag", "DataHubWatcher", "1"],
        ]

    def test_a_kill_ends_the_process_and_what_it_started(self) -> None:
        run = Recorder()

        WindowsHost(run).kill_tree(4132)

        assert run.calls == [["taskkill.exe", "/F", "/T", "/PID", "4132"]]

    def test_a_process_that_is_already_gone_is_not_an_error_but_a_refusal_is(self) -> None:
        WindowsHost(Recorder(CommandResult(128))).kill_tree(1)
        with pytest.raises(ScError, match="Access is denied"):
            WindowsHost(Recorder(CommandResult(1, "ERROR: Access is denied."))).kill_tree(1)

    def test_stopping_a_service_that_is_not_running_is_fine(self) -> None:
        run = Recorder(CommandResult(1062))

        WindowsHost(run).stop()

        assert run.calls == [["sc.exe", "stop", "DataHubWatcher"]]

    def test_registry_values_are_written_and_deleted_under_the_service_key(self) -> None:
        run = Recorder()
        host = WindowsHost(run)

        host.set_registry_value("ConfigPath", r"C:\x\config.yaml")
        host.delete_registry_value("ConfigPath")
        host.set_environment({"PYTHONPATH": r"C:\fault", "A": "1"})

        key = r"HKLM\SYSTEM\CurrentControlSet\Services\DataHubWatcher"
        assert run.calls[0] == [
            "reg.exe",
            "add",
            key,
            "/v",
            "ConfigPath",
            "/t",
            "REG_SZ",
            "/d",
            r"C:\x\config.yaml",
            "/f",
        ]
        assert run.calls[1] == ["reg.exe", "delete", key, "/v", "ConfigPath", "/f"]
        assert run.calls[2][-4:] == ["REG_MULTI_SZ", "/d", r"PYTHONPATH=C:\fault\0A=1", "/f"]

    def test_the_task_is_ended_before_it_is_deleted(self) -> None:
        run = Recorder(CommandResult(0), CommandResult(0))

        WindowsHost(run).delete_task()

        assert run.calls == [
            ["schtasks.exe", "/End", "/TN", "DataHubWatcherUpgrade"],
            ["schtasks.exe", "/Delete", "/TN", "DataHubWatcherUpgrade", "/F"],
        ]

    def test_a_task_that_will_not_go_is_an_error(self) -> None:
        run = Recorder(
            CommandResult(1), CommandResult(1, "ERROR: Access is denied."), CommandResult(0)
        )

        with pytest.raises(ScError):
            WindowsHost(run).delete_task()

    def test_the_config_and_the_recovery_are_read_with_sc(self) -> None:
        run = Recorder(
            CommandResult(0, SC_QC),
            CommandResult(0, SC_QFAILURE),
            CommandResult(0, SC_QFAILUREFLAG),
        )
        host = WindowsHost(run)

        assert host.config() is not None
        failure = host.failure_actions()

        assert [call[:3] for call in run.calls] == [
            ["sc.exe", "qc", "DataHubWatcher"],
            ["sc.exe", "qfailure", "DataHubWatcher"],
            ["sc.exe", "qfailureflag", "DataHubWatcher"],
        ]
        assert (failure.restart_delays_ms, failure.on_noncrash_failures) == (
            (60_000, 120_000),
            True,
        )

    def test_the_names_are_the_products(self) -> None:
        from data_hub_watcher import service as product

        source = Path(product.__file__).read_text(encoding="utf-8")
        assert 'SERVICE_DISPLAY_NAME = "Data Hub Watcher"' in source
        assert windows_scm.SERVICE_DISPLAY_NAME == "Data Hub Watcher"
        assert f'_REG_CONFIG_PATH = "{windows_scm.REG_CONFIG_PATH}"' in source
        assert f'_REG_ENV_PATH = "{windows_scm.REG_ENV_PATH}"' in source
        assert windows_scm.SERVICE_REGISTRY_KEY.endswith(windows_scm.SERVICE_NAME)
        # The product's recovery, which a test asserts after `service install`.
        assert "(1, 60_000)" in source and "(1, 120_000)" in source
        assert '"ResetPeriod": 86400' in source
        assert '_SERVICE_DEPENDENCIES: list[str] = ["Tcpip", "Dnscache"]' in source

    def test_the_lines_the_driver_waits_for_are_the_ones_the_service_logs(self) -> None:
        from data_hub_watcher import service as product

        source = Path(product.__file__).read_text(encoding="utf-8")
        assert '"%s starting (pid=%s, log=%s)"' in source
        assert '"%s is running", SERVICE_DISPLAY_NAME' in source
        assert '"%s is waiting: %s"' in source
        assert START_LINE.search("2026 [INFO] x: Data Hub Watcher starting (pid=7, log=y)")
        assert READY_LINE.search("2026 [INFO] x: Data Hub Watcher is running")
        assert READY_LINE.search("2026 [WARNING] x: Data Hub Watcher is waiting: no folder")
        assert not READY_LINE.search("Data Hub Watcher starting")


# ---------------------------------------------------------------------------
# A machine to run the driver against
# ---------------------------------------------------------------------------


class FakeMachine:
    """The parts of a Windows machine the driver talks to: one service, its registry key, its
    scheduled task and the shared log. It is a runner for :class:`WindowsHost`, and
    :meth:`cli` stands in for ``data-hub-watcher service ...``, changing the same state.
    """

    def __init__(self, log_dir: Path) -> None:
        self.log_dir = log_dir
        log_dir.mkdir(parents=True, exist_ok=True)
        self.service: dict[str, int] | None = None
        self.registry: dict[str, str] = {}
        self.task = False
        self.failure = "none"
        self.next_pid = 1000
        self.calls: list[list[str]] = []
        self.refuse_start = False
        self.event_output = ""
        self.removal_delay = 0  # queries that still see a removed service

    @property
    def log(self) -> Path:
        return self.log_dir / "watcher.log"

    def write_log(self, message: str) -> None:
        with self.log.open("a", encoding="utf-8") as handle:
            handle.write(f"2026-01-01 00:00:00,000 [INFO] data_hub_watcher.service: {message}\n")

    # -- the commands -----------------------------------------------------

    def __call__(
        self, argv: Sequence[str], timeout: float = 60.0, *, encoding: str | None = None
    ) -> CommandResult:
        args = list(argv)
        self.calls.append(args)
        program, verb = args[0].lower(), (args[1].lower() if len(args) > 1 else "")
        if program == "sc.exe":
            return self._sc(verb, args)
        if program == "taskkill.exe":
            return self._taskkill(int(args[-1]))
        if program == "schtasks.exe":
            return self._schtasks(args)
        if program == "reg.exe":
            return self._reg(verb)
        if program == "powershell.exe":
            return CommandResult(0, self.event_output)
        raise AssertionError(f"the fake machine doesn't know {args}")

    def _sc(self, verb: str, args: list[str]) -> CommandResult:
        if verb == "queryex":
            if self.service is None or (self.removal_delay and self.service.get("gone")):
                if self.service is not None:
                    self.removal_delay -= 1
                    if self.removal_delay == 0:
                        self.service = None
                    return CommandResult(0, self._queryex())
                return CommandResult(1060, SC_NOT_INSTALLED)
            return CommandResult(0, self._queryex())
        if verb == "stop":
            if self.service is None:
                return CommandResult(1060, SC_NOT_INSTALLED)
            if self.service["state"] == ServiceState.STOPPED:
                return CommandResult(1062)
            self._stopped(0, 0)
            self.write_log("Data Hub Watcher stopped")
            return CommandResult(0)
        if verb == "delete":
            self.service = None
            return CommandResult(0)
        if verb == "failure":
            self.failure = "none" if args[-1] == "" else "custom"
            return CommandResult(0)
        if verb == "failureflag":
            return CommandResult(0)
        raise AssertionError(f"the fake machine doesn't know {args}")

    def _queryex(self) -> str:
        assert self.service is not None
        state = self.service["state"]
        if state == ServiceState.STOPPED:
            return QUERYEX_STOPPED.format(
                win32=self.service["win32"], specific=self.service["specific"]
            )
        return QUERYEX_RUNNING.replace("4132", str(self.service["pid"]))

    def _stopped(self, win32: int, specific: int) -> None:
        assert self.service is not None
        self.service.update(state=ServiceState.STOPPED, pid=0, win32=win32, specific=specific)

    def _taskkill(self, pid: int) -> CommandResult:
        if self.service is None or self.service["pid"] != pid:
            return CommandResult(128)
        self._stopped(1067, 0)
        return CommandResult(0)

    def _schtasks(self, args: list[str]) -> CommandResult:
        verb = args[1].lower()
        if verb == "/query":
            return CommandResult(0 if self.task else 1)
        if verb == "/delete":
            self.task = False
        return CommandResult(0)

    def _reg(self, verb: str) -> CommandResult:
        if verb != "query" or self.service is None:
            return CommandResult(1)
        lines = [f"    {name}    REG_SZ    {value}" for name, value in self.registry.items()]
        return CommandResult(0, "\nHKEY_LOCAL_MACHINE\\x\\DataHubWatcher\n" + "\n".join(lines))

    # -- data-hub-watcher service ... -------------------------------------

    def cli(self, args: Sequence[str], global_args: Sequence[str]) -> CliResult:
        command = list(args)
        if command[:2] == ["service", "install"]:
            if self.service is not None:
                return self._cli_failed(args, "(1073, 'CreateService', 'The service exists.')")
            config = list(global_args)[list(global_args).index("--config") + 1]
            self.service = {"state": ServiceState.STOPPED, "pid": 0, "win32": 1077, "specific": 0}
            self.registry = {
                "ConfigPath": config,
                "EnvPath": command[command.index("--env-path") + 1],
            }
            self.task = True
            self.failure = "product"
            return CliResult(tuple(args), 0, "✓ Service installed.\n", "")
        if command[:2] == ["service", "start"]:
            if self.service is None:
                return self._cli_failed(args, "(1060, 'OpenService', 'does not exist')")
            self.next_pid += 1
            self.write_log(f"Data Hub Watcher starting (pid={self.next_pid}, log=x)")
            if self.refuse_start:
                self.service.update(state=ServiceState.RUNNING, pid=self.next_pid)
                self.write_log("Cannot reach API during startup: down")
                self._stopped(1066, 1)
            else:
                self.service.update(state=ServiceState.RUNNING, pid=self.next_pid)
                self.write_log("Data Hub Watcher is running")
            return CliResult(tuple(args), 0, "✓ Service started.\n", "")
        if command[:2] == ["service", "stop"]:
            result = self(["sc.exe", "stop", "DataHubWatcher"])
            return CliResult(tuple(args), 0 if result.returncode == 0 else 1, "", "")
        if command[:2] == ["service", "uninstall"]:
            if self.service is not None and self.service["state"] != ServiceState.STOPPED:
                self._stopped(0, 0)
            self.service, self.registry, self.task = None, {}, False
            return CliResult(tuple(args), 0, "✓ Service removed.\n", "")
        raise AssertionError(f"the fake service CLI doesn't know {args}")

    @staticmethod
    def _cli_failed(args: Sequence[str], message: str) -> CliResult:
        return CliResult(tuple(args), 1, "", f"Error: {message}\n")

    def restart_with_new_pid(self) -> None:
        """What the upgrade worker does: stop the service, then start it again."""
        self.cli(["service", "stop"], ())
        self.cli(["service", "start"], ())


def make_config(tmp_path: Path) -> WatcherConfig:
    (tmp_path / "watch").mkdir(exist_ok=True)
    return WatcherConfig(
        version=1,
        environment="production",
        api_base_urls={"production": "http://127.0.0.1:1/api/v1"},
        watcher_ids={"production": "w-1"},
        instrument=InstrumentConfig(
            id="inst-one",
            watch_directory=tmp_path / "watch",
            file_patterns=["*.csv"],
            run_detection=RunDetectionConfig(pattern=r"^([^/]+)/", recursive=True),
        ),
    )


@pytest.fixture(autouse=True)
def _no_owner() -> Iterator[None]:
    """Nothing carries over between tests: the one service of the machine has no owner."""
    WindowsServiceDriver._owner = None
    yield
    WindowsServiceDriver._owner = None


@pytest.fixture
def machine(tmp_path: Path) -> FakeMachine:
    return FakeMachine(tmp_path / "ProgramData")


def make_driver(
    tmp_path: Path,
    machine: FakeMachine,
    monkeypatch: pytest.MonkeyPatch,
    *,
    name: str = "home",
    configured: bool = True,
) -> WindowsServiceDriver:
    monkeypatch.setattr(drivers, "uv_environment", lambda: {})
    monkeypatch.setattr(drivers, "uv_executable", lambda: str(tmp_path / "uvbin" / "uv.exe"))
    driver = WindowsServiceDriver(
        profile=tmp_path / name,
        tool_install=ToolInstall(tmp_path / "install"),
        instrument_id="inst-one",
        watch_dir=tmp_path / "watch",
        api_base_url="http://127.0.0.1:1/api/v1",
        api_key="dhub_key",
        host=WindowsHost(machine),
        log_dir=machine.log_dir,
        system_root=tmp_path / "Windows",
    )

    def fake_cli(
        *args: str,
        input: str | None = None,
        timeout: float = 120.0,
        global_args: Sequence[str] = (),
    ) -> CliResult:
        return machine.cli(args, global_args)

    monkeypatch.setattr(driver, "run_cli", fake_cli)
    if configured:
        driver.write_config(make_config(tmp_path))
        driver.write_env("dhub_key", {"DATA_HUB_WATCHER_HEARTBEAT_INTERVAL_SECONDS": "2"})
    return driver


# ---------------------------------------------------------------------------
# The driver
# ---------------------------------------------------------------------------


class TestInstalling:
    def test_the_service_is_installed_with_this_pcs_own_config_and_env_file(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)

        result = driver.install_service()

        assert "Service installed" in result.stdout
        config_path, env_path = driver.registered_paths()
        assert config_path == tmp_path / "home" / ".data-hub" / "config.yaml"
        assert env_path == tmp_path / "home" / ".data-hub" / ".env.production"
        assert (config_path, env_path) == (driver.config_path, driver.env_path)

    def test_recovery_is_off_unless_the_product_setup_is_asked_for(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)

        driver.install_service()
        assert machine.failure == "none"
        assert ["sc.exe", "failure", "DataHubWatcher", "reset=", "0", "actions=", ""] in (
            machine.calls
        )

        driver.install_service(failure_actions="product")
        assert machine.failure == "product"

    def test_a_service_already_on_the_machine_is_stopped_and_removed_first(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        earlier = make_driver(tmp_path, machine, monkeypatch, name="earlier")
        later = make_driver(tmp_path, machine, monkeypatch, name="later")
        earlier.start()
        machine.calls.clear()

        later.install_service()

        # It looked, found the other PC's service running, and stopped it, before installing.
        verbs = [" ".join(call[:2]) for call in machine.calls]
        assert verbs[:2] == ["sc.exe queryex", "sc.exe stop"]
        assert machine.registry["ConfigPath"] == str(later.config_path)
        assert not earlier.is_running()

    def test_an_install_without_any_config_says_what_to_do(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch, configured=False)

        with pytest.raises(RuntimeError, match="write one"):
            driver.install_service()

    def test_a_config_that_is_broken_by_the_scenario_is_installed_from_the_last_good_one(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)
        driver.write_config_text("instrument: [unclosed\n")
        seen: list[bool] = []
        real = machine.cli

        def watching(args: Sequence[str], global_args: Sequence[str]) -> CliResult:
            if list(args[:2]) == ["service", "install"]:
                load_config(driver.config_path)  # raises if it is still broken
                seen.append(True)
            return real(args, global_args)

        monkeypatch.setattr(machine, "cli", watching)

        driver.install_service()

        # It loaded during the install, and the scenario's broken text is back.
        assert seen == [True]
        assert driver.config_path.read_text() == "instrument: [unclosed\n"

    def test_a_missing_config_is_put_back_as_missing(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)
        driver.config_path.unlink()

        driver.install_service()

        assert not driver.config_path.exists()

    def test_the_env_file_gets_a_path_that_finds_uv_unless_it_has_one(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)

        driver.install_service()

        lines = driver.env_path.read_text().splitlines()
        (path_line,) = [line for line in lines if line.startswith("PATH=")]
        entries = path_line.removeprefix("PATH=").split(os.pathsep)
        assert entries[0] == str(tmp_path / "uvbin")
        assert str(tmp_path / "Windows" / "System32") in entries
        # The key and the overrides are still there.
        assert "DATA_HUB_API_KEY='dhub_key'" in lines
        # Another install keeps the path it has.
        driver.write_env(overrides={"PATH": "custom"})
        driver.install_service()
        assert "PATH=custom" in driver.env_path.read_text().splitlines()


class TestRunning:
    def test_the_first_start_installs_the_service_and_waits_for_the_ready_line(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)
        assert driver.service_status() is None
        assert (driver.is_running(), driver.pid, driver.exit_code) == (False, None, None)

        driver.start()

        assert driver.is_running()
        assert driver.pid == machine.next_pid
        assert driver.exit_code is None
        assert "Data Hub Watcher is running" in driver.log_text()
        installs = [c for c in machine.calls if c[:2] == ["sc.exe", "failure"]]
        assert len(installs) == 1  # Installed once, with recovery off.

    def test_a_second_start_does_not_install_again(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)
        driver.start()
        assert driver.stop() == 0
        machine.calls.clear()

        driver.start()

        assert not [c for c in machine.calls if c[:2] == ["sc.exe", "failure"]]
        assert driver.is_running()

    def test_a_stop_exits_zero_and_leaves_no_pid(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)
        driver.start()

        assert driver.stop() == 0

        assert (driver.is_running(), driver.pid, driver.exit_code) == (False, None, 0)

    def test_a_refused_start_returns_once_the_service_has_ended_with_its_exit_code(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)
        machine.refuse_start = True

        driver.start()

        assert not driver.is_running()
        assert driver.exit_code == 1  # The service's own code, from ERROR_SERVICE_SPECIFIC_ERROR.
        assert driver.wait_exit(1) == 1
        assert "Cannot reach API during startup" in driver.log_text()
        # The time the failure was seen, which the scenarios of recovery count 60 s from.
        first_ended = driver.ended_at
        assert first_ended is not None
        # A later start is timed from its own end.
        driver.start()
        assert driver.ended_at is not None and driver.ended_at >= first_ended

    def test_a_service_that_cannot_be_started_is_an_error_with_the_log(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)
        real = machine.cli

        def failing(args: Sequence[str], global_args: Sequence[str]) -> CliResult:
            if list(args[:2]) == ["service", "start"]:
                return CliResult(tuple(args), 1, "", "Error: Failed to start service: boom\n")
            return real(args, global_args)

        monkeypatch.setattr(machine, "cli", failing)

        with pytest.raises(RuntimeError, match="(?s)`service start` failed.*boom"):
            driver.start()

    def test_starting_twice_is_refused(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)
        driver.start()

        with pytest.raises(RuntimeError, match="already running"):
            driver.start()

    def test_a_service_takes_no_watch_arguments_and_has_no_interrupt(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)

        with pytest.raises(NotImplementedError, match="CLI driver"):
            driver.start(args=("--dry-run",))
        with pytest.raises(NotImplementedError, match="CLI driver"):
            driver.start(global_args=("--verbose",))
        with pytest.raises(NotImplementedError, match="CLI only"):
            driver.interrupt()

    def test_a_kill_ends_the_process_tree_and_the_service_stays_down(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)
        driver.start()
        pid = driver.pid

        driver.kill()

        assert ["taskkill.exe", "/F", "/T", "/PID", str(pid)] in machine.calls
        assert not driver.is_running()
        assert driver.exit_code == 1067
        driver.kill()  # Nothing to kill: not an error.

    def test_restart_stops_then_starts(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)
        driver.start()
        first = driver.pid

        driver.restart()

        assert driver.is_running()
        assert driver.pid != first

    def test_waiting_for_an_exit_that_does_not_come_times_out_with_the_log(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)
        driver.start()

        with pytest.raises(WaitTimeout, match="STOPPED") as raised:
            driver.wait_exit(0.3)

        assert "Data Hub Watcher is running" in str(raised.value)


class TestAnUpgradeRestart:
    def test_it_waits_for_a_new_pid_and_for_the_new_process_to_be_ready(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)
        driver.start()
        old = driver.pid

        machine.restart_with_new_pid()  # The worker's Stop-Service and Start-Service.
        driver.await_upgrade_restart(2)

        assert driver.pid not in (None, old)
        # The next restart is waited for from the new pid.
        machine.restart_with_new_pid()
        driver.await_upgrade_restart(2)

    def test_the_same_process_is_not_a_restart(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)
        driver.start()

        with pytest.raises(WaitTimeout, match="a pid other than"):
            driver.await_upgrade_restart(0.5)

    def test_it_needs_a_service_that_was_started(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)

        with pytest.raises(RuntimeError, match="started first"):
            driver.await_upgrade_restart(1)

    def test_it_never_starts_the_service_itself(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)
        driver.start()
        machine.calls.clear()
        machine.restart_with_new_pid()
        machine.calls.clear()

        driver.await_upgrade_restart(2)

        assert not [c for c in machine.calls if c[:2] in (["sc.exe", "stop"],)]
        assert machine.service is not None and machine.service["state"] == ServiceState.RUNNING


class TestClosing:
    def test_close_stops_uninstalls_and_waits_until_the_scm_has_forgotten_the_service(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)
        driver.start()
        machine.removal_delay = 3
        assert machine.service is not None
        machine.service["gone"] = 1  # Marked for deletion: it takes three queries to go.

        driver.close()

        assert machine.service is None
        assert machine.registry == {}
        assert not machine.task
        assert machine.log.exists()  # The shared log stays.

    def test_the_order_is_stop_then_uninstall_then_the_task_then_waiting(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)
        driver.start()
        machine.calls.clear()
        order: list[str] = []
        real = machine.cli

        def noting(args: Sequence[str], global_args: Sequence[str]) -> CliResult:
            order.append(" ".join(args))
            return real(args, global_args)

        monkeypatch.setattr(machine, "cli", noting)

        driver.close()

        sc_calls = [call[1] for call in machine.calls if call[0] == "sc.exe"]
        assert sc_calls[:2] == ["queryex", "stop"]
        assert order == ["service uninstall"]
        assert machine.calls[-1][:2] == ["sc.exe", "queryex"]

    def test_a_service_that_will_not_stop_is_killed(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)
        driver.start()
        monkeypatch.setattr("e2e_support.service_driver._CLOSE_GRACE_SECONDS", 0.3)
        # `sc stop` is accepted and the service goes on running.
        real = machine._sc  # noqa: SLF001

        def stubborn(verb: str, args: list[str]) -> CommandResult:
            return CommandResult(0) if verb == "stop" else real(verb, args)

        monkeypatch.setattr(machine, "_sc", stubborn)

        driver.close()

        assert any(call[:4] == ["taskkill.exe", "/F", "/T", "/PID"] for call in machine.calls)
        assert machine.service is None

    def test_a_task_that_is_left_behind_is_deleted(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)
        driver.start()
        real = machine.cli

        def leaving_the_task(args: Sequence[str], global_args: Sequence[str]) -> CliResult:
            result = real(args, global_args)
            machine.task = True  # An uninstall that left it.
            return result

        monkeypatch.setattr(machine, "cli", leaving_the_task)

        driver.close()

        assert not machine.task

    def test_close_is_safe_twice_and_leaves_the_profile_for_the_artifacts(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)
        driver.start()

        driver.close()
        driver.close()

        assert driver.config_path.exists()
        assert machine.service is None

    def test_only_the_driver_that_owns_the_service_removes_it(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A test with two PCs, one after the other: the later one has the service, and closing
        # the earlier one (first, as the fixture does) must not take it away.
        first = make_driver(tmp_path, machine, monkeypatch, name="first")
        second = make_driver(tmp_path, machine, monkeypatch, name="second")
        first.start()
        first.stop()
        second.start()

        first.close()
        assert machine.service is not None
        assert machine.registry["ConfigPath"] == str(second.config_path)

        second.close()
        assert machine.service is None

    def test_a_driver_that_never_started_leaves_the_machine_alone(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)
        machine.calls.clear()

        driver.close()

        assert machine.calls == []

    def test_an_install_that_was_removed_by_the_scenario_is_installed_again_at_the_next_start(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)
        driver.start()
        driver.run_cli("service", "uninstall")
        assert machine.service is None

        driver.start()

        assert driver.is_running()


class TestTheSharedLog:
    def test_the_driver_reads_the_machine_log_from_where_it_ended_when_it_was_made(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        machine.write_log("a line from an earlier test")
        driver = make_driver(tmp_path, machine, monkeypatch)

        driver.start()

        assert "an earlier test" not in driver.log_text()
        assert "Data Hub Watcher is running" in driver.log_text()
        # The whole file is what the artifacts keep.
        assert driver.log_files()[0] == machine.log
        assert "an earlier test" in machine.log.read_text()

    def test_a_mark_limits_the_text_to_what_came_after_it(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)
        driver.start()
        mark = driver.mark_logs()
        machine.write_log("after the mark")

        assert driver.log_text(mark).strip().endswith("after the mark")
        assert "Data Hub Watcher is running" not in driver.log_text(mark)
        assert driver.wait_for_log("after the mark", 1, since=mark)

    def test_a_log_that_was_rotated_under_the_offset_is_read_from_its_start(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        machine.write_log("x" * 5000)
        driver = make_driver(tmp_path, machine, monkeypatch)
        machine.log.write_text("fresh after the rotation\n")

        assert driver.log_text() == "fresh after the rotation\n"

    def test_the_bootstrap_log_and_the_workers_log_are_part_of_the_text(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        (machine.log_dir / "service-bootstrap.log").write_text("old failure\n")
        driver = make_driver(tmp_path, machine, monkeypatch)
        (machine.log_dir / "service-bootstrap.log").write_text("old failure\nRuntimeError: boom\n")
        driver.config_dir().mkdir(parents=True, exist_ok=True)
        driver.worker_log.write_text("uv exited 0\n")

        text = driver.log_text()

        assert "old failure" not in text
        assert "RuntimeError: boom" in text
        assert "uv exited 0" in text

    def test_a_file_that_is_missing_is_no_text(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)

        assert driver.log_text() == ""
        assert driver.log_tail() == ""

    def test_what_the_service_host_reports_only_to_the_event_log_is_in_the_text(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        machine.event_output = EVENT_OUTPUT
        driver = make_driver(tmp_path, machine, monkeypatch)
        machine.refuse_start = True

        driver.start()
        driver.wait_exit(1)

        text = driver.log_text()
        assert "click.exceptions.ClickException: Config file not found" in text
        # The entries that only repeat what watcher.log has are not copied: nothing is counted
        # twice.
        assert text.count("Data Hub Watcher is running") == 0
        driver.wait_exit(1)
        assert driver.log_text().count("ClickException") == 1

    def test_the_artifacts_get_an_event_log_export(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        machine.event_output = EVENT_OUTPUT
        driver = make_driver(tmp_path, machine, monkeypatch)
        driver.start()

        files = driver.log_files()

        export = next(path for path in files if path.name == "event-log.txt")
        assert "Data Hub Watcher is running" in export.read_text()


class TestTheProfile:
    def test_state_and_config_live_in_the_profile(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)

        assert driver.config_dir() == tmp_path / "home" / ".data-hub"
        assert driver.config_path == driver.config_dir() / "config.yaml"
        assert driver.env_path == driver.config_dir() / ".env.production"
        assert driver.state_db_path() == driver.config_dir() / "watcher-production.db"
        assert driver.worker_script == driver.config_dir() / "upgrade-worker.ps1"
        assert driver.worker_log == driver.config_dir() / "upgrade-worker.log"

    def test_the_environment_of_a_command_points_at_the_profile_and_is_scrubbed(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("DATA_HUB_API_KEY", "dhub_from_the_shell")
        monkeypatch.setenv("HTTPS_PROXY", "http://proxy.example:3128")
        driver = make_driver(tmp_path, machine, monkeypatch)

        env = driver.process_environment()

        profile = str((tmp_path / "home").resolve())
        assert (env["USERPROFILE"], env["HOME"]) == (profile, profile)
        assert env["APPDATA"] == str(Path(profile) / "AppData" / "Roaming")
        assert env["PYTHONUTF8"] == "1"
        assert env["PATH"].startswith(str(driver.tool_install.bin_dir))
        assert env["UV_TOOL_DIR"] == str(driver.tool_install.tool_dir)
        assert "DATA_HUB_API_KEY" not in env
        assert "HTTPS_PROXY" not in env
        assert env["NO_PROXY"] == "127.0.0.1,localhost"

    def test_two_pcs_have_their_own_files(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        one = make_driver(tmp_path, machine, monkeypatch, name="one")
        two = make_driver(tmp_path, machine, monkeypatch, name="two")

        assert one.config_path != two.config_path
        assert one.state_db_path() != two.state_db_path()
        assert one.env_path.parent != two.env_path.parent

    def test_the_state_database_is_queried_where_the_service_keeps_it(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import sqlite3

        driver = make_driver(tmp_path, machine, monkeypatch)
        assert driver.state_query("SELECT 1") == []  # No database yet.
        with sqlite3.connect(driver.state_db_path()) as conn:
            conn.execute("CREATE TABLE pending_uploads (relative_path TEXT)")
        driver.state_execute("INSERT INTO pending_uploads VALUES ('RUN/a.csv')")

        assert driver.state_query("SELECT relative_path FROM pending_uploads") == [("RUN/a.csv",)]

    def test_the_service_kind_says_what_the_watcher_says(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)

        assert (driver.kind, driver.role) == ("service", "Service")
        assert driver.started_prefix == "Service started on "
        assert driver.operator_stop_message == "Service stopped"
        assert driver.update_stop_message == "Service stopped"
        assert driver.install_extras == ("windows-service",)
        assert drivers.CliDriver.install_extras == ()


class TestUvAndTheInstall:
    def test_hide_uv_leaves_the_service_system32_alone(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)

        driver.hide_uv()
        driver.install_service()  # Keeps the path hide_uv wrote.

        lines = driver.env_path.read_text().splitlines()
        assert [line for line in lines if line.startswith("PATH=")] == [
            f"PATH={tmp_path / 'Windows' / 'System32'}"
        ]

    def test_hide_uv_reports_a_uv_the_service_would_still_find(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)
        binary = "uv.exe" if sys.platform == "win32" else "uv"
        found = tmp_path / "Windows" / "System32" / "config" / "systemprofile" / ".local" / "bin"
        found.mkdir(parents=True)
        (found / binary).write_text("")

        with pytest.raises(RuntimeError, match="still find it"):
            driver.hide_uv()

        assert not [
            line for line in driver.env_path.read_text().splitlines() if line.startswith("PATH=")
        ]

    def test_hide_uv_leaves_this_processs_environment_as_it_was(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("USERPROFILE", "keep-userprofile")
        monkeypatch.delenv("HOME", raising=False)
        driver = make_driver(tmp_path, machine, monkeypatch)

        driver.hide_uv()

        assert os.environ["USERPROFILE"] == "keep-userprofile"
        assert "HOME" not in os.environ

    def test_installing_a_wheel_needs_an_install_of_its_own_and_a_stopped_service(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        installed: list[dict[str, object]] = []

        def fake_install(root: Path, wheel: Path, **kwargs: object) -> ToolInstall:
            installed.append({"root": root, "wheel": wheel, **kwargs})
            return ToolInstall(root)

        monkeypatch.setattr(drivers, "install_watcher_tool", fake_install)
        driver = make_driver(tmp_path, machine, monkeypatch)

        with pytest.raises(RuntimeError, match="own_install"):
            driver.install_wheel(tmp_path / "old.whl")

        driver.owns_install = True
        driver.start()
        with pytest.raises(RuntimeError, match="Stop the service"):
            driver.install_wheel(tmp_path / "old.whl")
        driver.stop()
        driver.install_wheel(tmp_path / "old.whl")

        assert installed == [
            {
                "root": driver.tool_install.root,
                "wheel": tmp_path / "old.whl",
                "python": "3.12",
                "extras": ("windows-service",),
                "reinstall": True,
            }
        ]

    def test_the_installed_version_is_what_the_install_reports(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)
        monkeypatch.setattr(ToolInstall, "version", lambda self: "1.2.3")

        assert driver.installed_version() == "1.2.3"


@pytest.mark.skipif(sys.platform == "win32", reason="a POSIX stand-in for data-hub-watcher.exe")
class TestRunningTheRealExecutable:
    """``run_cli`` against a script that stands in for ``data-hub-watcher``."""

    SCRIPT = """\
        #!{python}
        import os, sys
        print("userprofile=" + os.environ["USERPROFILE"])
        print("utf8=" + os.environ["PYTHONUTF8"])
        print("argv=" + " ".join(sys.argv[1:]))
        print("stdin=" + sys.stdin.read().strip())
        print("\\u2713 done")
        print("warning", file=sys.stderr)
        sys.exit(3)
    """

    def test_it_runs_in_the_profile_decodes_utf8_and_pipes_stdin(
        self, tmp_path: Path, machine: FakeMachine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path, machine, monkeypatch)
        monkeypatch.undo()  # Back to the real `run_cli`.
        monkeypatch.setattr(drivers, "uv_environment", lambda: {})
        driver.tool_install.bin_dir.mkdir(parents=True)
        script = driver.tool_install.executable
        script.write_text(textwrap.dedent(self.SCRIPT).format(python=sys.executable))
        script.chmod(script.stat().st_mode | stat.S_IEXEC)

        result = driver.run_cli(
            "init", "--show-key", input="answer one\n", global_args=("--config", "x.yaml")
        )

        assert result.returncode == 3
        assert f"userprofile={(tmp_path / 'home').resolve()}" in result.stdout
        assert "utf8=1" in result.stdout
        assert "argv=--config x.yaml init --show-key" in result.stdout
        assert "stdin=answer one" in result.stdout
        assert "\u2713 done" in result.stdout
        assert result.stderr.strip() == "warning"
        assert result.args == ("init", "--show-key")
