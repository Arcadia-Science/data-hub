"""Drivers: how a scenario starts, stops, kills and inspects the watcher.

A scenario never starts a process or sends a signal itself. It asks a ``WatcherDriver``, so
the same scenario file runs against a ``data-hub-watcher watch`` process on Linux (and
macOS) and, later, against the real Windows service. This module holds the interface, the
shared parts, and ``CliDriver``, the POSIX implementation.

The seam for the Windows service
--------------------------------

A ``WindowsServiceDriver`` subclasses :class:`WatcherDriver` and fills in the abstract
methods. The mapping, for whoever writes it:

========================  =============================================================
Driver method             Windows service
========================  =============================================================
``install``               ``uv tool install "<wheel>[windows-service]"`` into the default
                          tool directory, then ``service install``
``run_cli``               the same ``data-hub-watcher`` executable, run elevated
``start``                 ``service start``, then wait for the SCM to say ``running``
``request_stop``          ``service stop`` (``SvcStop``), without waiting
``interrupt``             not supported: ``supports_interrupt`` is false
``kill``                  ``taskkill /F /PID`` of the pid ``service status`` reports
``wait_exit``             wait for the SCM state ``stopped``; the exit code is the
                          service's win32 exit code (1 after an upgrade restart)
``is_running``           the SCM state is ``running`` or a ``*_pending`` one
``logs``                  ``C:\\ProgramData\\DataHubWatcher\\watcher.log``,
                          ``service-bootstrap.log`` and ``upgrade-worker.log``
``state_db_path``         beside the config file in the registry (``ConfigPath``)
``config_dir``            the directory of that config file
``close``                 ``service uninstall``, then wait for the service to be removed
========================  =============================================================

The fault proxy, the server and every assertion are the same on both platforms. A scenario
that needs something only one platform has (a signal, an SCM recovery action) says so with
``driver.platform`` or ``driver.supports_interrupt`` and skips on the other.

``platform`` names the *kind* of driver: ``"linux"`` is a CLI process on any POSIX system,
macOS included, and ``"windows"`` is the service.
"""

from __future__ import annotations
import contextlib
import functools
import os
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
from abc import ABC, abstractmethod
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import IntEnum
from pathlib import Path
from typing import Any, ClassVar, Literal

from data_hub_watcher import testing_overrides
from data_hub_watcher.config_io import load_config, save_config
from data_hub_watcher.constants import RUN_DETECTION_PRESETS
from data_hub_watcher.models import WatcherConfig
from e2e_support.admin import revision_settings
from e2e_support.waiting import WaitTimeout, wait_until

__all__ = [
    "DEFAULT_ENVIRONMENT",
    "DEFAULT_TIMER_OVERRIDES",
    "CliDriver",
    "CliResult",
    "InitAnswers",
    "NewInstrument",
    "PlatformName",
    "RunDetection",
    "ToolInstall",
    "WatcherDriver",
    "install_watcher_tool",
]

PlatformName = Literal["linux", "windows"]

# `production` makes the first scan upload files that are already in the watch folder, and
# the config sets `initial_scan` explicitly anyway.
DEFAULT_ENVIRONMENT = "production"

# The watcher's own timers are minutes long. These shrink them (see "Test-only overrides" in
# docs/developer/watcher.md). Heartbeats and queue polls every 2 seconds, an update check
# every 5th heartbeat, and 2 quiet heartbeats before an idle-gated update.
DEFAULT_TIMER_OVERRIDES: dict[str, str] = {
    testing_overrides.HEARTBEAT_INTERVAL_ENV_VAR: "2",
    testing_overrides.UPLOAD_POLL_INTERVAL_ENV_VAR: "2",
    testing_overrides.UPDATE_CHECK_INTERVAL_TICKS_ENV_VAR: "5",
    testing_overrides.UPDATE_IDLE_TICKS_ENV_VAR: "2",
}

# Python 3.12 is what lab PCs and the Lambda image run.
DEFAULT_PYTHON = "3.12"

