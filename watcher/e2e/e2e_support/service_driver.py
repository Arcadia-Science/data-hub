"""``WindowsServiceDriver``: the watcher as the real Windows service.

The shared scenario files run against this driver exactly as they run against ``CliDriver``.
``test_windows_service.py`` covers what only exists under a service. This module needs Windows
to run a service, but it imports on any platform and everything it asks of Windows goes through
``e2e_support.windows_scm``, which is tested with a fake runner on any platform.

How a PC becomes a service
--------------------------

An operator runs ``uv tool install "data-hub-watcher[windows-service]"``, ``data-hub-watcher
init``, ``data-hub-watcher service install`` and ``data-hub-watcher service start`` from an
elevated shell. The driver does the same, in this order, so a scenario finds the PC as ``init``
leaves it:

* The wheel is installed by ``install_watcher_tool`` with the ``windows-service`` extra, into
  an install of the suite's own (``UV_TOOL_DIR`` under a temp folder), so a developer's real
  ``data-hub-watcher`` is never touched, and the path still has ``/uv/tools/data-hub-watcher``
  in it, which is how the watcher knows it may update itself.
* Each driver has a ``profile`` folder, and every one-shot command runs with ``USERPROFILE``,
  ``HOME`` and ``APPDATA`` pointing at it. ``~/.data-hub`` (``config.yaml``, the env file, the
  state database, the upgrade sentinels and the worker script) is therefore the test's own,
  ``init`` never sees an earlier test's config, and tests share nothing but the one service
  and ``watcher.log``.
* The service is installed when the driver first starts it (``ensure installed``), because
  ``service install`` reads the config, and a scenario may write it after the PC is built.
  The registry values ``ConfigPath`` and ``EnvPath`` then point into the profile. There is one
  service per machine: a driver that installs takes the service over from whichever driver had
  it, and ``close()`` removes it only if it is still the owner, so a test with several PCs
  (one after the other) leaves nothing behind. A driver that no longer owns the service neither
  reads nor controls it: it reports "not running", and ``request_stop``, ``kill`` and
  ``wait_exit`` raise, so a test can't stop another PC's service by mistake.
* Right after ``service install`` the driver turns the SCM's recovery actions off, so a killed
  or refused service stays down as a ``watch`` process does. ``install_service(
  failure_actions="product")`` keeps what the product configured, for the tests of recovery.
* The env file gets a ``PATH`` that leads to ``uv`` and ``System32``, because a service has no
  user PATH and the updater has to find ``uv``. ``hide_uv()`` replaces it with ``System32``.

How the abstract members map to Windows
---------------------------------------

=====================  =================================================================
``start``              ``service start``, then waits for the service's own "is running"
                       (or "is waiting") line in ``watcher.log``: the SCM says ``RUNNING``
                       as soon as the process is up, before the start-up scan
``request_stop``       ``service stop`` (``SvcStop``), without waiting
``wait_exit``          waits for the SCM state ``STOPPED`` and returns its exit code
``kill``               ``taskkill /F /T /PID`` of the pid ``sc queryex`` reports, and waits
                       for ``STOPPED``
``is_running``         the SCM state is anything but ``STOPPED``
``pid``                the pid ``sc queryex`` reports
``exit_code``          the win32 exit code (1067 for a kill), or for anything raised out of
                       ``SvcRun`` (a ``SystemExit(1)``, an uncaught error) the service's
                       own code, 0x20000001, which is not the 1 of the ``SystemExit``;
                       ``None`` while it runs
``await_upgrade_restart``  waits for ``RUNNING`` with a pid other than the last start's
``log_files``          ``watcher.log`` in ProgramData (shared by the machine; read from
                       the byte offset at the driver's creation), ``service-bootstrap.log``,
                       the profile's ``upgrade-worker.log`` and ``upgrade-worker.ps1``, the
                       upgrade sentinels, and an Event Log export
``close``              recovery off, the upgrade task and any worker ended, the service
                       stopped (killed if it won't), ``service uninstall``, and a wait until
                       the SCM has forgotten it
=====================  =================================================================

``interrupt`` raises ``NotImplementedError``: a service has no Ctrl+C.
"""

from __future__ import annotations
import contextlib
import os
import re
import subprocess
import sys
import threading
import time
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path
from typing import ClassVar, Literal

from data_hub_watcher import self_update
from data_hub_watcher.config_io import load_config
from data_hub_watcher.constants import WATCHER_LOG_DIR
from data_hub_watcher.models import WatcherConfig
from data_hub_watcher.updater import UPGRADE_MARKER_FILENAME
from data_hub_watcher.upgrade_worker import (
    UPGRADE_REQUEST_FILENAME,
    UPGRADE_RESULT_FILENAME,
    UPGRADE_WORKER_LOG_FILENAME,
    UPGRADE_WORKER_SCRIPT_FILENAME,
)
from e2e_support import drivers
from e2e_support.catalog.model import DriverKind
from e2e_support.drivers import (
    DEFAULT_ENVIRONMENT,
    CliResult,
    LogMark,
    ToolInstall,
    WatcherDriver,
)
from e2e_support.waiting import WaitTimeout, wait_until
from e2e_support.windows_scm import (
    SERVICE_DISPLAY_NAME,
    EventLogEntry,
    ScError,
    ServiceState,
    ServiceStatus,
    WindowsHost,
    format_event_entries,
)

