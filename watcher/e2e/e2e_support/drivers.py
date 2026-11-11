"""Drivers: how a scenario starts, stops, kills and inspects the watcher.

A scenario never starts a process or sends a signal itself. It asks a ``WatcherDriver``, so
the same scenario file runs against a ``data-hub-watcher watch`` process (on Linux, and on
macOS for a developer) and, in the next pull request, against the real Windows service. This
module holds the interface, the shared parts, and ``CliDriver``, the POSIX implementation.

Kinds of driver
---------------

``WatcherDriver.kind`` is ``"cli"`` (a ``watch`` process) or ``"service"`` (the Windows
service). It is what the transition catalog calls a platform: a test that only makes sense
for one kind says so with ``@pytest.mark.platforms("cli")``, and the suite's ``conftest.py``
skips it under the other. Which driver a run uses is ``$DATA_HUB_E2E_DRIVER`` (``cli`` unless
set). A scenario never checks the kind itself, and never reaches for anything that only one
driver has: it is given a ``WatcherDriver``, and a type checker refuses ``CliDriver``-only
attributes.

The wording of the watcher differs by role (``"Watcher started on ..."``, ``"Service started
on ..."``), so a scenario asks the driver for it: ``started_prefix``, ``resumed_prefix``,
``operator_stop_message`` and ``update_stop_message``.

The seam for the Windows service
--------------------------------

A ``WindowsServiceDriver`` subclasses :class:`WatcherDriver` and fills in the abstract
methods. The mapping, for whoever writes it:

==========================  ===========================================================
Driver method               Windows service
==========================  ===========================================================
``run_cli``                 the same ``data-hub-watcher`` executable, run elevated, in
                            the test's own user profile (see "per-test isolation" below)
``start``                   ``service start``, then wait for the SCM to say ``running``
``request_stop``            ``service stop`` (``SvcStop``), without waiting
``interrupt``               not supported: raise ``NotImplementedError``. A scenario that
                            needs it is marked ``platforms("cli")``
``kill``                    ``taskkill /F /PID`` of the pid ``service status`` reports
``wait_exit``               wait for the SCM state ``stopped``; the exit code is the
                            service's win32 exit code (0 after a stop)
``await_upgrade_restart``   wait until the SCM shows ``running`` with a pid other than the
                            one of the last start (see below)
``is_running``              the SCM state is ``running`` or a ``*_pending`` one
``pid``                     the pid ``service status`` reports, ``None`` unless running
``exit_code``               the win32 exit code of the last run, ``None`` while it runs
``installed_version``       ``data-hub-watcher --version`` of the machine's uv-tool install
``install_wheel``           ``uv tool install --reinstall <wheel>`` into the machine's
                            uv-tool install, with the service stopped (see "install_wheel"
                            below)
``hide_uv``                 see "hide_uv" below
``log_files``               ``C:\\ProgramData\\DataHubWatcher\\watcher.log``,
                            ``service-bootstrap.log`` and ``upgrade-worker.log``
``state_db_path``           beside the config file in the registry (``ConfigPath``)
``config_dir``              the directory of that config file
``close``                   ``service uninstall``, then wait for the service to be removed
==========================  ===========================================================

The fault proxy, the server and every assertion are the same under both drivers.

How a Windows upgrade works, because the CLI is different
---------------------------------------------------------

Under the CLI, an update ends with the process exiting with code 1 after a ``Watcher
restarting for auto-update`` event, and something has to start it again: the driver stands in
for that supervisor in ``await_upgrade_restart``. Under the service, the in-process updater
does not install anything. It hands the upgrade to a scheduled-task worker, which runs
``Stop-Service``, ``uv tool install``, then ``Start-Service``. The service therefore stops
*cleanly* (exit code 0, a ``Service stopped`` event, never exit code 1 and never "restarting
for auto-update"), and the worker starts a new process. A scenario that must see the exit
code or the event of the in-process path (``selfupdate.installed->exit_for_restart``) is
CLI-only. The rest asks for ``await_upgrade_restart(timeout)``, which is "the upgrade has
been installed and the watcher is running again" under both.

Service driver notes for PR 3
-----------------------------

Facts the notes rest on: one machine has one service and one registry ``ConfigPath``;
``C:\\ProgramData\\DataHubWatcher\\watcher.log`` is one file shared by everything on the
machine; the service loads its registered env file with ``override=True``; the SCM restarts a
failed or killed service after 60 s and then 120 s.

* **Per-test isolation for** ``run_cli``. Each test gets a folder with its own
  ``USERPROFILE`` (so ``~/.data-hub`` of a one-shot command such as ``init``, ``state
  forget`` or ``self-update`` is the test's), and ``service install`` registers
  ``ConfigPath`` and ``EnvPath`` inside that folder. ``config_dir()``, the env file and the
  state database (``state_db_path()`` is beside ``ConfigPath``) are then the test's own, and
  tests don't see each other's files. The first install per session registers the service
  and every later test points the registry at its own folder (``service install`` again, or
  ``service reinstall``), then ``close()`` uninstalls.
* **The shared log.** The driver records the byte offset of ``watcher.log`` when it is
  created and builds :meth:`log_text` and :meth:`mark_logs` from that offset, plus
  ``service-bootstrap.log`` and ``upgrade-worker.log`` (set ``self._log_baseline``). Nothing
  may truncate or delete ``watcher.log``. ``log_files()`` can return the whole file for the
  artifacts. Log rotation (``RotatingFileHandler``) can move the file under the offset: when
  the file is shorter than the recorded offset, read it from the start.
* **SCM failure actions off for the shared scenarios.** ``service install`` sets restart
  actions after 60 s and 120 s. A scenario that kills the watcher, or one whose start is
  refused, expects it to stay down until the scenario starts it, as a CLI process does. So
  right after ``service install`` the driver turns the actions off (``sc failure
  DataHubWatcher reset= 0 actions= ""``), and the real recovery is tested only in
  ``test_windows_service.py``, which switches them on itself.
* **A second PC for the two tests that run** ``init`` **for another one**
  (``test_a_second_registration_for_an_instrument_with_a_live_watcher_is_refused`` and
  ``test_init_for_an_instrument_that_has_a_watcher_names_it``). There is one service per
  machine, so a second PC can't be a second service. It is a config-only driver: a folder
  with its own profile whose ``run_cli`` passes the group option ``--config <path>``
  (``global_args=("--config", str(path))``), so ``init`` writes there and the registered
  service is left alone. It never starts.
* **await_upgrade_restart** waits for the service to be ``running`` with a pid other than the
  one the driver saw at its last ``start()`` (or its last ``await_upgrade_restart``). Take
  the old pid from the last start, not from the moment of the call: the worker may have
  restarted the service before the scenario gets there.
* **hide_uv.** Put a minimal ``PATH`` in the env file (the service reads it with
  ``override=True``), such as ``C:\\Windows\\System32``, and make sure the candidate
  ``<home>\\.local\\bin\\uv.exe`` that ``self_update._sys_prefix_uv_candidates`` derives from
  the install prefix and from ``USERPROFILE`` does not exist (a per-test profile has none; if
  the standalone installer put one in the profile the tool was installed from, move it away
  for the test and put it back in a ``finally``).
* **install_wheel.** The shared scenarios call it, on a PC with an install of its own, to put
  another version in place of the one that runs, as an operator reinstalling by hand would, so
  that the next start runs that version (the scenario of an update that did not take effect).
  Under the service it is ``uv tool install --reinstall <wheel>`` against the machine's
  uv-tool install, run while the service is stopped, which the scenario guarantees (it calls it
  between a stop and the next start). The upgrade worker does the install itself, so a scenario
  can't slip a reinstall in between the worker's install and its restart: the scenario that
  needs that moment is ``platforms("cli")``.
* **wait_for_state_db_busy** and the state database. The method is shared and needs no
  override: it uses :meth:`state_db_path` and opens the database the way ``state_query`` does.
* **kill() and the recovery actions.** ``taskkill /F`` is a crash for the SCM, so with the
  failure actions on the service comes back by itself after 60 s. With them off (note above)
  it stays down, ``wait_exit`` returns the win32 exit code of the killed process, and
  ``restart()`` is the only supervisor. ``stall_writes`` and ``fail_writes`` below may call
  ``kill()`` when a watcher is stuck inside a trigger.
* **The service's** ``config_invalid`` **path.** ``_run_service_loop`` calls ``load_config``
  outside of any ``try``, so a missing or malformed config raises an unhandled
  ``ClickException`` (it lands in ``service-bootstrap.log``) where every other refusal logs an
  error and exits through ``SystemExit(1)``. ``startup.config_invalid->refused`` reads the
  message from the log, and under the service it will find it in the bootstrap log instead.
  PR 3 should decide whether that is the behavior to test or a bug to fix, and say so in the
  catalog.
* **start() arguments.** ``args`` and ``global_args`` are command-line arguments of ``watch``
  (``args=("--dry-run",)``) and of the group before it (``global_args=("--verbose",)``). A
  service takes neither: ignore them, or refuse with ``NotImplementedError``.
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
import time
from abc import ABC, abstractmethod
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from enum import IntEnum
from pathlib import Path
from typing import Any, ClassVar, Literal

from data_hub_watcher import testing_overrides
from data_hub_watcher.config_io import load_config, save_config
from data_hub_watcher.constants import RUN_DETECTION_PRESETS
from data_hub_watcher.models import WatcherConfig
from e2e_support.admin import revision_settings
from e2e_support.catalog.model import DRIVER_KINDS, DriverKind
from e2e_support.waiting import WaitTimeout, wait_until

__all__ = [
    "DEFAULT_ENVIRONMENT",
    "DEFAULT_TIMER_OVERRIDES",
    "DRIVER_VARIABLE",
    "CliDriver",
    "CliResult",
    "DriverKind",
    "InitAnswers",
    "LogMark",
    "NewInstrument",
    "RunDetection",
    "ToolInstall",
    "WatcherDriver",
    "active_driver_kind",
    "driver_class_for",
    "install_watcher_tool",
]

# Which kind of driver a run uses: ``cli`` (the default) or ``service``.
DRIVER_VARIABLE = "DATA_HUB_E2E_DRIVER"

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

# Variables the watcher process must not inherit from the developer's shell. Some change which
# interpreter, key, config or package index it uses (an index variable would send the
# watcher's own `uv tool install` to a server of the developer's choice), and a proxy would
# send its calls to the fault proxy and the test server through the developer's proxy.
_SCRUBBED_ENV = frozenset(
    {
        "VIRTUAL_ENV",
        "PYTHONPATH",
        "PYTHONHOME",
        "PYTHONSTARTUP",
        "UV_PROJECT_ENVIRONMENT",
        "UV_PYTHON",
        "UV_EXTRA_INDEX_URL",
        "UV_DEFAULT_INDEX",
    }
)
_SCRUBBED_PREFIXES = ("DATA_HUB_", "UV_INDEX", "PIP_")
_PROXY_VARIABLES = frozenset({"http_proxy", "https_proxy", "all_proxy", "no_proxy"})

# Whatever the shell says, nothing the watcher or a test calls on this machine goes through a
# proxy.
_NO_PROXY = "127.0.0.1,localhost"

_INSTALL_TIMEOUT_SECONDS = 900

# What `watch` prints right before it installs its signal handlers.
READY_LINE = "Press Ctrl+C to stop."

# How long a graceful stop may take at the end of a test before the process is killed.
_CLOSE_GRACE_SECONDS = 15


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
    """``base`` (default: this process's environment) without what would leak into the watcher,
    and with ``NO_PROXY`` set so that nothing local goes through a proxy.

    Removed: every ``DATA_HUB_*`` variable, the ones that select an interpreter, a project
    environment or a package index (``UV_PYTHON``, ``UV_INDEX*``, ``UV_EXTRA_INDEX_URL``,
    ``UV_DEFAULT_INDEX``, ``PIP_*``), and the proxy variables in any case (``HTTP_PROXY``,
    ``HTTPS_PROXY``, ``ALL_PROXY``, ``NO_PROXY``). A machine that can reach PyPI only through a
    proxy can't run the suite.
    """
    source = os.environ if base is None else base
    env = {
        k: v
        for k, v in source.items()
        if k not in _SCRUBBED_ENV
        and not k.upper().startswith(_SCRUBBED_PREFIXES)
        and k.lower() not in _PROXY_VARIABLES
    }
    env["NO_PROXY"] = _NO_PROXY
    return env


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
    root: Path,
    wheel: Path,
    *,
    python: str = DEFAULT_PYTHON,
    extras: Sequence[str] = (),
    reinstall: bool = False,
) -> ToolInstall:
    """Install ``wheel`` with ``uv tool install`` under ``root`` and return the install.

    ``python`` is the interpreter the tool runs on. Dependencies come from PyPI, through
    uv's cache, so the first install of a session needs the network. With ``reinstall``, an
    install that is already under ``root`` is replaced by ``wheel`` whatever versions are
    involved, which is how a version goes down as well as up.
    """
    install = ToolInstall(root=Path(root), python=python)
    install.root.mkdir(parents=True, exist_ok=True)
    spec = str(wheel)
    if extras:
        spec = f"data-hub-watcher[{','.join(extras)}] @ {Path(wheel).resolve().as_uri()}"
    command = [uv_executable(), "tool", "install", "--python", python]
    if reinstall:
        command.append("--reinstall")
    command.append(spec)
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


@dataclass(frozen=True)
class LogMark:
    """A place in the watcher's log text, from :meth:`WatcherDriver.mark_logs`.

    Pass it as ``since=`` to :meth:`WatcherDriver.log_text` or :meth:`wait_for_log` to look
    only at what the watcher logged after it. It is opaque: a scenario never reads it.
    """

    offsets: tuple[tuple[Path, int], ...]


_SQL_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


class WatcherDriver(ABC):
    """One instrument PC with a watcher installed, as a scenario sees it.

    The constructor takes what the PC is registered as. Everything about the process lives
    in the abstract methods (see the module docstring for the Windows mapping). The rest is
    shared: writing ``config.yaml`` through ``save_config``, writing the env file, running
    the real ``init``, reading the state database and the log, and breaking the database on
    purpose.

    Attributes a scenario reads: ``instrument_id``, ``watch_dir`` (resolved), ``environment``,
    ``api_base_url`` (the fault proxy's address plus ``/api/v1``), ``api_key`` and
    ``watcher_id``, ``kind``, ``role`` and the message properties.
    """

    # "cli" or "service". The suite's conftest skips a test whose `platforms` marker leaves
    # this kind out.
    kind: ClassVar[DriverKind]
    # What the watcher calls itself in its events: "Watcher" for `watch`, "Service" for the
    # Windows service.
    role: ClassVar[str]

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
        # Where each log file starts for this driver, for a log that something else wrote to
        # before the driver existed (the service's machine-wide `watcher.log`).
        self._log_baseline: dict[Path, int] = {}

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

    # -- what the watcher calls things (they differ by role) -----------------

    @property
    def started_prefix(self) -> str:
        """The start of the message of a ``watcher_started`` event for a start:
        ``Watcher started on `` or ``Service started on ``."""
        return f"{self.role} started on "

    @property
    def resumed_prefix(self) -> str:
        """The start of the message of the ``watcher_started`` event sent when a watcher that
        was waiting for its folder starts watching: ``Watcher resumed on `` or
        ``Service resumed on ``."""
        return f"{self.role} resumed on "

    @property
    def restarted_prefix(self) -> str:
        """The start of the ``watcher_started`` message of a rebuild in the same process (a
        config revision): ``Watcher restarted on `` or ``Service restarted on ``."""
        return f"{self.role} restarted on "

    @property
    def operator_stop_message(self) -> str:
        """The message of the ``watcher_stopped`` event after :meth:`stop`: ``Watcher stopped
        by user`` for the CLI, ``Service stopped`` for the service."""
        return "Watcher stopped by user" if self.kind == "cli" else f"{self.role} stopped"

    @property
    def update_stop_message(self) -> str:
        """The message of the ``watcher_stopped`` event of an update: ``Watcher restarting for
        auto-update`` for the CLI. The service is stopped by the upgrade worker, so it says
        ``Service stopped``."""
        return (
            f"{self.role} restarting for auto-update"
            if self.kind == "cli"
            else f"{self.role} stopped"
        )

    # -- the process (abstract) ------------------------------------------

    @abstractmethod
    def run_cli(
        self,
        *args: str,
        input: str | None = None,
        timeout: float = 120.0,
        global_args: Sequence[str] = (),
    ) -> CliResult:
        """Run a one-shot ``data-hub-watcher`` command, such as ``config validate`` or
        ``watch --dry-run``, to completion, as this PC's operator, and capture its output.

        ``global_args`` go before the command, for the options of the group: ``--config
        <path>`` and ``--verbose`` (``run_cli("init", global_args=("--verbose",))``).
        """

    @abstractmethod
    def start(
        self,
        *,
        wait_ready: bool = True,
        args: Sequence[str] = (),
        global_args: Sequence[str] = (),
    ) -> None:
        """Start the watcher. ``args`` are extra arguments of the ``watch`` command and
        ``global_args`` are options of the group before it (``global_args=("--verbose",)``).

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
        Only under the CLI: a scenario that uses it is marked ``platforms("cli")``."""

    @abstractmethod
    def kill(self) -> None:
        """Kill the watcher without any chance to clean up (SIGKILL, ``taskkill /F``) and
        return once it is gone."""

    @abstractmethod
    def wait_exit(self, timeout: float = 30.0) -> int:
        """Wait for the watcher to exit and return its exit code (0 after a stop, ``-9`` after
        SIGKILL on POSIX, 1 after the in-process updater's restart). Raises ``WaitTimeout``
        otherwise."""

    @abstractmethod
    def await_upgrade_restart(self, timeout: float) -> None:
        """Carry an update from "the new version is being installed" to "the watcher is
        running again", whatever drives that on this kind of driver.

        CLI: the process exits with code 1 once the install is done, and this asserts that and
        starts it again (the driver is the supervisor). Service: the upgrade worker stops the
        service, installs and starts it, so this waits until the SCM shows ``running`` with a
        new pid. Raises ``AssertionError`` (a ``WaitTimeout``) if that doesn't happen within
        ``timeout`` seconds. A scenario that must see the exit code 1 or the "restarting for
        auto-update" event checks that itself and is marked ``platforms("cli")``.
        """

    @abstractmethod
    def is_running(self) -> bool:
        """Whether the watcher process is alive."""

    @property
    @abstractmethod
    def pid(self) -> int | None:
        """The process id of the running watcher, or ``None`` when it is not running.

        Compare two readings to see whether it is the same process (a config change is
        applied inside the process, a start is a new one)."""

    @property
    @abstractmethod
    def exit_code(self) -> int | None:
        """The exit code of the last run, or ``None`` while it runs or before any start."""

    @abstractmethod
    def installed_version(self) -> str:
        """The version of the watcher installed for this PC, as ``data-hub-watcher --version``
        prints it. After an update it is the new version, before the watcher restarts."""

    @abstractmethod
    def install_wheel(self, wheel: Path) -> None:
        """Replace the watcher installed for this PC with the one in ``wheel`` (any version,
        older or newer), the way an operator reinstalling by hand would, without going through
        the watcher. The next start runs that version.

        Call it while the watcher is not running, on a PC that has an install of its own
        (``watcher(own_install=True)``): the shared install belongs to every test, so a driver
        refuses to change it. A scenario about an update that did not take effect uses it to put
        the old version back after the update installed the new one.

        CLI: ``uv tool install --reinstall <wheel>`` into the PC's own tool directory. Service:
        see "install_wheel" in the module docstring."""

    @abstractmethod
    def hide_uv(self) -> None:
        """Make the watcher unable to find ``uv``, so an update fails before it starts (the
        ``uv executable not found`` case). Call it before :meth:`start`.

        CLI: an empty directory is the only entry of ``PATH``, set in the env file the
        watcher loads. Service: see "hide_uv" in the module docstring."""

    @abstractmethod
    def log_files(self) -> list[Path]:
        """Every log file of the watcher, whole, for failure artifacts. Some of them repeat
        each other (the CLI logs to the console and to ``watcher.log``); :meth:`log_text` is
        the version to read."""

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

        An update is a different case: use :meth:`await_upgrade_restart` for it, because
        what restarts the watcher differs by driver.
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

    # -- the state database ------------------------------------------------

    def _state_connection(self, timeout: float = 30.0) -> sqlite3.Connection:
        path = self.state_db_path()
        if not path.exists():
            raise FileNotFoundError(
                f"The state database {path} doesn't exist yet. Start the watcher first."
            )
        return sqlite3.connect(path, timeout=timeout, isolation_level=None)

    def state_query(self, sql: str, params: Sequence[Any] = ()) -> list[tuple[Any, ...]]:
        """Run a SELECT against the watcher's state database (``pending_uploads``,
        ``detected_files``, ``uploaded_files``, ``meta`` ...). An empty list if the database
        doesn't exist yet."""
        path = self.state_db_path()
        if not path.exists():
            return []
        with contextlib.closing(sqlite3.connect(path, timeout=10)) as conn:
            return conn.execute(sql, tuple(params)).fetchall()

    def state_execute(self, sql: str, params: Sequence[Any] = ()) -> None:
        """Run one statement that changes the watcher's state database, and commit it.

        A scenario never opens the database itself, because under the service the file is
        somewhere else. The watcher must have started once, so the database exists. It waits
        up to 30 seconds for the watcher's own write to finish.
        """
        with contextlib.closing(self._state_connection()) as conn:
            conn.execute(sql, tuple(params))

    def wait_for_state_db_busy(self, hold_seconds: float = 1.0, timeout: float = 30.0) -> None:
        """Wait until another process has held the state database's write lock for
        ``hold_seconds`` without a break, which is a watcher stuck inside a write.

        It tries to take the lock (``BEGIN IMMEDIATE`` with no wait) every 50 ms. A try that
        works means the lock was free, so the count starts again; a try that finds it taken
        is one more moment of the hold. The watcher's own writes take milliseconds, so a lock
        held for a second is a write that is not going to finish: the one ``stall_writes``
        sets up, which a scenario can then end with ``kill()``. Waiting for it, and not for a
        row in the database, keeps the scenario from depending on which statements of the
        watcher share a transaction. Raises ``WaitTimeout`` if the lock is never held that
        long.
        """
        path = self.state_db_path()
        held_since: list[float | None] = [None]

        def held() -> bool | None:
            if not path.exists():
                return None
            with contextlib.closing(sqlite3.connect(path, timeout=0, isolation_level=None)) as conn:
                try:
                    conn.execute("BEGIN IMMEDIATE")
                except sqlite3.OperationalError as exc:
                    if "locked" not in str(exc) and "busy" not in str(exc):
                        held_since[0] = None
                        raise
                    now = time.monotonic()
                    if held_since[0] is None:
                        held_since[0] = now
                    return now - held_since[0] >= hold_seconds
                conn.execute("ROLLBACK")
            held_since[0] = None
            return None

        wait_until(
            held,
            timeout,
            lambda: f"state database: {path}\n{self.log_tail()}",
            what=f"the watcher to hold the write lock of its state database for {hold_seconds:g} s",
            interval=0.05,
        )

    @contextlib.contextmanager
    def lock_state_db(self) -> Iterator[None]:
        """Hold a write lock on the watcher's state database for the length of a ``with`` block.

        A watcher that wants to write waits 5 seconds for the lock and then fails with
        ``database is locked``. Starting to watch fails that way (the first thing it does is
        a write), which is the only way to make "the folder is there but starting to watch
        fails" happen from outside the process: start the watcher with its folder missing so it
        waits, take the lock, and then create the folder. Reads are not blocked (the database
        is in WAL mode).
        """
        conn = sqlite3.connect(self.state_db_path(), timeout=30, isolation_level=None)
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield
        finally:
            with contextlib.suppress(sqlite3.Error):
                conn.execute("ROLLBACK")
            conn.close()

    def _install_insert_trigger(self, kind: str, table: str, body: str) -> str:
        if _SQL_NAME.fullmatch(table) is None:
            raise ValueError(f"{table!r} is not a plain table name")
        name = f"e2e_{kind}_{table}"
        self.state_execute(f"DROP TRIGGER IF EXISTS {name}")
        self.state_execute(f"CREATE TRIGGER {name} BEFORE INSERT ON {table} BEGIN {body}; END")
        return name

    def _drop_trigger(self, name: str, *, kill_if_stuck: bool) -> None:
        drop = f"DROP TRIGGER IF EXISTS {name}"
        try:
            # A stalled watcher won't let go, so don't wait long for it; another writer will.
            with contextlib.closing(
                self._state_connection(timeout=2 if kill_if_stuck else 30)
            ) as conn:
                conn.execute(drop)
        except sqlite3.OperationalError:
            if kill_if_stuck and self.is_running():
                # The watcher is inside the trigger and holds the write lock, which nothing
                # else can make it let go of. It can't go on, so it is killed.
                self.kill()
            with contextlib.closing(self._state_connection(timeout=30)) as conn:
                conn.execute(drop)

    @contextlib.contextmanager
    def stall_writes(self, table: str) -> Iterator[None]:
        """Make the watcher's next insert into ``table`` of its state database take minutes.

        It adds a trigger that joins ``sqlite_master`` with itself nine times (about 2e10
        rows) before the insert goes through, so the watcher sits exactly between the write
        before it and this one: for ``pending_uploads``, between "the run was reported" and
        "the files were recorded as pending". Every other write commits as usual. The watcher
        has to be started once so the database exists, and the trigger is in place for the
        ``with`` block.

        The trigger is always dropped when the block ends. A watcher that is still stuck inside
        it then holds the write lock, and nothing else can free it, so it is killed. A scenario
        that wants the kill at a particular moment calls ``kill()`` inside the block.
        """
        cross_join = ", ".join(f"sqlite_master t{n}" for n in range(9))
        name = self._install_insert_trigger("stall", table, f"SELECT count(*) FROM {cross_join}")
        try:
            yield
        finally:
            self._drop_trigger(name, kill_if_stuck=True)

    @contextlib.contextmanager
    def fail_writes(self, table: str, message: str = "injected") -> Iterator[None]:
        """Make every insert into ``table`` of the watcher's state database fail, for the
        length of a ``with`` block: the statement fails with ``message`` (the watcher sees an
        ``sqlite3.IntegrityError``) and its transaction is rolled back, as a write that fails
        for a real reason such as a full disk is. That is on purpose: a statement that merely
        aborted would leave the watcher's connection in an open transaction that holds the write
        lock, and the trigger could not be dropped until that connection committed.

        The trigger is always dropped when the block ends.
        """
        escaped = message.replace("'", "''")
        name = self._install_insert_trigger("fail", table, f"SELECT RAISE(ROLLBACK, '{escaped}')")
        try:
            yield
        finally:
            self._drop_trigger(name, kill_if_stuck=False)

    # -- the log ------------------------------------------------------------

    def _log_text_files(self) -> list[Path]:
        """The files :meth:`log_text` is built from, in the order of the runs, with nothing
        twice. Defaults to :meth:`log_files`; a driver whose log files repeat each other
        returns only one copy."""
        return self.log_files()

    def _read_log(self, path: Path, since: Mapping[Path, int]) -> str:
        start = since.get(path, self._log_baseline.get(path, 0))
        try:
            data = path.read_bytes()
        except OSError:
            return ""
        if start > len(data):
            start = 0  # The file was rotated or replaced since the position was taken.
        return data[start:].decode("utf-8", errors="replace")

    def mark_logs(self) -> LogMark:
        """A mark at the end of the log now, to read only what comes after it:
        ``pc.log_text(since=mark)``, ``pc.wait_for_log(regex, since=mark)``."""
        marks: list[tuple[Path, int]] = []
        for path in self._log_text_files():
            with contextlib.suppress(OSError):
                marks.append((path, path.stat().st_size))
        return LogMark(tuple(marks))

    def log_text(self, since: LogMark | None = None) -> str:
        """What the watcher has logged, each line once, runs in the order they happened.

        The text starts at the driver's creation (the service shares its log with the whole
        machine, so there it is the part that this test wrote) or, with ``since``, at a
        :meth:`mark_logs`. It is for matching and for failure messages. To count something,
        count in this text, never in :meth:`log_files`, where lines repeat.
        """
        offsets = dict(since.offsets) if since is not None else {}
        parts: list[str] = []
        for path in self._log_text_files():
            text = self._read_log(path, offsets)
            if text and not text.endswith("\n"):
                text += "\n"
            parts.append(text)
        return "".join(parts)

    def log_tail(self, lines: int = 40) -> str:
        """The last lines of each log, for failure messages."""
        parts: list[str] = []
        for path in self._log_text_files():
            text = self._read_log(path, {})
            parts.append(f"=== {path.name}\n" + "\n".join(text.splitlines()[-lines:]))
        return "\n".join(parts)

    def wait_for_log(self, regex: str, timeout: float = 30.0, since: LogMark | None = None) -> str:
        """Wait until a log line matches the regular expression ``regex`` and return the line.

        Prefer the server's view where there is one. Use this for what only the log shows,
        such as the initial scan finishing. With ``since`` (from :meth:`mark_logs`), lines
        logged before the mark don't count.
        """
        pattern = re.compile(regex)

        def found() -> str | None:
            for line in self.log_text(since).splitlines():
                if pattern.search(line):
                    return line
            return None

        return wait_until(
            found, timeout, self.log_tail, what=f"a log line matching {regex!r}", interval=0.25
        )


# ---------------------------------------------------------------------------
# The POSIX driver
# ---------------------------------------------------------------------------


class CliDriver(WatcherDriver):
    """Runs ``data-hub-watcher watch`` from a ``uv tool`` install, as a POSIX process.

    The process gets an isolated ``HOME`` (so ``~/.data-hub`` is ``<home>/.data-hub``), its
    own session and process group (so a Ctrl+C in the terminal running pytest doesn't reach
    it, and the whole group can be killed at the end), and stdout and stderr in files. It has
    no supervisor of its own: after an update it exits with code 1 and stays down until
    :meth:`await_upgrade_restart` starts it again.

    ``extra_environment`` adds variables to the process, after the scrubbed copy of this
    process's environment. Put override variables in the env file with ``write_env`` instead
    where they are meant for the watcher alone.
    """

    kind: ClassVar[DriverKind] = "cli"
    role: ClassVar[str] = "Watcher"

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
        owns_install: bool = False,
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
        # Whether the install is this PC's alone (the factory's `own_install=True`). The
        # shared one belongs to every test, so `install_wheel` refuses to change it.
        self.owns_install = owns_install
        self.extra_environment = dict(extra_environment or {})
        self._process: subprocess.Popen[bytes] | None = None
        self._run_count = 0
        self._launched: list[int] = []
        self._closed = False
        self._log_dir = home / "driver-logs"

    # -- paths ------------------------------------------------------------

    def config_dir(self) -> Path:
        return self.home / ".data-hub"

    def state_db_path(self) -> Path:
        return self.config_dir() / f"watcher-{self.environment}.db"

    def _run_logs(self) -> list[Path]:
        """The captured stdout and stderr of every run, in the order the runs happened (run 10
        after run 2)."""
        paths: list[Path] = []
        for number in range(1, self._run_count + 1):
            for stream in ("stdout", "stderr"):
                path = self._log_dir / f"watch-{number}.{stream}.log"
                if path.exists():
                    paths.append(path)
        return paths

    def log_files(self) -> list[Path]:
        """``~/.data-hub/watcher.log`` and the stdout and stderr of every run."""
        paths = [self.config_dir() / "watcher.log", *self._run_logs()]
        return [p for p in paths if p.exists()]

    def _log_text_files(self) -> list[Path]:
        # `cli.py` calls `logging.basicConfig`, so stderr already holds every record that
        # `watcher.log` holds. Stdout has what the command prints. Reading `watcher.log` as
        # well would show every line twice.
        return self._run_logs()

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

    # -- one-shot commands --------------------------------------------------

    def run_cli(
        self,
        *args: str,
        input: str | None = None,
        timeout: float = 120.0,
        global_args: Sequence[str] = (),
    ) -> CliResult:
        self.home.mkdir(parents=True, exist_ok=True)
        try:
            completed = subprocess.run(
                [str(self.tool_install.executable), *global_args, *args],
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
                f"`data-hub-watcher {' '.join([*global_args, *args])}` did not finish in "
                f"{timeout:g} s.\nstdout:\n{_text(exc.stdout)}\nstderr:\n{_text(exc.stderr)}"
            ) from exc
        return CliResult(
            args=tuple(args),
            returncode=completed.returncode,
            stdout=completed.stdout,
            stderr=completed.stderr,
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
            raise RuntimeError("Stop the watcher before its install is replaced")
        install_watcher_tool(
            self.tool_install.root, wheel, python=self.tool_install.python, reinstall=True
        )

    def hide_uv(self) -> None:
        # `uv` is looked for on the PATH, and in a few places under the home folder, which is
        # this test's own and holds none. The env file is what `watch` loads into its process.
        nowhere = self.home / "no-uv-here"
        nowhere.mkdir(parents=True, exist_ok=True)
        self.write_env(overrides={"PATH": str(nowhere)})

    # -- the process ------------------------------------------------------

    def start(
        self,
        *,
        wait_ready: bool = True,
        args: Sequence[str] = (),
        global_args: Sequence[str] = (),
    ) -> None:
        """Start ``data-hub-watcher watch``.

        Ready means the command has printed ``Press Ctrl+C to stop.``, which it does right
        before it installs its SIGINT and SIGTERM handlers, after the start-up scan.
        """
        if self.is_running():
            raise RuntimeError("The watcher is already running")
        self.home.mkdir(parents=True, exist_ok=True)
        self._log_dir.mkdir(parents=True, exist_ok=True)
        self._run_count += 1
        self._closed = False
        stem = self._log_dir / f"watch-{self._run_count}"
        with open(f"{stem}.stdout.log", "wb") as out, open(f"{stem}.stderr.log", "wb") as err:
            self._process = subprocess.Popen(
                [str(self.tool_install.executable), *global_args, "watch", *args],
                cwd=self.home,
                env=self.process_environment(),
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=err,
                start_new_session=True,
            )
        self._launched.append(self._process.pid)
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
    def pid(self) -> int | None:
        process = self._process
        return process.pid if process is not None and process.poll() is None else None

    @property
    def launched_pids(self) -> tuple[int, ...]:
        """The pid of every process this driver has started, which is also the process
        group of each (``start_new_session``). For a test of the driver itself."""
        return tuple(self._launched)

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

    def await_upgrade_restart(self, timeout: float) -> None:
        """Wait for the exit that follows an install, assert it is the updater's code 1, and
        start the watcher again, as a supervisor does."""
        code = self.wait_exit(timeout)
        assert code == 1, (
            f"the watcher exited with {code} after an update, not the updater's 1.\n"
            f"{self.log_tail()}"
        )
        self.start()

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
        """Stop the watcher and everything it started. Safe to call twice.

        The watcher gets a graceful stop first, so its state database is closed cleanly. Then
        the whole process group is killed, whether or not the watcher exited: a child it left
        behind (the ``uv`` of an update, say) belongs to the same group and would otherwise
        outlive the test.
        """
        process = self._process
        if process is None or self._closed:
            return
        self._closed = True
        if process.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                process.send_signal(signal.SIGTERM)
            try:
                process.wait(timeout=_CLOSE_GRACE_SECONDS)
            except subprocess.TimeoutExpired:
                pass
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(process.pid, signal.SIGKILL)
        if process.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
        process.wait()


def driver_class_for(kind: DriverKind) -> type[WatcherDriver]:
    """The driver class for a kind of driver."""
    if kind == "cli":
        return CliDriver
    raise NotImplementedError(
        "The service driver (WindowsServiceDriver) arrives in the third pull request of the "
        "watcher end-to-end stack (PR 3). Until then only DATA_HUB_E2E_DRIVER=cli runs."
    )


def active_driver_kind(env: Mapping[str, str] | None = None) -> DriverKind:
    """The kind of driver this run uses: ``$DATA_HUB_E2E_DRIVER``, ``cli`` if it is unset."""
    raw = (os.environ if env is None else env).get(DRIVER_VARIABLE, "").strip().lower() or "cli"
    for kind in DRIVER_KINDS:
        if raw == kind:
            return kind
    raise ValueError(f"{DRIVER_VARIABLE}={raw!r} is not one of {list(DRIVER_KINDS)}")


def _text(data: bytes | str | None) -> str:
    if data is None:
        return ""
    return data if isinstance(data, str) else data.decode(errors="replace")