# Variables the watcher process must not inherit from the developer's shell, which would
# change which interpreter, key or config it uses.
_SCRUBBED_ENV = frozenset(
    {"VIRTUAL_ENV", "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "UV_PROJECT_ENVIRONMENT"}
)

_INSTALL_TIMEOUT_SECONDS = 900

# What `watch` prints right before it installs its signal handlers.
READY_LINE = "Press Ctrl+C to stop."


# ---------------------------------------------------------------------------
# uv and the tool install
# ---------------------------------------------------------------------------


def uv_executable() -> str:
    """The ``uv`` program, which the suite needs for the install and for self-update."""
    path = shutil.which("uv")
    if path is None:
        raise RuntimeError("The end-to-end suite needs `uv` on the PATH.")
    return path


def clean_environment(base: Mapping[str, str] | None = None) -> dict[str, str]:
    """``base`` (default: this process's environment) without what would leak into the watcher:
    every ``DATA_HUB_*`` variable and the interpreter-selecting ones."""
    source = os.environ if base is None else base
    return {
        k: v for k, v in source.items() if not k.startswith("DATA_HUB_") and k not in _SCRUBBED_ENV
    }


@functools.cache
def _real_uv_dirs() -> tuple[str, str]:
    """``(cache dir, python install dir)`` of the real user, looked up once.

    Each test gives the watcher a fresh ``HOME``, and uv derives both folders from it. Left
    alone, every install would download Python and every dependency again, so they stay
    pinned to the real ones.
    """
    env = clean_environment()

    def ask(*args: str, variable: str) -> str:
        if env.get(variable):
            return env[variable]
        result = subprocess.run(
            [uv_executable(), *args],
            capture_output=True,
            text=True,
            check=True,
            env=env,
            timeout=60,
        )
        return result.stdout.strip()

    return (
        ask("cache", "dir", variable="UV_CACHE_DIR"),
        ask("python", "dir", variable="UV_PYTHON_INSTALL_DIR"),
    )


def uv_environment() -> dict[str, str]:
    """Variables that keep uv on the real cache and Python downloads under an isolated HOME."""
    cache_dir, python_dir = _real_uv_dirs()
    return {
        "UV_CACHE_DIR": cache_dir,
        "UV_PYTHON_INSTALL_DIR": python_dir,
        "UV_NO_PROGRESS": "1",
    }


@dataclass(frozen=True)
class ToolInstall:
    """A ``uv tool install`` of the watcher, in its own tool and bin directories.

    ``root`` holds ``uv/tools`` and ``uv/bin``. The tool's virtual environment is
    ``<root>/uv/tools/data-hub-watcher``: a path with ``/uv/tools/data-hub-watcher`` in it is
    how the watcher recognises a uv-tool install (``detect_install_method``), which is the
    only kind it will update itself in. A watcher that updates itself reinstalls into this
    same directory, so a scenario that updates needs its own install.
    """

    root: Path
    python: str = DEFAULT_PYTHON

    @property
    def tool_dir(self) -> Path:
        return self.root / "uv" / "tools"

    @property
    def bin_dir(self) -> Path:
        return self.root / "uv" / "bin"

    @property
    def executable(self) -> Path:
        name = "data-hub-watcher.exe" if sys.platform == "win32" else "data-hub-watcher"
        return self.bin_dir / name

    def environment(self) -> dict[str, str]:
        """The variables that point uv (and a self-updating watcher) at this install."""
        return {"UV_TOOL_DIR": str(self.tool_dir), "UV_TOOL_BIN_DIR": str(self.bin_dir)}

    def version(self) -> str:
        """The version ``data-hub-watcher --version`` prints, such as ``1.4.0``."""
        result = subprocess.run(
            [str(self.executable), "--version"],
            capture_output=True,
            text=True,
            check=True,
            env={**clean_environment(), **self.environment()},
            timeout=60,
        )
        match = re.search(r"(\d+\.\d+\.\d+\S*)\s*$", result.stdout.strip())
        if match is None:
            raise RuntimeError(f"Unexpected --version output: {result.stdout!r}")
        return match.group(1)


def install_watcher_tool(
    root: Path, wheel: Path, *, python: str = DEFAULT_PYTHON, extras: Sequence[str] = ()
) -> ToolInstall:
    """Install ``wheel`` with ``uv tool install`` under ``root`` and return the install.

    ``python`` is the interpreter the tool runs on. Dependencies come from PyPI, through
    uv's cache, so the first install of a session needs the network.
    """
    install = ToolInstall(root=Path(root), python=python)
    install.root.mkdir(parents=True, exist_ok=True)
    spec = str(wheel)
    if extras:
        spec = f"data-hub-watcher[{','.join(extras)}] @ {Path(wheel).resolve().as_uri()}"
    command = [uv_executable(), "tool", "install", "--python", python, spec]
    result = subprocess.run(
        command,
        cwd=install.root,
        env={**clean_environment(), **uv_environment(), **install.environment()},
        capture_output=True,
        text=True,
        timeout=_INSTALL_TIMEOUT_SECONDS,
        check=False,
    )
    if result.returncode != 0 or not install.executable.exists():
        raise RuntimeError(
            f"`{' '.join(command)}` failed (exit {result.returncode}).\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return install


# ---------------------------------------------------------------------------
# What `init` asks
# ---------------------------------------------------------------------------


class RunDetection(IntEnum):
    """The run-detection presets ``init`` offers, by their number in its menu."""

    FILENAME_PREFIX = 1
    TOP_SUBDIRECTORY = 2
    DEEPEST_SUBDIRECTORY = 3
    TIMESTAMP_SUBDIRECTORY = 4
    FILENAME_STEM = 5


@dataclass(frozen=True)
class NewInstrument:
    """Answer ``init``'s instrument menu with "Register a new instrument"."""

    id: str
    display_name: str | None = None  # None accepts the default, derived from the id


@dataclass(frozen=True)
class InitAnswers:
    """Everything a person types into ``data-hub-watcher init``, in the order it asks.

    :meth:`stdin_text` turns it into the lines to pipe in. ``None`` for an optional answer
    presses Enter, which takes the wizard's default. The wizard's prompts, in order:

    1. ``Config already exists ... Overwrite?`` (only when ``overwrite_config`` is set)
    2. ``Environment``, then ``Data Hub API base URL``
    3. ``Use the saved key?`` (only when ``use_saved_key`` is set, for a PC that already has
       a key for the environment), then ``DATA_HUB_API_KEY`` unless the saved key is used
    4. The instrument menu. ``instrument`` is the number of an existing instrument, or a
       :class:`NewInstrument`. ``existing_instruments`` says how many the menu lists: the
       menu is skipped when it is 0, and "register a new one" is the number after the last.
    5. ``Watch directory``, ``File patterns``, the run-detection menu (a preset number, or
       a custom regex), ``Watch subdirectories recursively?``, ``Stability period`` and
       ``Upload mode``
    """

    environment: str
    api_base_url: str
    api_key: str | None
    watch_directory: str | Path
    instrument: int | NewInstrument = 1
    existing_instruments: int = 1
    file_patterns: Sequence[str] | None = None
    run_detection: int | str = RunDetection.TOP_SUBDIRECTORY
    recursive: bool | None = None
    stability_period_seconds: int | None = None
    upload_mode: Literal["auto", "manual"] | None = None
    overwrite_config: bool | None = None
    use_saved_key: bool | None = None

    def stdin_text(self) -> str:
        """The answers, one per line, ready to pipe into ``init --show-key``."""

        def yes_no(value: bool | None) -> str:
            return "" if value is None else ("y" if value else "n")

        lines: list[str] = []
        if self.overwrite_config is not None:
            lines.append(yes_no(self.overwrite_config))
        lines += [self.environment, self.api_base_url]
        if self.use_saved_key is not None:
            lines.append(yes_no(self.use_saved_key))
        if self.use_saved_key is not True:
            if self.api_key is None:
                raise ValueError("api_key is needed unless the saved key is used")
            lines.append(self.api_key)
        if isinstance(self.instrument, NewInstrument):
            if self.existing_instruments > 0:
                lines.append(str(self.existing_instruments + 1))
            lines += [self.instrument.id, self.instrument.display_name or ""]
        else:
            lines.append(str(self.instrument))
        lines.append(str(self.watch_directory))
        lines.append(",".join(self.file_patterns) if self.file_patterns else "")
        if isinstance(self.run_detection, str):
            lines += [str(len(RUN_DETECTION_PRESETS) + 1), self.run_detection]
        else:
            lines.append(str(int(self.run_detection)))
        lines.append(yes_no(self.recursive))
        lines.append(
            "" if self.stability_period_seconds is None else str(self.stability_period_seconds)
        )
        lines.append(self.upload_mode or "")
        return "\n".join(lines) + "\n"


@dataclass(frozen=True)
class CliResult:
    """The outcome of a one-shot ``data-hub-watcher`` command."""

    args: tuple[str, ...]
    returncode: int
    stdout: str
    stderr: str

    @property
    def output(self) -> str:
        """Standard output followed by standard error."""
        return self.stdout + self.stderr


# ---------------------------------------------------------------------------
# The interface
# ---------------------------------------------------------------------------


class WatcherDriver(ABC):
    """One instrument PC with a watcher installed, as a scenario sees it.

    The constructor takes what the PC is registered as. Everything about the process lives
    in the abstract methods (see the module docstring for the Windows mapping). The rest is
    shared: writing ``config.yaml`` through ``save_config``, writing the env file, running
    the real ``init``, and waiting for something in a log.

    Attributes a scenario reads: ``instrument_id``, ``watch_dir`` (resolved), ``environment``,
    ``api_base_url`` (the fault proxy's address plus ``/api/v1``), ``api_key`` and
    ``watcher_id``.
    """

    platform: ClassVar[PlatformName]
    supports_interrupt: ClassVar[bool] = True

    def __init__(
        self,
        *,
        instrument_id: str,
        watch_dir: Path,
        environment: str = DEFAULT_ENVIRONMENT,
        api_base_url: str,
        api_key: str,
        watcher_id: str | None = None,
    ) -> None:
        self.instrument_id = instrument_id
        self.watch_dir = watch_dir
        self.environment = environment
        self.api_base_url = api_base_url
        self.api_key = api_key
        self._watcher_id = watcher_id

    # -- identity ---------------------------------------------------------

    @property
    def watcher_id(self) -> str:
        """The id the server gave this PC. Read from ``config.yaml`` after ``init`` makes it."""
        if self._watcher_id is None:
            self._watcher_id = self.load_config().watcher_id
        if self._watcher_id is None:
            raise RuntimeError("This watcher is not registered yet")
        return str(self._watcher_id)

    @watcher_id.setter
    def watcher_id(self, value: str) -> None:
        self._watcher_id = value

    # -- the process (abstract) ------------------------------------------

    @abstractmethod
    def install(self, wheel: Path) -> None:
        """Install the watcher from ``wheel`` for this driver, replacing any earlier install.

        The shared session install is handed to a driver at construction, so most scenarios
        never call this. A scenario that updates the watcher in place calls it, or is given
        a private install, so it doesn't change what the others run.
        """

    @abstractmethod
    def run_cli(self, *args: str, input: str | None = None, timeout: float = 120.0) -> CliResult:
        """Run a one-shot ``data-hub-watcher`` command, such as ``config validate`` or
        ``watch --dry-run``, to completion, as this PC's operator, and capture its output."""

    @abstractmethod
    def start(self, *, wait_ready: bool = True, args: Sequence[str] = ()) -> None:
        """Start the watcher. ``args`` are extra command-line arguments (``["--verbose"]``).

        With ``wait_ready`` (the default) this returns once the watcher is ready for a stop
        request, or has already exited, which is what a refused start does. A watcher that
        has not finished starting can't be stopped cleanly: on POSIX the signal handlers are
        installed only after the start-up scan, so a signal before then kills the process.
        Pass ``wait_ready=False`` for a scenario about that window, or about a start that
        takes a long time, and call :meth:`wait_until_ready` when it is over. Either way, wait
        for the server to show the watcher (``ServerView.wait_for_*``) before asserting on it.
        """

    @abstractmethod
    def wait_until_ready(self, timeout: float = 120.0) -> None:
        """Wait until the watcher is ready for a stop request, or has exited."""

    @abstractmethod
    def request_stop(self) -> None:
        """Ask the watcher to stop gracefully (SIGTERM, or the service's stop) and return
        without waiting. Follow it with :meth:`wait_exit`, or use :meth:`stop`."""

    @abstractmethod
    def interrupt(self) -> None:
        """Send the watcher an interrupt (SIGINT, as Ctrl+C does) and return without waiting.
        Only where ``supports_interrupt`` is true."""

    @abstractmethod
    def kill(self) -> None:
        """Kill the watcher without any chance to clean up (SIGKILL, ``taskkill /F``) and
        return once it is gone."""

    @abstractmethod
    def wait_exit(self, timeout: float = 30.0) -> int:
        """Wait for the watcher to exit and return its exit code (0 after a stop, 1 after an
        upgrade restart, ``-9`` after SIGKILL on POSIX). Raises ``WaitTimeout`` otherwise."""

    @abstractmethod
    def is_running(self) -> bool:
        """Whether the watcher process is alive."""

    @property
    @abstractmethod
    def exit_code(self) -> int | None:
        """The exit code of the last run, or ``None`` while it runs or before any start."""

    @abstractmethod
    def logs(self) -> list[Path]:
        """Every log file of the watcher, for failure artifacts and :meth:`log_text`."""

    @abstractmethod
    def state_db_path(self) -> Path:
        """The watcher's SQLite state database."""

    @abstractmethod
    def config_dir(self) -> Path:
        """The directory holding ``config.yaml``, the env file and the upgrade sentinels."""

    @abstractmethod
    def close(self) -> None:
        """Stop the watcher if it runs and remove what the driver installed. Safe to call twice."""

    # -- shared behaviour -------------------------------------------------

    def stop(self, timeout: float = 30.0) -> int:
        """Stop gracefully and return the exit code (0 for a clean stop)."""
        self.request_stop()
        return self.wait_exit(timeout)

    def restart(self, *, graceful: bool = True) -> None:
        """Stop the watcher if it runs, then start it again.

        This is also the supervisor: after an update the watcher exits with code 1 and
        expects something to start it again (the SCM's recovery action on Windows), and the
        driver stands in for it, so call ``restart()`` then.
        """
        if self.is_running():
            if graceful:
                self.stop()
            else:
                self.kill()
        self.start()

    @property
    def config_path(self) -> Path:
        return self.config_dir() / "config.yaml"

    @property
    def env_path(self) -> Path:
        return self.config_dir() / f".env.{self.environment}"

    def load_config(self) -> WatcherConfig:
        """``config.yaml`` as the watcher would load it."""
        return load_config(self.config_path)

    def write_config(self, config: WatcherConfig) -> Path:
        """Write ``config.yaml`` with the watcher's own ``save_config``, and return its path."""
        save_config(config, self.config_path)
        return self.config_path

    def write_config_text(self, text: str) -> Path:
        """Write ``config.yaml`` as raw text, for a broken or hand-edited file."""
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        self.config_path.write_text(text, encoding="utf-8")
        return self.config_path

    def write_env(
        self, api_key: str | None = None, overrides: Mapping[str, str | None] | None = None
    ) -> Path:
        """Write the env file the watcher loads: the API key and the override variables.

        Lines already in the file stay unless this call sets them: ``api_key=None`` keeps
        the key (``init`` saved it), and an override whose value is ``None`` is removed.
        Override variables (``DATA_HUB_WATCHER_*``, see ``DEFAULT_TIMER_OVERRIDES``) go here
        rather than into the process environment because the Windows service reads its
        registered env file, and because ``load_env`` lets this file win.
        """
        path = self.env_path
        path.parent.mkdir(parents=True, exist_ok=True)
        wanted: dict[str, str | None] = dict(overrides or {})
        if api_key is not None:
            wanted["DATA_HUB_API_KEY"] = api_key
        kept: list[str] = []
        if path.exists():
            for line in path.read_text(encoding="utf-8").splitlines():
                name = line.split("=", 1)[0].strip()
                if name not in wanted:
                    kept.append(line)
        for name, value in wanted.items():
            if value is None:
                continue
            kept.append(f"{name}='{value}'" if name == "DATA_HUB_API_KEY" else f"{name}={value}")
        path.write_text("\n".join(kept) + "\n", encoding="utf-8")
        return path

    def init_interactive(self, answers: InitAnswers, *, timeout: float = 120.0) -> CliResult:
        """Run the real ``data-hub-watcher init --show-key`` with ``answers`` piped to stdin.

        ``--show-key`` is there because the wizard hides the key as it is typed, which does
        not work on a pipe. The wizard registers the watcher, so on success ``watcher_id``
        reads the new id from the config it wrote.
        """
        self._watcher_id = None
        return self.run_cli("init", "--show-key", input=answers.stdin_text(), timeout=timeout)

    def revision_settings(self, **overrides: Any) -> dict[str, Any]:
        """The ``settings`` of a config revision equal to the config on this PC, with
        ``overrides`` applied to the top-level keys (``upload_mode="manual"``,
        ``file_patterns=["*.csv", "*.txt"]``, ``watch_directory=str(other)``)."""
        inst = self.load_config().instrument
        settings = revision_settings(
            inst.watch_directory,
            file_patterns=inst.file_patterns,
            run_pattern=inst.run_detection.pattern,
            recursive=inst.run_detection.recursive,
            upload_mode=inst.upload_mode,
            stability_period_seconds=inst.stability_period_seconds,
            max_stability_wait_seconds=inst.max_stability_wait_seconds,
            upload_parallelism=inst.upload_parallelism,
        )
        settings.update(overrides)
        return settings

    def state_query(self, sql: str, params: Sequence[Any] = ()) -> list[tuple[Any, ...]]:
        """Run a SELECT against the watcher's state database (``pending_uploads``,
        ``detected_files``, ``uploaded_files``, ``meta`` ...)."""
        path = self.state_db_path()
        if not path.exists():
            return []
        with contextlib.closing(sqlite3.connect(path, timeout=10)) as conn:
            return conn.execute(sql, tuple(params)).fetchall()

    def log_text(self) -> str:
        """The text of every log file, for matching and for a failure message."""
        parts: list[str] = []
        for path in self.logs():
            try:
                parts.append(
                    f"=== {path.name}\n{path.read_text(encoding='utf-8', errors='replace')}"
                )
            except OSError:
                continue
        return "\n".join(parts)

    def log_tail(self, lines: int = 40) -> str:
        """The last lines of each log file, for failure messages."""
        parts: list[str] = []
        for path in self.logs():
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            parts.append(f"=== {path.name}\n" + "\n".join(text.splitlines()[-lines:]))
        return "\n".join(parts)

    def wait_for_log(self, pattern: str, timeout: float = 30.0) -> str:
        """Wait until a log line matches the regular expression ``pattern`` and return the line.

        Prefer the server's view where there is one. Use this for what only the log shows,
        such as the initial scan finishing.
        """
        regex = re.compile(pattern)

        def found() -> str | None:
            for line in self.log_text().splitlines():
                if regex.search(line):
                    return line
            return None

        return wait_until(
            found, timeout, self.log_tail, what=f"a log line matching {pattern!r}", interval=0.25
        )


# ---------------------------------------------------------------------------
# The POSIX driver
# ---------------------------------------------------------------------------


class CliDriver(WatcherDriver):
    """Runs ``data-hub-watcher watch`` from a ``uv tool`` install, as a POSIX process.

    The process gets an isolated ``HOME`` (so ``~/.data-hub`` is ``<home>/.data-hub``), its
    own session (so a Ctrl+C in the terminal running pytest doesn't reach it), and
    stdout and stderr in files. It has no supervisor of its own: after an update it exits
    with code 1 and stays down until the test calls :meth:`restart`, which stands in for
    the SCM's recovery action.

    ``extra_environment`` adds variables to the process, after the scrubbed copy of this
    process's environment. Put override variables in the env file with ``write_env`` instead
    where they are meant for the watcher alone.
    """

    platform: ClassVar[PlatformName] = "linux"
    supports_interrupt: ClassVar[bool] = True

    def __init__(
        self,
        *,
        home: Path,
        tool_install: ToolInstall,
        instrument_id: str,
        watch_dir: Path,
        environment: str = DEFAULT_ENVIRONMENT,
        api_base_url: str,
        api_key: str,
        watcher_id: str | None = None,
        extra_environment: Mapping[str, str] | None = None,
    ) -> None:
        super().__init__(
            instrument_id=instrument_id,
            watch_dir=watch_dir,
            environment=environment,
            api_base_url=api_base_url,
            api_key=api_key,
            watcher_id=watcher_id,
        )
        self.home = home
        self.tool_install = tool_install
        self.extra_environment = dict(extra_environment or {})
        self._process: subprocess.Popen[bytes] | None = None
        self._run_count = 0
        self._log_dir = home / "driver-logs"

    # -- paths ------------------------------------------------------------

    def config_dir(self) -> Path:
        return self.home / ".data-hub"

    def state_db_path(self) -> Path:
        return self.config_dir() / f"watcher-{self.environment}.db"

    def logs(self) -> list[Path]:
        paths = [self.config_dir() / "watcher.log"]
        if self._log_dir.exists():
            paths += sorted(self._log_dir.glob("watch-*.std*.log"))
        return [p for p in paths if p.exists()]

    def process_environment(self) -> dict[str, str]:
        """The environment of the watcher process and of one-shot commands."""
        env = clean_environment()
        env.update(uv_environment())
        env.update(self.tool_install.environment())
        env["HOME"] = str(self.home)
        env["PYTHONUNBUFFERED"] = "1"
        env["PATH"] = os.pathsep.join([str(self.tool_install.bin_dir), env.get("PATH", "")])
        env.update(self.extra_environment)
        return env

    # -- install and one-shot commands -----------------------------------

    def install(self, wheel: Path) -> None:
        if self.is_running():
            raise RuntimeError("Stop the watcher before installing another build")
        self.tool_install = install_watcher_tool(
            self.home / "private-install", wheel, python=self.tool_install.python
        )

    def run_cli(self, *args: str, input: str | None = None, timeout: float = 120.0) -> CliResult:
        self.home.mkdir(parents=True, exist_ok=True)
        try:
            completed = subprocess.run(
                [str(self.tool_install.executable), *args],
                input=input,
                capture_output=True,
                text=True,
                env=self.process_environment(),
                cwd=self.home,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise TimeoutError(
                f"`data-hub-watcher {' '.join(args)}` did not finish in {timeout:g} s.\n"
                f"stdout:\n{_text(exc.stdout)}\nstderr:\n{_text(exc.stderr)}"
            ) from exc
        return CliResult(
            args=tuple(args),
            returncode=completed.returncode,
            stdout=completed.stdout,
            stderr=completed.stderr,
        )

    # -- the process ------------------------------------------------------

    def start(self, *, wait_ready: bool = True, args: Sequence[str] = ()) -> None:
        """Start ``data-hub-watcher watch``.

        Ready means the command has printed ``Press Ctrl+C to stop.``, which it does right
        before it installs its SIGINT and SIGTERM handlers, after the start-up scan.
        """
        if self.is_running():
            raise RuntimeError("The watcher is already running")
        self.home.mkdir(parents=True, exist_ok=True)
        self._log_dir.mkdir(parents=True, exist_ok=True)
        self._run_count += 1
        stem = self._log_dir / f"watch-{self._run_count}"
        with open(f"{stem}.stdout.log", "wb") as out, open(f"{stem}.stderr.log", "wb") as err:
            self._process = subprocess.Popen(
                [str(self.tool_install.executable), "watch", *args],
                cwd=self.home,
                env=self.process_environment(),
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=err,
                start_new_session=True,
            )
        if wait_ready:
            self.wait_until_ready()

    def wait_until_ready(self, timeout: float = 120.0) -> None:
        wait_until(
            lambda: not self.is_running() or READY_LINE in self.output(),
            timeout,
            self.log_tail,
            what="the watcher to finish starting",
        )

    def _require_process(self) -> subprocess.Popen[bytes]:
        if self._process is None:
            raise RuntimeError("The watcher has not been started")
        return self._process

    @property
    def pid(self) -> int:
        """The process id of the watcher, for a test that needs to look at the process."""
        return self._require_process().pid

    def request_stop(self) -> None:
        self._require_process().send_signal(signal.SIGTERM)

    def interrupt(self) -> None:
        self._require_process().send_signal(signal.SIGINT)

    def kill(self) -> None:
        process = self._require_process()
        process.kill()
        process.wait()

    def wait_exit(self, timeout: float = 30.0) -> int:
        process = self._require_process()
        try:
            return process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            raise WaitTimeout(
                f"The watcher (pid {process.pid}) was still running {timeout:g} s after it "
                f"was asked to stop.\n--- log tail ---\n{self.log_tail()}"
            ) from None

    def is_running(self) -> bool:
        return self._process is not None and self._process.poll() is None

    @property
    def exit_code(self) -> int | None:
        return None if self._process is None else self._process.poll()

    def output(self) -> str:
        """Standard output and error of the latest run."""
        if self._run_count == 0:
            return ""
        stem = self._log_dir / f"watch-{self._run_count}"
        return "".join(
            p.read_text(encoding="utf-8", errors="replace")
            for p in (Path(f"{stem}.stdout.log"), Path(f"{stem}.stderr.log"))
            if p.exists()
        )

    def close(self) -> None:
        process = self._process
        if process is None or process.poll() is not None:
            return
        # A graceful stop first, so the state database is closed cleanly, then the whole
        # process group, which also catches an update's `uv` child.
        with contextlib.suppress(ProcessLookupError):
            process.send_signal(signal.SIGTERM)
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        else:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(process.pid, signal.SIGKILL)


def _text(data: bytes | str | None) -> str:
    if data is None:
        return ""
    return data if isinstance(data, str) else data.decode(errors="replace")