__all__ = [
    "BOOTSTRAP_LOG_FILENAME",
    "READY_LINE",
    "START_LINE",
    "SVCRUN_FAILED_TEXT",
    "WATCHER_LOG_FILENAME",
    "WindowsServiceDriver",
    "is_elevated",
]

WATCHER_LOG_FILENAME = "watcher.log"
BOOTSTRAP_LOG_FILENAME = "service-bootstrap.log"

# `_run_service_loop` says these when it has started (the first line), and when the watcher
# is watching or, for a missing folder, waiting. They are the service's "ready" (the CLI's is
# "Press Ctrl+C to stop.").
_NAME = re.escape(SERVICE_DISPLAY_NAME)
START_LINE = re.compile(rf"{_NAME} starting \(pid=")
READY_LINE = re.compile(rf"{_NAME} is (?:running|waiting)")

# After `service start` returns, the SCM may still say STOPPED for a moment, so a stopped
# service counts as one that ran and ended only once it has logged its first line or this
# long has passed.
_START_GRACE_SECONDS = 5.0

# How long a graceful stop may take when the driver removes the service, before it is killed.
_CLOSE_GRACE_SECONDS = 20.0
_REMOVE_TIMEOUT_SECONDS = 60.0

# What pywin32 reports to the Event Log when `SvcRun` raises (`E_PYS_START_FAILED`), followed by
# the traceback. The service's own log lines reach the Event Log as well, and `watcher.log` has
# them already, so this is the one entry the driver copies.
SVCRUN_FAILED_TEXT = "SvcRun() method failed"

# How long the service's process may take to be gone once the SCM says it has stopped.
_PROCESS_EXIT_SECONDS = 30.0

# How long a `taskkill` that reported a failure is given before the service counts as not killed.
_TASKKILL_SETTLE_SECONDS = 3.0

FailureActionsMode = Literal["off", "product"]


def is_elevated() -> bool:
    """Whether this process runs as an administrator, which installing a service needs. The
    shell of a GitHub Actions Windows runner is; a developer's usually isn't."""
    if sys.platform != "win32":
        return False
    import ctypes

    return bool(ctypes.windll.shell32.IsUserAnAdmin())


class WindowsServiceDriver(WatcherDriver):
    """The watcher installed as the ``DataHubWatcher`` Windows service, for one test.

    ``profile`` is the folder that stands in for the operator's home (see the module
    docstring). ``tool_install`` is the ``uv tool`` install the service runs from, and
    ``owns_install`` says it is this PC's alone (what ``install_wheel`` needs).
    ``host`` runs the Windows commands, ``log_dir`` is where the service writes ``watcher.log``
    (ProgramData), and ``system_root`` is ``%SystemRoot%``: the last two are parameters for the
    unit tests.
    """

    kind: ClassVar[DriverKind] = "service"
    role: ClassVar[str] = "Service"
    # The service needs pywin32, which ships in this extra.
    install_extras: ClassVar[tuple[str, ...]] = ("windows-service",)
    # The worker's `uv tool install` runs as LocalSystem, whose uv cache is empty on a new runner
    # (see `WatcherDriver.install_timeout_seconds`).
    install_timeout_seconds: ClassVar[float] = 300.0

    # The one service on this machine belongs to the driver that installed it last.
    _owner: ClassVar[WindowsServiceDriver | None] = None

    def __init__(
        self,
        *,
        profile: Path,
        tool_install: ToolInstall,
        instrument_id: str,
        watch_dir: Path,
        environment: str = DEFAULT_ENVIRONMENT,
        api_base_url: str,
        api_key: str,
        watcher_id: str | None = None,
        owns_install: bool = False,
        extra_environment: Mapping[str, str] | None = None,
        host: WindowsHost | None = None,
        log_dir: Path | None = None,
        system_root: Path | None = None,
    ) -> None:
        super().__init__(
            instrument_id=instrument_id,
            watch_dir=watch_dir,
            environment=environment,
            api_base_url=api_base_url,
            api_key=api_key,
            watcher_id=watcher_id,
        )
        # Resolved, because `service install` registers the resolved path and a test compares.
        self.profile = Path(profile).resolve()
        self.tool_install = tool_install
        self.owns_install = owns_install
        self.extra_environment = dict(extra_environment or {})
        self.host = host or WindowsHost()
        self.log_dir = Path(log_dir) if log_dir is not None else WATCHER_LOG_DIR
        self.system_root = Path(
            system_root if system_root is not None else os.environ.get("SystemRoot", r"C:\Windows")
        )
        self._driver_logs = self.profile / "driver-logs"
        self._installed = False
        self._closed = False
        self._run_count = 0
        self._created_at = time.time()
        self._record_log_baseline()
        # Where this run's lines start in the logs, how many starts since then (a start of
        # the driver, or the upgrade worker's restart), and the pid of the last one.
        self._start_mark = LogMark(())
        self._runs_since_mark = 0
        self._started_at = time.monotonic()
        self._baseline_pid: int | None = None
        # When the driver last saw the service stopped after a start (`time.monotonic()`).
        self.ended_at: float | None = None
        self._captured_event_ids: set[int] = set()
        # The last config written through `write_config`: `service install` needs a config that
        # loads (see `install_service`).
        self._last_good_config: WatcherConfig | None = None

    # -- paths ------------------------------------------------------------

    def config_dir(self) -> Path:
        return self.profile / ".data-hub"

    def state_db_path(self) -> Path:
        return self.config_dir() / f"watcher-{self.environment}.db"

    @property
    def watcher_log(self) -> Path:
        """The log the whole machine shares: ``C:\\ProgramData\\DataHubWatcher\\watcher.log``."""
        return self.log_dir / WATCHER_LOG_FILENAME

    @property
    def bootstrap_log(self) -> Path:
        """What a service that fails before the SCM takes over writes, beside ``watcher.log``."""
        return self.log_dir / BOOTSTRAP_LOG_FILENAME

    @property
    def worker_log(self) -> Path:
        """The upgrade worker's log, in the config directory."""
        return self.config_dir() / UPGRADE_WORKER_LOG_FILENAME

    @property
    def worker_script(self) -> Path:
        """The PowerShell script the upgrade task runs, rendered by ``service install``."""
        return self.config_dir() / UPGRADE_WORKER_SCRIPT_FILENAME

    @property
    def _failures_log(self) -> Path:
        return self._driver_logs / "service-failures.log"

    def _record_log_baseline(self) -> None:
        """Record where the shared logs end now, so this driver reads only what comes after.
        ``watcher.log`` and ``service-bootstrap.log`` belong to the machine, and an earlier
        test, or a run of the service before this one, has written to them."""
        for path in (self.watcher_log, self.bootstrap_log):
            try:
                self._log_baseline[path] = path.stat().st_size
            except OSError:
                self._log_baseline[path] = 0

    # -- one-shot commands -------------------------------------------------

    def process_environment(self) -> dict[str, str]:
        """The environment of one-shot commands: the suite's scrubbed copy of this process's,
        pointed at this test's profile and install."""
        env = drivers.clean_environment()
        env.update(drivers.uv_environment())
        env.update(self.tool_install.environment())
        profile = str(self.profile)
        env["USERPROFILE"] = profile
        env["HOME"] = profile
        env["APPDATA"] = str(self.profile / "AppData" / "Roaming")
        # The commands print characters (a check mark) that the console's code page lacks.
        env["PYTHONUTF8"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUNBUFFERED"] = "1"
        env["PATH"] = os.pathsep.join([str(self.tool_install.bin_dir), env.get("PATH", "")])
        env.update(self.extra_environment)
        return env

    def run_cli(
        self,
        *args: str,
        input: str | None = None,
        timeout: float = 120.0,
        global_args: Sequence[str] = (),
    ) -> CliResult:
        self.profile.mkdir(parents=True, exist_ok=True)
        command = [str(self.tool_install.executable), *global_args, *args]
        try:
            completed = subprocess.run(
                command,
                input=None if input is None else input.encode("utf-8"),
                capture_output=True,
                env=self.process_environment(),
                cwd=self.profile,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise TimeoutError(
                f"`data-hub-watcher {' '.join([*global_args, *args])}` did not finish in "
                f"{timeout:g} s.\nstdout:\n{_text(exc.stdout)}\nstderr:\n{_text(exc.stderr)}"
            ) from exc
        # Console output on Windows ends its lines with CRLF. The CLI driver's text mode turns
        # that into "\n", so scenarios shared by both drivers can match whole lines.
        return CliResult(
            args=tuple(args),
            returncode=completed.returncode,
            stdout=_lf(completed.stdout),
            stderr=_lf(completed.stderr),
        )

    def installed_version(self) -> str:
        return self.tool_install.version()

    def install_wheel(self, wheel: Path) -> None:
        if not self.owns_install:
            raise RuntimeError(
                "install_wheel changes the install of this PC, which is the one every test "
                "shares: ask the factory for `own_install=True`"
            )
        if self.is_running():
            raise RuntimeError("Stop the service before its install is replaced")
        self._wait_for_process_exit()
        drivers.install_watcher_tool(
            self.tool_install.root,
            wheel,
            python=self.tool_install.python,
            extras=self.install_extras,
            reinstall=True,
        )

    def service_path(self) -> str:
        """The ``PATH`` the service gets: the directory of ``uv`` (which a service, with no
        user PATH, would not find, and which the updater needs), then ``System32``."""
        uv_dir = Path(drivers.uv_executable()).parent
        return os.pathsep.join(
            [str(uv_dir), str(self.system_root / "System32"), str(self.system_root)]
        )

    def hide_uv(self) -> None:
        """Leave the service no way to find ``uv``: ``PATH`` is ``System32`` alone, and the
        places ``self_update`` looks next (``<home>\\.local\\bin\\uv.exe`` for the service
        account's profile, and the one beside a default-layout install) are checked to be empty.
        This install lives in a folder of the suite's, so only the profile of ``LocalSystem``
        is left, and if someone put a ``uv`` there it is reported, not moved."""
        system32 = self.system_root / "System32"
        profile = system32 / "config" / "systemprofile"
        found = [path for path in self._uv_candidates_for(profile) if path.exists()]
        if found:
            raise RuntimeError(
                "uv is installed where the service would still find it: "
                + ", ".join(str(path) for path in found)
            )
        self.write_env(overrides={"PATH": str(system32)})

    def _uv_candidates_for(self, home: Path) -> list[Path]:
        """Where ``self_update`` looks for ``uv`` for a process whose profile is ``home``."""
        prefix = str(self.tool_install.tool_dir / "data-hub-watcher")
        saved = {name: os.environ.get(name) for name in ("USERPROFILE", "HOME")}
        try:
            os.environ["USERPROFILE"] = str(home)
            os.environ["HOME"] = str(home)
            return self_update._sys_prefix_uv_candidates(prefix)
        finally:
            for name, value in saved.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

    def write_config(self, config: WatcherConfig) -> Path:
        self._last_good_config = config
        return super().write_config(config)

    # -- installing and removing the service ---------------------------------

    def install_service(self, *, failure_actions: FailureActionsMode = "off") -> CliResult:
        """``data-hub-watcher service install`` with this PC's config and env file.

        Any service already on the machine (another PC's, or one an earlier run left) is
        removed first, since there is one per machine. With ``failure_actions="off"``, the
        default, the SCM's recovery actions are then taken away (see the module docstring).
        ``"product"`` leaves the 60 s and 120 s restarts the installer configures.
        """
        if not self.config_path.exists() and self._last_good_config is None:
            raise RuntimeError(
                f"No config at {self.config_path}: write one (or run `init`) before the service "
                "is installed"
            )
        self._ensure_service_path()
        self._remove_installed_service()
        with self._installable_config():
            result = self.run_cli(
                "service",
                "install",
                "--env-path",
                str(self.env_path),
                global_args=("--config", str(self.config_path)),
            )
        if result.returncode != 0:
            raise RuntimeError(f"`service install` failed:\n{result.output}")
        # This driver owns the service from here on, so that `close()` removes it even if the
        # next command fails.
        self._take_ownership()
        if failure_actions == "off":
            self.host.disable_failure_actions()
        return result

    def _take_ownership(self) -> None:
        previous = WindowsServiceDriver._owner
        if previous is not None and previous is not self:
            previous._installed = False
        WindowsServiceDriver._owner = self
        self._installed = True

    def _owns_service(self) -> bool:
        """Whether the service on this machine is this PC's (the one it installed last)."""
        return WindowsServiceDriver._owner is self

    def _require_ownership(self, action: str) -> None:
        if not self._owns_service():
            raise RuntimeError(
                f"Can't {action}: the service is no longer this PC's (another PC installed it, "
                "or this one never did), and it would act on that PC's service"
            )

    @contextlib.contextmanager
    def _installable_config(self) -> Iterator[None]:
        """Make sure the config at ``config_path`` loads while ``service install`` reads it.

        ``service install`` loads the config, so it can't register a service for one that is
        missing or broken. A scenario that starts a PC with a broken config (the service must
        refuse it) means a PC whose service was installed while the config was fine, so the
        driver puts the last good config in place for the length of the install and then puts
        back what was there.
        """
        try:
            load_config(self.config_path)
        except Exception:
            if self._last_good_config is None:
                raise RuntimeError(
                    f"The config at {self.config_path} doesn't load, and none was written "
                    "through the driver that the service could be installed with"
                ) from None
            original = self.config_path.read_bytes() if self.config_path.exists() else None
            self.write_config(self._last_good_config)
            try:
                yield
            finally:
                if original is None:
                    self.config_path.unlink(missing_ok=True)
                else:
                    self.config_path.write_bytes(original)
        else:
            yield

    def _ensure_service_path(self) -> None:
        """Put a ``PATH`` in the env file, unless it has one (``hide_uv`` writes its own)."""
        if self.env_path.exists():
            for line in self.env_path.read_text(encoding="utf-8").splitlines():
                if line.split("=", 1)[0].strip().upper() == "PATH":
                    return
        self.write_env(overrides={"PATH": self.service_path()})

    def _ensure_installed(self) -> None:
        if self._installed and self._owns_service() and self.host.status() is not None:
            return
        self.install_service()

    def _remove_installed_service(self) -> None:
        """Remove whatever service is on the machine, and wait until the SCM has forgotten it.
        Nothing happens when there is none.

        The order matters. Recovery goes first, so that killing the service can't make the SCM
        start it again. Then the upgrade task and any worker end: a worker's last step is
        ``Start-Service``, which would start the service the next test installs. Then the service
        stops (and is killed if it won't), and ``service uninstall`` removes it, its registry
        values and the worker's script, and the wait runs until the SCM has really let go.
        """
        status = self.host.status()
        if status is not None:
            with contextlib.suppress(ScError):
                self.host.disable_failure_actions()
        self._end_upgrade_worker(service_present=status is not None)
        if status is not None:
            self._stop_service(_CLOSE_GRACE_SECONDS)
            # The CLI's own uninstall removes the worker script, the task and the registry
            # values before it removes the service. `sc delete` is the fallback for a service
            # whose uninstall fails.
            result = self.run_cli("service", "uninstall")
            if result.returncode != 0 and self.host.status() is not None:
                self.host.delete()
        with contextlib.suppress(Exception):
            if self.host.task_exists():
                self.host.delete_task()
        self.wait_for_removal(_REMOVE_TIMEOUT_SECONDS)

    def _end_upgrade_worker(self, *, service_present: bool) -> None:
        """End the upgrade task (``schtasks /End`` is part of deleting it) and any process of a
        worker, best effort. Looking for processes takes a PowerShell start, so it is done only
        when a worker has run: it writes ``upgrade-worker.log`` as its first step."""
        if not service_present and not self._task_exists():
            return
        with contextlib.suppress(Exception):
            self.host.delete_task()
        if self._worker_may_have_run():
            with contextlib.suppress(Exception):
                self.host.kill_upgrade_workers()

    def _task_exists(self) -> bool:
        try:
            return self.host.task_exists()
        except Exception:
            return False

    def _worker_may_have_run(self) -> bool:
        """Whether this PC's, or the owner's, upgrade worker has written its log."""
        owner = WindowsServiceDriver._owner
        logs = {self.worker_log}
        if owner is not None:
            logs.add(owner.worker_log)
        return any(path.exists() for path in logs)

    def _stop_service(self, grace: float) -> None:
        """Stop the service and wait up to ``grace`` seconds for ``STOPPED``, then kill it.

        Only a running service takes a stop. One that is stopping (``STOP_PENDING``) is waited
        for, and one that is still starting (``START_PENDING``) is waited for and asked again
        once it runs: ``sc stop`` answers those two with an error and does nothing.
        """
        deadline = time.monotonic() + grace
        while True:
            status = self.host.status()
            if status is None or status.state is ServiceState.STOPPED:
                return
            if status.state is ServiceState.RUNNING:
                self.host.stop()
            if time.monotonic() >= deadline:
                break
            time.sleep(0.25)
        latest = self.host.status()
        if latest is not None and latest.state is not ServiceState.STOPPED:
            if latest.pid:
                self._kill_process_tree(latest.pid)
            self._wait_for_state(ServiceState.STOPPED, 30.0)

    def _kill_process_tree(self, pid: int) -> None:
        """``taskkill /F /T`` of the service's process. ``/T`` can report a failure when a child
        of the tree ends while it is being killed, so a failure is an error only if the service
        is still not stopped a moment later."""
        try:
            self.host.kill_tree(pid)
        except ScError as error:

            def stopped() -> bool:
                status = self.host.status()
                return status is None or status.state is ServiceState.STOPPED

            try:
                wait_until(
                    stopped,
                    _TASKKILL_SETTLE_SECONDS,
                    what="the service to be stopped after a failed taskkill",
                )
            except WaitTimeout:
                raise error from None

    def _wait_for_process_exit(self) -> None:
        """Wait until the process of the last start is gone. The SCM says ``STOPPED`` when the
        service reports it, which can be a moment before the process lets go of its files
        (``Scripts\\python.exe``, which a reinstall replaces): the upgrade worker sleeps for the
        same reason."""
        pid = self._baseline_pid
        if pid is None:
            return
        wait_until(
            lambda: not self.host.process_running(pid),
            _PROCESS_EXIT_SECONDS,
            what=f"process {pid} of the stopped service to exit",
            interval=0.5,
        )

    def wait_for_removal(self, timeout: float = 30.0) -> None:
        """Wait until the SCM no longer knows the service (``sc queryex`` says error 1060).
        ``DeleteService`` only marks it, and ``CreateService`` fails with 1072 until the
        marked service is gone, which takes every handle to it and its process ending. So a
        service that still runs is asked to stop while this waits, and killed if it won't."""
        started = time.monotonic()

        def gone() -> bool:
            status = self.host.status()
            if status is None:
                return True
            if status.state is ServiceState.RUNNING:
                self.host.stop()
            elif (
                status.state is not ServiceState.STOPPED
                and status.pid
                and time.monotonic() - started >= _CLOSE_GRACE_SECONDS
            ):
                self._kill_process_tree(status.pid)
            return False

        wait_until(
            gone,
            timeout,
            lambda: f"service: {self.host.status()}",
            what="the SCM to forget the service",
            interval=0.5,
        )

    def reinstall_service(
        self,
        *,
        failure_actions: FailureActionsMode = "off",
        wait_ready: bool = True,
        poll_seconds: float = 0.1,
    ) -> CliResult:
        """``data-hub-watcher service reinstall``: stop, uninstall, install and start, in one
        command. It starts the service, so it is a start of this driver.

        The command configures the SCM's recovery as it installs and starts the service a moment
        later, with no stop in between. With ``failure_actions="off"`` a thread turns the
        recovery off as soon as the install has set it (every ``poll_seconds``), so that a
        service that fails at once isn't restarted by the SCM. If it loses the race, the
        recovery is turned off when the command returns, as after any install.
        """
        self._ensure_service_path()
        self._begin_run()
        with self._recovery_off_once_set(failure_actions == "off", poll_seconds):
            result = self.run_cli(
                "service",
                "reinstall",
                "--env-path",
                str(self.env_path),
                global_args=("--config", str(self.config_path)),
                timeout=300.0,
            )
        if result.returncode != 0:
            raise RuntimeError(f"`service reinstall` failed:\n{result.output}")
        self._take_ownership()
        if failure_actions == "off":
            self.host.disable_failure_actions()
        self._baseline_pid = self._wait_for_pid()
        if wait_ready:
            self.wait_until_ready()
        return result

    @contextlib.contextmanager
    def _recovery_off_once_set(self, enabled: bool, poll_seconds: float) -> Iterator[None]:
        """While the block runs, take the recovery actions away as soon as a service has them
        (the install of a ``service reinstall`` sets them, and the start follows). Best effort."""
        if not enabled:
            yield
            return
        done = threading.Event()

        def watch() -> None:
            while not done.is_set():
                try:
                    actions = self.host.failure_action_list()
                    if actions and any(kind != "none" for kind, _ in actions):
                        self.host.disable_failure_actions()
                        return
                except Exception:
                    pass  # No service yet, or it is being replaced.
                done.wait(poll_seconds)

        thread = threading.Thread(target=watch, name="recovery-off", daemon=True)
        thread.start()
        try:
            yield
        finally:
            done.set()
            thread.join(timeout=10)

    # -- the process --------------------------------------------------------

    def _begin_run(self) -> None:
        self._closed = False
        self._run_count += 1
        self._start_mark = self.mark_logs()
        self._runs_since_mark = 1
        self._started_at = time.monotonic()
        self.ended_at = None

    def start(
        self,
        *,
        wait_ready: bool = True,
        args: Sequence[str] = (),
        global_args: Sequence[str] = (),
    ) -> None:
        """``data-hub-watcher service start``, installing the service first if this driver has
        not. A service takes no ``watch`` arguments and no group options."""
        if args or global_args:
            raise NotImplementedError(
                "The service runs `watch` with no arguments: a scenario that passes "
                f"{[*global_args, *args]} is for the CLI driver"
            )
        if self._owns_service() and self.is_running():
            raise RuntimeError("The service is already running")
        self._ensure_installed()
        self._begin_run()
        result = self.run_cli("service", "start")
        if result.returncode != 0:
            raise RuntimeError(f"`service start` failed:\n{result.output}\n{self.log_tail()}")
        self._baseline_pid = self._wait_for_pid()
        if wait_ready:
            self.wait_until_ready()

    def _wait_for_pid(self, timeout: float = 30.0) -> int | None:
        """The pid of the process the SCM started, or ``None`` if the service has ended
        already."""

        def found() -> int | bool:
            status = self.host.status()
            if status is not None and status.pid:
                return status.pid
            return self._has_ended(status)

        try:
            value = wait_until(found, timeout, self.log_tail, what="the SCM to start the service")
        except WaitTimeout:
            return None
        return value if isinstance(value, int) and not isinstance(value, bool) else None

    def _grace_over(self) -> bool:
        return time.monotonic() - self._started_at >= _START_GRACE_SECONDS

    def _has_ended(self, status: ServiceStatus | None) -> bool:
        """Whether the service is gone, or stopped after it began (it has logged its first
        line, or the grace period after the start has passed)."""
        if status is None:
            return True
        if status.state is not ServiceState.STOPPED:
            return False
        ended = self._log_events(self._runs_since_mark or 1)[0] or self._grace_over()
        if ended and self.ended_at is None:
            self.ended_at = time.monotonic()
        return ended

    def _log_events(self, nth: int) -> tuple[bool, bool]:
        """``(the nth start has logged its first line, it has logged that it is ready)``, from
        the log since the last mark."""
        text = self.log_text(self._start_mark)
        starts = [match.start() for match in START_LINE.finditer(text)]
        if len(starts) < nth:
            return False, False
        return True, READY_LINE.search(text, starts[nth - 1]) is not None

    def wait_until_ready(self, timeout: float = 120.0) -> None:
        """Wait until the service says it is running or waiting, or has ended.

        The SCM reports ``RUNNING`` as soon as the process is up, before the watcher has
        started, so what ends the wait is the line the service logs when it has finished
        starting (after the start-up scan, as the CLI's "Press Ctrl+C to stop."), or the
        service having stopped after it began (a refused start).
        """
        nth = self._runs_since_mark or 1

        def ready() -> bool:
            return self._log_events(nth)[1] or self._has_ended(self.host.status())

        wait_until(
            ready, timeout, self.log_tail, what="the service to finish starting", interval=0.25
        )
        self._capture_failures()

    def request_stop(self) -> None:
        """``data-hub-watcher service stop``: the SCM asks the service to stop, and this returns
        without waiting.

        A service that is already stopping takes no second stop (the command fails with 1061),
        which is not an error here, and one that is still starting takes none yet (1052), so
        the stop is asked again once it runs.
        """
        self._require_ownership("stop")
        deadline = time.monotonic() + 30.0
        while True:
            result = self.run_cli("service", "stop")
            if result.returncode == 0:
                return
            status = self.host.status()
            if status is None or status.state in (ServiceState.STOPPED, ServiceState.STOP_PENDING):
                return
            # Still starting, or running by now: ask again (the service may have been in
            # START_PENDING when the first stop was refused).
            if (
                status.state in (ServiceState.START_PENDING, ServiceState.RUNNING)
                and time.monotonic() < deadline
            ):
                time.sleep(0.5)
                continue
            raise RuntimeError(f"`service stop` failed:\n{result.output}")

    def interrupt(self) -> None:
        raise NotImplementedError("A Windows service has no Ctrl+C: this scenario is CLI only")

    def kill(self) -> None:
        """End the process with ``taskkill /F /T`` and wait until the SCM says it stopped. With
        the recovery actions on, the SCM then restarts it after 60 s, as for any crash."""
        self._require_ownership("kill")
        status = self.host.status()
        if status is None or status.state is ServiceState.STOPPED:
            return
        pid = status.pid
        if pid is None:
            pid = self._wait_for_pid(10.0)
        if pid is not None:
            self._kill_process_tree(pid)
        self._wait_for_state(ServiceState.STOPPED, 30.0)

    def _wait_for_state(self, state: ServiceState, timeout: float) -> ServiceStatus:
        def reached() -> ServiceStatus | None:
            status = self.host.status()
            return status if status is not None and status.state is state else None

        return wait_until(
            reached, timeout, self.log_tail, what=f"the service to be {state.name}", interval=0.25
        )

    def wait_for_state(self, state: ServiceState, timeout: float = 30.0) -> ServiceStatus:
        """Wait until the SCM shows the service in ``state`` and return its status."""
        return self._wait_for_state(state, timeout)

    def wait_exit(self, timeout: float = 30.0) -> int:
        self._require_ownership("wait for the service to exit")
        status = self._wait_for_state(ServiceState.STOPPED, timeout)
        self._capture_failures()
        return 0 if status.exit_code is None else status.exit_code

    def start_lines(self) -> int:
        """How many times the service has logged that it is starting since this driver's last
        start (each process logs it once, whatever its pid)."""
        return len(START_LINE.findall(self.log_text(self._start_mark)))

    def wait_for_new_process(
        self, previous_pid: int | None, timeout: float = 120.0, *, after_starts: int | None = None
    ) -> ServiceStatus:
        """Wait until the service is ``RUNNING`` in a process other than the one with
        ``previous_pid``: the SCM has started it again (a recovery action, or the upgrade
        worker's ``Start-Service``).

        Windows hands a pid out again, so a restarted process can have the pid of the one before.
        With ``after_starts``, the number of start lines the log had (:meth:`start_lines`), a
        start line beyond that count shows a new process as well.
        """

        def restarted() -> ServiceStatus | None:
            status = self.host.status()
            if status is None or status.state is not ServiceState.RUNNING or not status.pid:
                return None
            if status.pid != previous_pid:
                return status
            if after_starts is not None and self.start_lines() > after_starts:
                return status
            return None

        return wait_until(
            restarted,
            timeout,
            self.log_tail,
            what=f"the service to run again with a pid other than {previous_pid}",
            interval=0.5,
        )

    def await_upgrade_restart(self, timeout: float) -> None:
        """Wait for the upgrade worker's ``Stop-Service``, ``uv tool install`` and
        ``Start-Service``: the service is ``RUNNING`` in a new process, and has logged that it is
        ready. Never starts the service: the worker does."""
        if self._baseline_pid is None:
            raise RuntimeError("await_upgrade_restart needs a service that was started first")
        status = self.wait_for_new_process(
            self._baseline_pid, timeout, after_starts=self._runs_since_mark
        )
        self._baseline_pid = status.pid
        self._runs_since_mark += 1
        nth = self._runs_since_mark
        wait_until(
            lambda: self._log_events(nth)[1],
            120.0,
            self.log_tail,
            what="the upgraded service to finish starting",
            interval=0.25,
        )

    def is_running(self) -> bool:
        """Whether this PC's service is running. A PC that does not own the service (another PC
        installed it, or this one never did) has none."""
        if not self._owns_service():
            return False
        status = self.host.status()
        return status is not None and status.state is not ServiceState.STOPPED

    @property
    def pid(self) -> int | None:
        if not self._owns_service():
            return None
        status = self.host.status()
        if status is None or status.state is ServiceState.STOPPED:
            return None
        return status.pid

    @property
    def exit_code(self) -> int | None:
        if self._run_count == 0 or not self._owns_service():
            return None
        status = self.host.status()
        if status is None or status.state is not ServiceState.STOPPED:
            return None
        return status.exit_code

    def service_status(self) -> ServiceStatus | None:
        """The SCM's view of the service now (``None`` if it is not installed)."""
        return self.host.status()

    def registered_paths(self) -> tuple[Path, Path]:
        """``(ConfigPath, EnvPath)`` from the service's registry key."""
        values = self.host.registry_values()
        return Path(values["ConfigPath"]), Path(values["EnvPath"])

    # -- logs ----------------------------------------------------------------

    def _log_text_files(self) -> list[Path]:
        # watcher.log has every line the service logs (the Event Log copy is not read here, so
        # nothing repeats); the bootstrap log, the worker's log and the failures the service
        # host reported only to the Event Log are the rest.
        paths = [self.watcher_log, self.bootstrap_log, self.worker_log, self._failures_log]
        return [path for path in paths if path.exists()]

    def _read_log(self, path: Path, since: Mapping[Path, int]) -> str:
        # The machine-wide log can be large: read from the position, not the whole file.
        start = since.get(path, self._log_baseline.get(path, 0))
        try:
            with path.open("rb") as handle:
                size = handle.seek(0, os.SEEK_END)
                if start > size:
                    start = 0  # Rotated or replaced since the position was taken.
                handle.seek(start)
                return handle.read().decode("utf-8", errors="replace")
        except OSError:
            return ""

    def watcher_log_text(self, since: LogMark | None = None) -> str:
        """Only what the service wrote to ``watcher.log`` (from the driver's creation, or from
        ``since``), without the bootstrap log, the worker's log and the Event Log entries that
        :meth:`log_text` adds. For a scenario about what reaches the file an operator reads."""
        offsets = dict(since.offsets) if since is not None else {}
        return self._read_log(self.watcher_log, offsets)

    def upgrade_files(self) -> list[Path]:
        """The upgrade worker's script and the sentinels that exist now, all in the config
        directory: ``upgrade-worker.ps1``, ``.upgrade-in-progress``, ``.upgrade-request.json``
        and ``.upgrade-result.json``."""
        candidates = [
            self.worker_script,
            self.config_dir() / UPGRADE_MARKER_FILENAME,
            self.config_dir() / UPGRADE_REQUEST_FILENAME,
            self.config_dir() / UPGRADE_RESULT_FILENAME,
        ]
        return [path for path in candidates if path.exists()]

    def log_files(self) -> list[Path]:
        """Everything for the failure artifacts: ``watcher.log`` whole (it is the machine's),
        the bootstrap log, the worker's log, the worker's script and the upgrade sentinels, and
        an Event Log export."""
        files = [*self._log_text_files(), *self.upgrade_files()]
        exported = self.export_event_log()
        if exported is not None:
            files.append(exported)
        return files

    def event_log_entries(self, *, include_system: bool = True) -> list[EventLogEntry]:
        """The service's entries in the Windows Event Log since this driver was created: the
        Application log's, and with ``include_system`` the SCM's in the System log."""
        return self.host.event_log(self._created_at, include_system=include_system)

    def export_event_log(self) -> Path | None:
        """Write the Event Log entries about the service to ``event-log.txt`` in the driver's
        folder and return its path, or ``None`` if they can't be read."""
        try:
            entries = self.event_log_entries()
        except Exception:
            return None
        path = self._driver_logs / "event-log.txt"
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(format_event_entries(entries), encoding="utf-8")
        except OSError:
            return None
        return path

    def _capture_failures(self) -> None:
        """After a run that ended badly, copy what the service host reported to the Event Log
        about its failure into a file :meth:`log_text` reads.

        An exception that nothing catches in the service (a config that doesn't load raises
        ``ClickException`` outside any ``try``) is not in ``watcher.log``: pywin32 reports its
        traceback to the Event Log, in an entry that says ``The instance's SvcRun() method
        failed``. That entry is the only one copied. The service's own log lines (including
        ``logger.exception`` tracebacks) reach the Event Log too, and ``watcher.log`` has them
        already, so copying them would show them twice. A scenario that wants the message finds
        it in the log text.
        """
        status = self.host.status()
        if status is None or status.state is not ServiceState.STOPPED:
            return
        if status.exit_code in (None, 0):
            return
        try:
            entries = self.event_log_entries(include_system=False)
        except Exception:
            return
        fresh = [
            entry
            for entry in entries
            if entry.record_id not in self._captured_event_ids
            and SVCRUN_FAILED_TEXT in entry.message
        ]
        if not fresh:
            return
        self._captured_event_ids.update(entry.record_id for entry in fresh)
        self._driver_logs.mkdir(parents=True, exist_ok=True)
        with self._failures_log.open("a", encoding="utf-8") as handle:
            handle.write(format_event_entries(fresh) + "\n")

    # -- the end -------------------------------------------------------------

    def close(self) -> None:
        """Stop the service and remove it, if this driver is the one that installed it last.
        Safe to call twice. The profile is left where it is: the failure artifacts are copied
        from it after the test's fixtures have closed, and it is a test's own folder."""
        if self._closed:
            return
        self._closed = True
        if WindowsServiceDriver._owner is self:
            try:
                self._remove_installed_service()
            finally:
                WindowsServiceDriver._owner = None
        self._installed = False


def _lf(data: bytes) -> str:
    return data.decode("utf-8", errors="replace").replace("\r\n", "\n")


def _text(data: bytes | str | None) -> str:
    if data is None:
        return ""
    return data if isinstance(data, str) else data.decode(errors="replace")
