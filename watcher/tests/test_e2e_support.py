"""Unit tests for the helpers behind the end-to-end suite (``watcher/e2e/e2e_support``).

They need no server. The one that matters most for the rest of the suite is that
``InitAnswers`` still matches the prompts of the real ``init`` wizard: it is checked here, by
running ``init`` with a fake API client, so changing a prompt in ``cli.py`` fails this normal
test and not only the end-to-end run. The drivers are tried against a stand-in for
``data-hub-watcher``, and every test that starts one stops it and checks nothing was left behind.
"""

from __future__ import annotations
import contextlib
import os
import signal
import sqlite3
import stat
import subprocess
import sys
import textwrap
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from click.testing import CliRunner

from data_hub_shared.testing_proxy import FaultProxy
from data_hub_watcher import cli as cli_module
from data_hub_watcher.config_io import load_config
from data_hub_watcher.models import InstrumentResponse, RegisterWatcherResponse
from e2e_support import drivers
from e2e_support.drivers import (
    CliDriver,
    InitAnswers,
    NewInstrument,
    RunDetection,
    ToolInstall,
    WatcherDriver,
    active_driver_kind,
    clean_environment,
    driver_class_for,
    install_watcher_tool,
)
from e2e_support.factory import WatcherFactory
from e2e_support.files import (
    LARGE,
    MULTIPART_THRESHOLD_BYTES,
    SMALL,
    GrowingFile,
    payload,
    write_file,
    write_run,
)
from e2e_support.platforms import platforms_skip_reason
from e2e_support.proxy_helpers import silence_heartbeats
from e2e_support.server import FileRow, ServerView
from e2e_support.waiting import (
    KnownBugStillPresent,
    WaitTimeout,
    known_bug,
    stays_true,
    wait_until,
)

posix_only = pytest.mark.skipif(sys.platform == "win32", reason="POSIX signals")


# ---------------------------------------------------------------------------
# wait_until and stays_true
# ---------------------------------------------------------------------------


class TestWaitUntil:
    def test_returns_the_first_truthy_value(self) -> None:
        values = iter([None, False, 0, "found", "later"])

        assert wait_until(lambda: next(values), 5, interval=0.01) == "found"

    def test_calls_the_predicate_once_even_with_no_time(self) -> None:
        calls: list[int] = []

        def predicate() -> str:
            calls.append(1)
            return "ready"

        assert wait_until(predicate, 0) == "ready"
        assert calls == [1]

    def test_a_timeout_shows_the_last_value_and_the_description(self) -> None:
        with pytest.raises(WaitTimeout) as excinfo:
            wait_until(
                lambda: [],
                0.05,
                lambda: "the watcher row",
                what="events to appear",
                interval=0.01,
            )

        message = str(excinfo.value)
        assert "Timed out after 0.05 s waiting for events to appear" in message
        assert "the last value was []" in message
        assert "the watcher row" in message

    def test_an_error_in_the_predicate_counts_as_not_yet_and_is_shown(self) -> None:
        attempts = {"n": 0}

        def flaky() -> str:
            attempts["n"] += 1
            if attempts["n"] < 3:
                raise ConnectionError("not up yet")
            return "up"

        assert wait_until(flaky, 5, interval=0.01) == "up"

        def broken() -> bool:
            raise AssertionError("still wrong")

        with pytest.raises(WaitTimeout, match="it raised AssertionError: still wrong"):
            wait_until(broken, 0.05, interval=0.01)

    def test_a_failing_description_does_not_hide_the_timeout(self) -> None:
        def describe() -> str:
            raise RuntimeError("boom")

        with pytest.raises(WaitTimeout, match="describe\\(\\) raised RuntimeError: boom"):
            wait_until(lambda: False, 0, describe)

    def test_a_timeout_is_an_assertion_error(self) -> None:
        with pytest.raises(AssertionError):
            wait_until(lambda: False, 0)

    def test_does_not_wait_past_the_deadline(self) -> None:
        started = time.monotonic()
        with pytest.raises(WaitTimeout):
            wait_until(lambda: False, 0.2, interval=5)

        assert time.monotonic() - started < 2


class TestStaysTrue:
    def test_passes_when_the_condition_holds_for_the_whole_duration(self) -> None:
        started = time.monotonic()

        stays_true(lambda: True, 0.1, interval=0.01)

        assert time.monotonic() - started >= 0.1

    def test_fails_at_the_first_falsy_poll(self) -> None:
        values = iter([True, True, False, True])

        with pytest.raises(WaitTimeout, match="no change stopped holding"):
            stays_true(lambda: next(values), 5, what="no change", interval=0.01)

    def test_an_error_counts_as_a_failure(self) -> None:
        def broken() -> bool:
            raise KeyError("gone")

        with pytest.raises(WaitTimeout, match="it raised KeyError"):
            stays_true(broken, 1, interval=0.01)


class TestKnownBug:
    def test_an_assertion_in_the_block_becomes_the_known_bug_exception(self) -> None:
        with pytest.raises(KnownBugStillPresent, match="still present: 1 != 2") as excinfo:
            with known_bug():
                assert 1 == 2, "1 != 2"

        assert isinstance(excinfo.value.__cause__, AssertionError)

    def test_a_wait_that_times_out_in_the_block_is_the_known_bug(self) -> None:
        with pytest.raises(KnownBugStillPresent, match="waiting for the thing") as excinfo:
            with known_bug():
                wait_until(lambda: False, 0, what="the thing")

        assert isinstance(excinfo.value.__cause__, WaitTimeout)

    def test_it_is_an_assertion_error_that_a_nested_block_leaves_alone(self) -> None:
        with pytest.raises(KnownBugStillPresent) as outer:
            with known_bug(), known_bug():
                raise AssertionError("still broken")

        assert outer.value.__cause__ is not outer.value
        assert isinstance(outer.value, AssertionError)

    def test_other_failures_pass_through_unchanged(self) -> None:
        # A broken precondition inside the block is not the bug, so it must not become it.
        with pytest.raises(KeyError):
            with known_bug():
                raise KeyError("gone")
        with pytest.raises(ConnectionError):
            with known_bug():
                raise ConnectionError("the server is down")

    def test_a_block_that_passes_raises_nothing(self) -> None:
        with known_bug():
            assert True

    def test_the_xfail_with_raises_expects_the_known_bug_and_fails_on_anything_else(
        self, tmp_path: Path
    ) -> None:
        test_file = tmp_path / "test_bugs.py"
        test_file.write_text(
            textwrap.dedent(
                """
                import pytest
                from e2e_support.waiting import KnownBugStillPresent, known_bug

                mark = pytest.mark.xfail(
                    strict=True, raises=KnownBugStillPresent, reason="bug-1: x"
                )

                @mark
                def test_the_bug_is_there():
                    with known_bug():
                        assert False

                @mark
                def test_a_broken_precondition():
                    assert False  # outside the block
                    with known_bug():
                        assert False

                @mark
                def test_the_bug_is_fixed():
                    with known_bug():
                        assert True
                """
            )
        )
        support = Path(drivers.__file__).resolve().parents[1]

        result = subprocess.run(
            [sys.executable, "-m", "pytest", "-p", "no:cacheprovider", "-rfxX", str(test_file)],
            capture_output=True,
            text=True,
            cwd=tmp_path,
            env={**os.environ, "PYTHONPATH": str(support)},
            timeout=120,
        )

        assert "2 failed, 1 xfailed" in result.stdout, result.stdout
        failed = [line for line in result.stdout.splitlines() if line.startswith("FAILED")]
        assert len(failed) == 2
        assert any("test_a_broken_precondition" in line for line in failed)
        assert any("test_the_bug_is_fixed" in line for line in failed)
        assert "XFAIL" in result.stdout and "test_the_bug_is_there" in result.stdout


# ---------------------------------------------------------------------------
# InitAnswers against the real wizard
# ---------------------------------------------------------------------------


class FakeClient:
    """Stands in for `DataHubClient` during `init`."""

    instruments = [
        InstrumentResponse(
            id="existing-one", display_name="Existing One", status="active", file_patterns=None
        ),
        InstrumentResponse(
            id="existing-two", display_name="Existing Two", status="active", file_patterns=["*.dat"]
        ),
    ]

    def __init__(self, listed: int) -> None:
        self.listed = listed
        self.registered_for: str | None = None
        self.created: tuple[str, str] | None = None

    def list_instruments(self) -> list[InstrumentResponse]:
        return self.instruments[: self.listed]

    def create_instrument(self, instrument_id: str, display_name: str) -> InstrumentResponse:
        self.created = (instrument_id, display_name)
        return InstrumentResponse(id=instrument_id, display_name=display_name, status="pending")

    def register_watcher(self, *, instrument_id: str, **_: Any) -> RegisterWatcherResponse:
        self.registered_for = instrument_id
        return RegisterWatcherResponse(watcher_id="00000000-0000-4000-8000-000000000001")

    def push_config(self, *_: Any, **__: Any) -> None:
        return None


@pytest.fixture
def init_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Run `init` against a fake client, with its files in ``tmp_path``."""
    watch_dir = tmp_path / "watch"
    watch_dir.mkdir()
    env_file = tmp_path / ".env.production"
    saved_keys: list[str] = []

    def save_api_key(key: str, environment: str | None = None) -> Path:
        saved_keys.append(key)
        return env_file

    monkeypatch.setattr(cli_module, "load_env", lambda *a, **k: None)
    monkeypatch.setattr(cli_module, "save_api_key", save_api_key)
    monkeypatch.setattr(cli_module, "env_file_path", lambda environment=None: env_file)
    monkeypatch.setenv("DATA_HUB_API_KEY", "")
    return {"watch": watch_dir, "env_file": env_file, "saved_keys": saved_keys, "tmp": tmp_path}


def run_init(
    init_env: dict[str, Any], monkeypatch: pytest.MonkeyPatch, answers: InitAnswers, listed: int
) -> tuple[Any, FakeClient, Path]:
    client = FakeClient(listed)
    monkeypatch.setattr(cli_module, "_make_client", lambda *a, **k: client)
    config_path = init_env["tmp"] / "config.yaml"
    result = CliRunner().invoke(
        cli_module.cli,
        ["--config", str(config_path), "init", "--show-key"],
        input=answers.stdin_text(),
    )
    return result, client, config_path


class TestInitAnswers:
    def test_an_existing_instrument_and_every_setting(
        self, init_env: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        answers = InitAnswers(
            environment="production",
            api_base_url="http://proxy.test/api/v1",
            api_key="dhub_abc",
            watch_directory=init_env["watch"],
            instrument=2,
            existing_instruments=2,
            file_patterns=["*.csv", "*.txt"],
            run_detection=RunDetection.DEEPEST_SUBDIRECTORY,
            recursive=False,
            stability_period_seconds=7,
            upload_mode="manual",
        )

        result, client, config_path = run_init(init_env, monkeypatch, answers, listed=2)

        assert result.exit_code == 0, result.output
        cfg = load_config(config_path)
        assert client.registered_for == "existing-two"
        assert cfg.environment == "production"
        assert cfg.api_base_url == "http://proxy.test/api/v1"
        assert cfg.watcher_id == "00000000-0000-4000-8000-000000000001"
        assert cfg.instrument.watch_directory == init_env["watch"].resolve()
        assert cfg.instrument.file_patterns == ["*.csv", "*.txt"]
        assert cfg.instrument.run_detection.pattern == r"([^/]+)/[^/]+$"
        assert cfg.instrument.run_detection.recursive is False
        assert cfg.instrument.stability_period_seconds == 7
        assert cfg.instrument.upload_mode == "manual"
        assert init_env["saved_keys"] == ["dhub_abc"]

    def test_enter_takes_the_wizards_defaults(
        self, init_env: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        answers = InitAnswers(
            environment="staging",
            api_base_url="http://proxy.test/api/v1/",
            api_key="dhub_abc",
            watch_directory=init_env["watch"],
        )

        result, client, config_path = run_init(init_env, monkeypatch, answers, listed=2)

        assert result.exit_code == 0, result.output
        cfg = load_config(config_path)
        assert client.registered_for == "existing-one"
        # The default patterns of an instrument with none are `*.*`.
        assert cfg.instrument.file_patterns == ["*.*"]
        assert cfg.instrument.run_detection.pattern == r"^([^/]+)/"
        assert cfg.instrument.run_detection.recursive is True
        assert cfg.instrument.stability_period_seconds == 5
        assert cfg.instrument.upload_mode == "auto"

    def test_registering_a_new_instrument(
        self, init_env: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        answers = InitAnswers(
            environment="production",
            api_base_url="http://proxy.test/api/v1",
            api_key="dhub_abc",
            watch_directory=init_env["watch"],
            instrument=NewInstrument("brand-new", "Brand New"),
            existing_instruments=2,
        )

        result, client, config_path = run_init(init_env, monkeypatch, answers, listed=2)

        assert result.exit_code == 0, result.output
        assert client.created == ("brand-new", "Brand New")
        assert load_config(config_path).instrument.id == "brand-new"

    def test_a_new_instrument_when_the_menu_is_empty(
        self, init_env: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        answers = InitAnswers(
            environment="production",
            api_base_url="http://proxy.test/api/v1",
            api_key="dhub_abc",
            watch_directory=init_env["watch"],
            instrument=NewInstrument("first-one"),
            existing_instruments=0,
        )

        result, client, _ = run_init(init_env, monkeypatch, answers, listed=0)

        assert result.exit_code == 0, result.output
        assert client.created == ("first-one", "First One")

    def test_a_custom_run_detection_regex(
        self, init_env: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        answers = InitAnswers(
            environment="production",
            api_base_url="http://proxy.test/api/v1",
            api_key="dhub_abc",
            watch_directory=init_env["watch"],
            run_detection=r"^run-(\d+)/",
            recursive=True,
        )

        result, _, config_path = run_init(init_env, monkeypatch, answers, listed=2)

        assert result.exit_code == 0, result.output
        assert load_config(config_path).instrument.run_detection.pattern == r"^run-(\d+)/"

    def test_the_saved_key_and_the_overwrite_question(
        self, init_env: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        init_env["env_file"].write_text("DATA_HUB_API_KEY='dhub_saved'\n")
        monkeypatch.setenv("DATA_HUB_API_KEY", "dhub_saved")
        (init_env["tmp"] / "config.yaml").write_text("old: config\n")
        answers = InitAnswers(
            environment="production",
            api_base_url="http://proxy.test/api/v1",
            api_key=None,
            use_saved_key=True,
            overwrite_config=True,
            watch_directory=init_env["watch"],
        )

        result, _, config_path = run_init(init_env, monkeypatch, answers, listed=2)

        assert result.exit_code == 0, result.output
        assert "Use the saved key?" in result.output
        assert load_config(config_path).instrument.id == "existing-one"
        assert init_env["saved_keys"] == ["dhub_saved"]

    def test_declining_the_overwrite_ends_init_untouched(
        self, init_env: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        config_path = init_env["tmp"] / "config.yaml"
        config_path.write_text("old: config\n")
        answers = InitAnswers(
            environment="production",
            api_base_url="unused",
            api_key="unused",
            overwrite_config=False,
            watch_directory=init_env["watch"],
        )

        result, client, _ = run_init(init_env, monkeypatch, answers, listed=2)

        assert result.exit_code == 0
        assert client.registered_for is None
        assert config_path.read_text() == "old: config\n"

    def test_a_key_is_needed_unless_the_saved_one_is_used(self) -> None:
        answers = InitAnswers(
            environment="production", api_base_url="x", api_key=None, watch_directory="/tmp"
        )

        with pytest.raises(ValueError, match="api_key is needed"):
            answers.stdin_text()

    def test_stdin_text_lists_the_answers_in_order(self) -> None:
        answers = InitAnswers(
            environment="production",
            api_base_url="http://x/api/v1",
            api_key="dhub_k",
            watch_directory="/data",
            file_patterns=["*.csv"],
            stability_period_seconds=3,
            upload_mode="manual",
        )

        assert answers.stdin_text().splitlines() == [
            "production",
            "http://x/api/v1",
            "dhub_k",
            "1",
            "/data",
            "*.csv",
            "2",
            "",
            "3",
            "manual",
        ]


# ---------------------------------------------------------------------------
# Environment and env files
# ---------------------------------------------------------------------------


def test_clean_environment_drops_what_would_change_the_watcher() -> None:
    cleaned = clean_environment(
        {
            "PATH": "/usr/bin",
            "HOME": "/home/me",
            "DATA_HUB_API_KEY": "dhub_real",
            "DATA_HUB_WATCHER_HEARTBEAT_INTERVAL_SECONDS": "1",
            "DATA_HUB_CONFIG_PATH": "/elsewhere",
            "VIRTUAL_ENV": "/repo/.venv",
            "PYTHONPATH": "/repo",
        }
    )

    assert cleaned == {"PATH": "/usr/bin", "HOME": "/home/me", "NO_PROXY": "127.0.0.1,localhost"}


def test_clean_environment_drops_package_index_python_and_proxy_settings() -> None:
    kept = {"PATH": "/usr/bin", "UV_CACHE_DIR": "/cache", "LANG": "C"}
    cleaned = clean_environment(
        {
            **kept,
            "UV_PYTHON": "3.9",
            "UV_INDEX": "https://index.example/simple",
            "UV_INDEX_URL": "https://index.example/simple",
            "UV_INDEX_INTERNAL_PASSWORD": "secret",
            "UV_EXTRA_INDEX_URL": "https://extra.example/simple",
            "UV_DEFAULT_INDEX": "https://default.example/simple",
            "PIP_INDEX_URL": "https://pip.example/simple",
            "PIP_REQUIRE_VIRTUALENV": "1",
            "HTTP_PROXY": "http://proxy:3128",
            "http_proxy": "http://proxy:3128",
            "HTTPS_PROXY": "http://proxy:3128",
            "https_proxy": "http://proxy:3128",
            "ALL_PROXY": "socks5://proxy:1080",
            "all_proxy": "socks5://proxy:1080",
            "no_proxy": "corp.example",
            "NO_PROXY": "corp.example",
        }
    )

    # What stays, and a NO_PROXY that keeps everything local off any proxy.
    assert cleaned == {**kept, "NO_PROXY": "127.0.0.1,localhost"}


def test_the_environment_of_the_watcher_process_has_no_proxy_either(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy:3128")
    monkeypatch.setenv("UV_PYTHON", "3.9")
    monkeypatch.setattr(drivers, "uv_environment", lambda: {})

    env = make_driver(tmp_path).process_environment()

    assert "HTTPS_PROXY" not in env and "UV_PYTHON" not in env
    assert env["NO_PROXY"] == "127.0.0.1,localhost"


def make_driver(tmp_path: Path) -> CliDriver:
    return CliDriver(
        home=tmp_path / "home",
        tool_install=ToolInstall(tmp_path / "install"),
        instrument_id="inst-one",
        watch_dir=tmp_path / "watch",
        environment="production",
        api_base_url="http://127.0.0.1:1/api/v1",
        api_key="dhub_key",
    )


class TestEnvFile:
    def test_writes_the_key_and_the_overrides(self, tmp_path: Path) -> None:
        driver = make_driver(tmp_path)

        path = driver.write_env("dhub_key", {"DATA_HUB_WATCHER_HEARTBEAT_INTERVAL_SECONDS": "2"})

        assert path == tmp_path / "home" / ".data-hub" / ".env.production"
        assert path.read_text().splitlines() == [
            "DATA_HUB_WATCHER_HEARTBEAT_INTERVAL_SECONDS=2",
            "DATA_HUB_API_KEY='dhub_key'",
        ]

    def test_keeps_the_saved_key_and_removes_an_override_set_to_none(self, tmp_path: Path) -> None:
        driver = make_driver(tmp_path)
        driver.write_env("dhub_key", {"A_VAR": "1", "B_VAR": "2"})

        driver.write_env(None, {"A_VAR": None, "C_VAR": "3"})

        assert driver.env_path.read_text().splitlines() == [
            "B_VAR=2",
            "DATA_HUB_API_KEY='dhub_key'",
            "C_VAR=3",
        ]

    def test_a_new_key_replaces_the_old_one(self, tmp_path: Path) -> None:
        driver = make_driver(tmp_path)
        driver.write_env("dhub_old")

        driver.write_env("dhub_new")

        assert driver.env_path.read_text() == "DATA_HUB_API_KEY='dhub_new'\n"


def test_the_tool_install_path_is_one_the_watcher_recognises_as_uv_tool(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from data_hub_watcher import self_update
    from data_hub_watcher.self_update import InstallMethod, detect_install_method

    class WheelInstall:
        """The metadata of a non-editable install: no `direct_url.json` says editable."""

        def read_text(self, name: str) -> None:
            return None

    monkeypatch.setattr(self_update, "distribution", lambda name: WheelInstall())
    install = ToolInstall(tmp_path / "private-install")

    # `detect_install_method` looks for this fragment in `sys.prefix`.
    prefix = str(install.tool_dir / "data-hub-watcher")
    assert "/uv/tools/data-hub-watcher" in prefix.replace("\\", "/")
    assert install.bin_dir == tmp_path / "private-install" / "uv" / "bin"
    assert install.environment() == {
        "UV_TOOL_DIR": str(install.tool_dir),
        "UV_TOOL_BIN_DIR": str(install.bin_dir),
    }
    assert detect_install_method(prefix=prefix) is InstallMethod.UV_TOOL


# ---------------------------------------------------------------------------
# The CLI driver, against a stand-in for `data-hub-watcher`
# ---------------------------------------------------------------------------

FAKE_WATCHER = """\
    #!{python}
    import os, signal, sqlite3, subprocess, sys, time

    mode = os.environ.get("FAKE_MODE", "graceful")
    if sys.argv[1:2] == ["--version"]:
        print("data-hub-watcher, version 1.2.3")
        sys.exit(0)
    if "echo" in sys.argv[1:]:
        print("home=" + os.environ["HOME"])
        print("api_key_set=" + str("DATA_HUB_API_KEY" in os.environ))
        print("path=" + os.environ.get("PATH", ""))
        print("argv=" + " ".join(sys.argv[1:]))
        print("stdin=" + sys.stdin.read().strip())
        sys.exit(int(os.environ.get("FAKE_EXIT", "0")))

    time.sleep(float(os.environ.get("FAKE_START_DELAY", "0")))
    for line in os.environ.get("FAKE_STDERR", "").split("|"):
        if line:
            print(line, file=sys.stderr, flush=True)
    print("argv=" + " ".join(sys.argv[1:]), flush=True)
    print("Press Ctrl+C to stop.", flush=True)

    def stop(signum, frame):
        print("stopping", flush=True)
        sys.exit(0)

    if mode == "graceful":
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
    elif mode == "stubborn":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
    elif mode == "exit1":
        sys.exit(1)
    elif mode == "insert":
        # Write a row to the state database all the time, as the watcher does.
        conn = sqlite3.connect(os.environ["FAKE_DB"], timeout=30)
        while True:
            conn.execute("INSERT INTO pending_uploads VALUES ('RUN/a.csv')")
            conn.commit()
            time.sleep(0.05)
    elif mode == "orphan":
        # Leave a child behind in the process group, as the `uv` of an update can be.
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"])
        with open(os.environ["FAKE_CHILD_PIDFILE"], "w") as handle:
            handle.write(str(child.pid))
        sys.exit(0)
    while True:
        time.sleep(0.05)
"""


def _group_survivors(groups: Iterator[int] | tuple[int, ...]) -> list[int]:
    """The pids of live processes (not zombies) in any of the process groups."""
    wanted = set(groups)
    listing = subprocess.run(
        ["ps", "-axo", "pid=,pgid=,stat="], capture_output=True, text=True, check=True
    ).stdout
    survivors: list[int] = []
    for line in listing.splitlines():
        parts = line.split()
        if len(parts) == 3 and int(parts[1]) in wanted and not parts[2].startswith("Z"):
            survivors.append(int(parts[0]))
    return survivors


@pytest.fixture
def fake_driver(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[CliDriver]:
    """A driver whose ``data-hub-watcher`` is a script that behaves as ``FAKE_MODE`` says.

    It is closed when the test ends, and then nothing started in its process groups may be
    left alive, however the test ended: a stand-in that runs for ever and leaks is how 65
    processes were once found orphaned after the unit tests.
    """
    monkeypatch.setattr(drivers, "uv_environment", lambda: {})
    driver = make_driver(tmp_path)
    driver.tool_install.bin_dir.mkdir(parents=True)
    script = driver.tool_install.executable
    script.write_text(textwrap.dedent(FAKE_WATCHER).format(python=sys.executable))
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    yield driver
    driver.close()
    leftovers: list[int] = []
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        leftovers = _group_survivors(driver.launched_pids)
        if not leftovers:
            return
        time.sleep(0.1)
    for pid in leftovers:
        os.kill(pid, signal.SIGKILL)
    pytest.fail(f"close() left these processes of the watcher alive: {leftovers}")


def make_state_db(driver: CliDriver, extra_tables: int = 0) -> None:
    """A state database like the watcher's, as far as the driver's helpers need it."""
    driver.config_dir().mkdir(parents=True, exist_ok=True)
    with contextlib.closing(sqlite3.connect(driver.state_db_path())) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("CREATE TABLE pending_uploads (relative_path TEXT)")
        conn.execute("CREATE TABLE meta (key TEXT, value TEXT)")
        for number in range(extra_tables):
            conn.execute(f"CREATE TABLE filler_{number} (x)")
        conn.commit()


def triggers(driver: WatcherDriver) -> list[str]:
    rows = driver.state_query("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
    return [str(name) for (name,) in rows]


@posix_only
class TestCliDriver:
    def test_start_waits_until_the_watcher_is_ready_and_stop_exits_cleanly(
        self, fake_driver: CliDriver
    ) -> None:
        fake_driver.extra_environment["FAKE_START_DELAY"] = "0.5"
        started = time.monotonic()

        fake_driver.start()

        assert time.monotonic() - started >= 0.5
        assert fake_driver.is_running()
        assert fake_driver.exit_code is None
        assert fake_driver.stop() == 0
        assert not fake_driver.is_running()
        assert fake_driver.pid is None
        assert "stopping" in fake_driver.output()
        assert "Press Ctrl+C to stop." in fake_driver.log_text()

    def test_start_can_return_before_the_watcher_is_ready(self, fake_driver: CliDriver) -> None:
        fake_driver.extra_environment["FAKE_START_DELAY"] = "1"

        fake_driver.start(wait_ready=False)

        assert fake_driver.is_running()
        assert "Press Ctrl+C" not in fake_driver.output()
        fake_driver.wait_until_ready()
        assert "Press Ctrl+C" in fake_driver.output()

    def test_interrupt_and_kill_give_their_exit_codes(self, fake_driver: CliDriver) -> None:
        fake_driver.start()
        fake_driver.interrupt()
        assert fake_driver.wait_exit(10) == 0

        fake_driver.start()
        fake_driver.kill()
        assert fake_driver.exit_code == -9
        assert not fake_driver.is_running()

    def test_a_watcher_that_exits_on_its_own_ends_a_wait_for_ready(
        self, fake_driver: CliDriver
    ) -> None:
        fake_driver.extra_environment["FAKE_MODE"] = "exit1"

        fake_driver.start()

        assert fake_driver.wait_exit(10) == 1

    def test_restart_starts_it_again_after_it_stopped_or_ran(self, fake_driver: CliDriver) -> None:
        fake_driver.start()
        first = fake_driver.pid

        fake_driver.restart()

        assert fake_driver.is_running()
        assert fake_driver.pid != first
        fake_driver.restart(graceful=False)
        assert fake_driver.is_running()
        assert len(fake_driver.log_files()) == 6

    def test_starting_twice_is_refused(self, fake_driver: CliDriver) -> None:
        fake_driver.start()

        with pytest.raises(RuntimeError, match="already running"):
            fake_driver.start()

    def test_wait_exit_times_out_with_the_log_tail(
        self, fake_driver: CliDriver, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(drivers, "_CLOSE_GRACE_SECONDS", 0.3)  # For the fixture's close().
        fake_driver.extra_environment["FAKE_MODE"] = "stubborn"
        fake_driver.start()
        fake_driver.request_stop()

        with pytest.raises(WaitTimeout, match="still running 0.3 s after it was asked to stop"):
            fake_driver.wait_exit(0.3)

    def test_wait_for_log_finds_a_line_and_fails_with_the_tail(
        self, fake_driver: CliDriver
    ) -> None:
        fake_driver.extra_environment["FAKE_STDERR"] = "one|Initial scan complete: 3"
        fake_driver.start()

        assert fake_driver.wait_for_log(r"Initial scan complete: \d+", 1).startswith("Initial scan")
        with pytest.raises(WaitTimeout, match="a log line matching 'never happens'"):
            fake_driver.wait_for_log("never happens", 0.2)

    def test_run_cli_isolates_home_and_the_key_and_pipes_stdin(
        self, fake_driver: CliDriver, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("DATA_HUB_API_KEY", "dhub_from_my_shell")

        result = fake_driver.run_cli("echo", input="some answers\n")

        assert result.returncode == 0
        assert f"home={fake_driver.home}" in result.stdout
        assert "api_key_set=False" in result.stdout
        assert "stdin=some answers" in result.stdout
        assert result.args == ("echo",)
        assert os.environ["DATA_HUB_API_KEY"] == "dhub_from_my_shell"

    def test_the_state_database_is_queried_when_it_exists(self, fake_driver: CliDriver) -> None:
        assert fake_driver.state_query("SELECT 1") == []
        fake_driver.config_dir().mkdir(parents=True)
        with sqlite3.connect(fake_driver.state_db_path()) as conn:
            conn.execute("CREATE TABLE pending_uploads (relative_path TEXT)")
            conn.execute("INSERT INTO pending_uploads VALUES ('RUN1/a.csv')")

        assert fake_driver.state_query("SELECT relative_path FROM pending_uploads") == [
            ("RUN1/a.csv",)
        ]

    def test_the_group_options_go_before_the_command(self, fake_driver: CliDriver) -> None:
        result = fake_driver.run_cli("echo", global_args=("--config", "/x/config.yaml"))

        assert "argv=--config /x/config.yaml echo" in result.stdout

        fake_driver.start(args=["--dry-run"], global_args=["--verbose"])

        assert "argv=--verbose watch --dry-run" in fake_driver.output()

    def test_pid_is_the_running_process_and_none_otherwise(self, fake_driver: CliDriver) -> None:
        assert fake_driver.pid is None

        fake_driver.start()
        first = fake_driver.pid

        assert first is not None
        assert first == fake_driver.launched_pids[-1]
        assert fake_driver.pid == first  # Reading it again is the same process.
        assert fake_driver.stop() == 0
        assert fake_driver.pid is None
        fake_driver.start()
        assert fake_driver.pid not in (None, first)

    def test_it_says_what_the_watcher_calls_things(self, fake_driver: CliDriver) -> None:
        assert (fake_driver.kind, fake_driver.role) == ("cli", "Watcher")
        assert fake_driver.started_prefix == "Watcher started on "
        assert fake_driver.resumed_prefix == "Watcher resumed on "
        assert fake_driver.restarted_prefix == "Watcher restarted on "
        assert fake_driver.operator_stop_message == "Watcher stopped by user"
        assert fake_driver.update_stop_message == "Watcher restarting for auto-update"

    def test_the_service_wording_comes_from_its_kind_and_role(self, tmp_path: Path) -> None:
        class ServiceLike(CliDriver):
            kind = "service"
            role = "Service"

        service = ServiceLike(
            home=tmp_path / "home",
            tool_install=ToolInstall(tmp_path / "install"),
            instrument_id="inst-one",
            watch_dir=tmp_path / "watch",
            api_base_url="http://127.0.0.1:1/api/v1",
            api_key="dhub_key",
        )

        assert service.started_prefix == "Service started on "
        assert service.resumed_prefix == "Service resumed on "
        assert service.restarted_prefix == "Service restarted on "
        # The upgrade worker stops the service, so an update says what any stop says.
        assert service.operator_stop_message == "Service stopped"
        assert service.update_stop_message == "Service stopped"

    def test_the_wording_is_what_the_watcher_says(self) -> None:
        # The driver's text must stay in step with the watcher's own.
        from data_hub_watcher import cli as cli_source
        from data_hub_watcher import runtime

        runtime_source = Path(runtime.__file__).read_text()
        cli_text = Path(cli_source.__file__).read_text()
        assert 'f"{self.role} started on {self.host}"' in runtime_source
        assert 'f"{self.role} resumed on {self.host}"' in runtime_source
        assert 'f"{self.role} restarted on {self.host}' in runtime_source
        assert 'f"{role} restarting for auto-update"' in runtime_source
        assert 'stopped_message="Watcher stopped by user"' in cli_text
        assert 'role="Watcher"' in cli_text

    def test_await_upgrade_restart_expects_exit_code_one_and_starts_it_again(
        self, fake_driver: CliDriver
    ) -> None:
        fake_driver.extra_environment["FAKE_MODE"] = "exit1"
        fake_driver.start()

        fake_driver.await_upgrade_restart(10)

        assert len(fake_driver.launched_pids) == 2

    def test_await_upgrade_restart_refuses_any_other_exit_code(
        self, fake_driver: CliDriver
    ) -> None:
        fake_driver.start()
        fake_driver.request_stop()

        with pytest.raises(AssertionError, match="exited with 0 after an update, not the"):
            fake_driver.await_upgrade_restart(10)

        assert len(fake_driver.launched_pids) == 1

    def test_await_upgrade_restart_times_out_while_the_watcher_runs(
        self, fake_driver: CliDriver
    ) -> None:
        fake_driver.start()

        with pytest.raises(WaitTimeout):
            fake_driver.await_upgrade_restart(0.3)

    def test_installed_version_is_what_the_install_reports(self, fake_driver: CliDriver) -> None:
        assert fake_driver.installed_version() == "1.2.3"

    def test_hide_uv_leaves_the_watcher_an_empty_path(self, fake_driver: CliDriver) -> None:
        fake_driver.write_env("dhub_key", {"A_VAR": "1"})

        fake_driver.hide_uv()

        lines = fake_driver.env_path.read_text().splitlines()
        [path_line] = [line for line in lines if line.startswith("PATH=")]
        nowhere = Path(path_line.removeprefix("PATH="))
        assert nowhere.is_dir() and list(nowhere.iterdir()) == []
        assert os.pathsep not in path_line
        assert "A_VAR=1" in lines and "DATA_HUB_API_KEY='dhub_key'" in lines

    def test_log_text_is_the_captured_output_in_run_order_with_nothing_repeated(
        self, fake_driver: CliDriver
    ) -> None:
        # The CLI logs to the console and to watcher.log, so every record is in both.
        fake_driver.config_dir().mkdir(parents=True)
        (fake_driver.config_dir() / "watcher.log").write_text("a record\n")
        fake_driver.extra_environment["FAKE_STDERR"] = "a record"
        fake_driver.start()
        fake_driver.stop()

        text = fake_driver.log_text()

        assert text.count("a record") == 1
        assert "Press Ctrl+C to stop." in text
        # The artifacts get everything, watcher.log first.
        assert fake_driver.log_files()[0].name == "watcher.log"
        assert [p.name for p in fake_driver.log_files()[1:]] == [
            "watch-1.stdout.log",
            "watch-1.stderr.log",
        ]

    def test_runs_are_read_in_the_order_they_happened_not_by_file_name(
        self, fake_driver: CliDriver
    ) -> None:
        fake_driver._log_dir.mkdir(parents=True)
        fake_driver._run_count = 11
        for number in range(1, 12):
            (fake_driver._log_dir / f"watch-{number}.stdout.log").write_text(f"run {number}\n")
        names = [p.name for p in fake_driver.log_files()]

        order = [int(line.split()[1]) for line in fake_driver.log_text().splitlines()]

        assert order == list(range(1, 12))
        assert names.index("watch-2.stdout.log") < names.index("watch-10.stdout.log")

    def test_a_mark_limits_the_log_to_what_came_after_it(self, fake_driver: CliDriver) -> None:
        fake_driver.extra_environment["FAKE_STDERR"] = "first run"
        fake_driver.start()
        fake_driver.stop()
        mark = fake_driver.mark_logs()
        # More is written to the same run's file, and a new run starts.
        with (fake_driver._log_dir / "watch-1.stderr.log").open("a") as handle:
            handle.write("late line of the first run\n")
        fake_driver.extra_environment["FAKE_STDERR"] = "second run"
        fake_driver.start()

        text = fake_driver.log_text(since=mark)

        assert "late line of the first run" in text
        assert "second run" in text
        assert "first run" not in text.replace("late line of the first run", "")
        assert "first run" in fake_driver.log_text()
        assert fake_driver.wait_for_log("second run", 5, since=mark) == "second run"
        with pytest.raises(WaitTimeout, match=r"a log line matching '\^first run'"):
            fake_driver.wait_for_log(r"^first run", 0.3, since=mark)
        fake_driver.stop()

    def test_the_log_can_start_part_way_into_a_file_the_driver_shares(
        self, fake_driver: CliDriver
    ) -> None:
        fake_driver.extra_environment["FAKE_STDERR"] = "someone else's line|my line"
        fake_driver.start()
        fake_driver.stop()
        stderr = fake_driver._log_dir / "watch-1.stderr.log"

        fake_driver._log_baseline[stderr] = len("someone else's line\n")
        assert fake_driver.log_text().splitlines().count("my line") == 1
        assert "someone else's line" not in fake_driver.log_text()
        # A file that was replaced by a shorter one is read from its start.
        fake_driver._log_baseline[stderr] = 10_000
        assert "my line" in fake_driver.log_text()

    def test_state_execute_changes_the_database(self, fake_driver: CliDriver) -> None:
        with pytest.raises(FileNotFoundError, match="Start the watcher first"):
            fake_driver.state_execute("DELETE FROM pending_uploads")
        make_state_db(fake_driver)

        fake_driver.state_execute("INSERT INTO pending_uploads VALUES (?)", ("RUN1/a.csv",))

        assert fake_driver.state_query("SELECT relative_path FROM pending_uploads") == [
            ("RUN1/a.csv",)
        ]

    def test_fail_writes_refuses_inserts_for_the_block_and_always_drops_the_trigger(
        self, fake_driver: CliDriver
    ) -> None:
        make_state_db(fake_driver)

        with pytest.raises(RuntimeError, match="the block failed"):
            with fake_driver.fail_writes("pending_uploads", "it's refused"):
                with pytest.raises(sqlite3.IntegrityError, match="it's refused"):
                    fake_driver.state_execute("INSERT INTO pending_uploads VALUES ('x')")
                # Other tables are not touched.
                fake_driver.state_execute("INSERT INTO meta VALUES ('k', 'v')")
                raise RuntimeError("the block failed")

        assert triggers(fake_driver) == []
        fake_driver.state_execute("INSERT INTO pending_uploads VALUES ('x')")
        assert fake_driver.state_query("SELECT count(*) FROM pending_uploads") == [(1,)]

    def test_a_failed_insert_does_not_leave_the_watchers_connection_holding_the_lock(
        self, fake_driver: CliDriver
    ) -> None:
        make_state_db(fake_driver)
        # The watcher's connection opens a transaction itself before an insert, and a statement
        # that only aborted would leave it open.
        watcher_side = sqlite3.connect(fake_driver.state_db_path())

        with fake_driver.fail_writes("pending_uploads"):
            with pytest.raises(sqlite3.IntegrityError, match="injected"):
                watcher_side.executemany("INSERT INTO pending_uploads VALUES (?)", [("x",)])
            assert not watcher_side.in_transaction
            # Another writer is not kept waiting by it, and dropping the trigger works at once.
            fake_driver.state_execute("INSERT INTO meta VALUES ('k', 'v')")

        assert triggers(fake_driver) == []
        watcher_side.close()

    def test_a_trigger_helper_takes_plain_table_names_only(self, fake_driver: CliDriver) -> None:
        make_state_db(fake_driver)

        with pytest.raises(ValueError, match="not a plain table name"):
            with fake_driver.fail_writes("pending_uploads; DROP TABLE meta"):
                pass
        with pytest.raises(ValueError, match="not a plain table name"):
            with fake_driver.stall_writes("a b"):
                pass

    def test_stall_writes_holds_a_watcher_inside_the_insert_and_kills_a_stuck_one_at_the_end(
        self, fake_driver: CliDriver
    ) -> None:
        # Many tables make the trigger's cross join impossibly large.
        make_state_db(fake_driver, extra_tables=30)
        fake_driver.extra_environment.update(
            FAKE_MODE="insert", FAKE_DB=str(fake_driver.state_db_path())
        )
        fake_driver.start()
        wait_until(
            lambda: fake_driver.state_query("SELECT count(*) FROM pending_uploads")[0][0] > 1,
            10,
            what="the stand-in to write rows",
        )

        with fake_driver.stall_writes("pending_uploads"):
            assert triggers(fake_driver) == ["e2e_stall_pending_uploads"]
            rows = fake_driver.state_query("SELECT count(*) FROM pending_uploads")[0][0]
            # Stuck in an insert: no row is added for as long as we look.
            stays_true(
                lambda: (
                    fake_driver.state_query("SELECT count(*) FROM pending_uploads")[0][0]
                    in (rows, rows + 1)
                ),
                1.5,
                what="the stand-in to be stuck",
            )
            assert fake_driver.is_running()

        # The block ended with the watcher still stuck in the trigger, so it was killed, and the
        # trigger was dropped nevertheless.
        assert not fake_driver.is_running()
        assert fake_driver.exit_code == -signal.SIGKILL
        assert triggers(fake_driver) == []

    def test_stall_writes_drops_its_trigger_when_the_watcher_was_killed_inside_the_block(
        self, fake_driver: CliDriver
    ) -> None:
        make_state_db(fake_driver, extra_tables=30)
        fake_driver.extra_environment.update(
            FAKE_MODE="insert", FAKE_DB=str(fake_driver.state_db_path())
        )
        fake_driver.start()

        with fake_driver.stall_writes("pending_uploads"):
            wait_until(lambda: triggers(fake_driver), 5, what="the trigger")
            fake_driver.kill()

        assert triggers(fake_driver) == []
        fake_driver.state_execute("INSERT INTO pending_uploads VALUES ('after')")

    def test_close_kills_a_child_left_in_the_process_group(
        self, fake_driver: CliDriver, tmp_path: Path
    ) -> None:
        pidfile = tmp_path / "child.pid"
        fake_driver.extra_environment.update(FAKE_MODE="orphan", FAKE_CHILD_PIDFILE=str(pidfile))
        fake_driver.start()
        assert fake_driver.wait_exit(10) == 0
        child = int(pidfile.read_text())
        # The watcher is gone, and what it started is still running.
        assert _group_survivors(fake_driver.launched_pids) == [child]

        fake_driver.close()

        wait_until(
            lambda: not _group_survivors(fake_driver.launched_pids), 5, what="the child to die"
        )

    def test_a_stand_in_that_ignores_sigterm_is_killed_at_the_end(
        self, fake_driver: CliDriver, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake_driver.extra_environment["FAKE_MODE"] = "stubborn"
        fake_driver.start()
        monkeypatch.setattr(drivers, "_CLOSE_GRACE_SECONDS", 0.3)

        fake_driver.close()

        assert fake_driver.exit_code == -signal.SIGKILL
        assert _group_survivors(fake_driver.launched_pids) == []
        fake_driver.close()  # Safe to call twice.


@posix_only
def test_lock_state_db_blocks_writers_until_the_block_ends(
    fake_driver: CliDriver,
) -> None:
    fake_driver.config_dir().mkdir(parents=True)
    with sqlite3.connect(fake_driver.state_db_path()) as setup:
        setup.execute("PRAGMA journal_mode=WAL")
        setup.execute("CREATE TABLE meta (key TEXT, value TEXT)")

    with fake_driver.lock_state_db():
        other = sqlite3.connect(fake_driver.state_db_path(), timeout=0.2)
        with pytest.raises(sqlite3.OperationalError, match="locked"):
            other.execute("INSERT INTO meta VALUES ('a', 'b')")
        # Readers carry on, which is what the watcher's own reads do.
        assert other.execute("SELECT count(*) FROM meta").fetchone() == (0,)
        other.close()

    with sqlite3.connect(fake_driver.state_db_path(), timeout=1) as after:
        after.execute("INSERT INTO meta VALUES ('a', 'b')")


def _hold_the_write_lock(
    driver: CliDriver, *, start_after: float, seconds: float
) -> threading.Thread:
    """Take the state database's write lock after ``start_after`` seconds and keep it for
    ``seconds``, from a thread, as a watcher stuck inside a write would."""

    def hold() -> None:
        time.sleep(start_after)
        with driver.lock_state_db():
            time.sleep(seconds)

    thread = threading.Thread(target=hold, daemon=True)
    thread.start()
    return thread


@posix_only
class TestWaitForStateDbBusy:
    def make(self, fake_driver: CliDriver) -> CliDriver:
        make_state_db(fake_driver)
        return fake_driver

    def test_it_returns_once_the_lock_has_been_held_for_the_whole_time(
        self, fake_driver: CliDriver
    ) -> None:
        driver = self.make(fake_driver)
        holder = _hold_the_write_lock(driver, start_after=0.3, seconds=3)
        started = time.monotonic()

        driver.wait_for_state_db_busy(hold_seconds=1.0, timeout=10)

        # The lock was taken at about 0.3 s, so a hold of one second is seen at about 1.3 s,
        # while it is still held.
        assert 1.0 <= time.monotonic() - started < 2.8
        holder.join(10)

    def test_a_lock_that_is_let_go_of_early_does_not_count(self, fake_driver: CliDriver) -> None:
        driver = self.make(fake_driver)
        holder = _hold_the_write_lock(driver, start_after=0.1, seconds=0.4)

        with pytest.raises(WaitTimeout, match="hold the write lock of its state database"):
            driver.wait_for_state_db_busy(hold_seconds=1.5, timeout=2.5)

        holder.join(10)

    def test_a_free_database_is_never_busy_and_the_probe_leaves_it_writable(
        self, fake_driver: CliDriver
    ) -> None:
        driver = self.make(fake_driver)

        with pytest.raises(WaitTimeout, match="never|hold the write lock"):
            driver.wait_for_state_db_busy(hold_seconds=0.3, timeout=0.5)

        driver.state_execute("INSERT INTO pending_uploads VALUES ('after')")

    def test_a_database_that_does_not_exist_yet_is_waited_for(self, fake_driver: CliDriver) -> None:
        with pytest.raises(WaitTimeout, match="hold the write lock of its state database"):
            fake_driver.wait_for_state_db_busy(hold_seconds=0.1, timeout=0.3)


class TestSilenceHeartbeats:
    @contextlib.contextmanager
    def upstream_and_proxy(self) -> Iterator[tuple[FaultProxy, list[str]]]:
        """A server that records the paths it gets, and a fault proxy in front of it."""
        reached: list[str] = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                reached.append(self.path)
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, format: str, *args: object) -> None:
                pass

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        thread.start()
        try:
            with FaultProxy(f"http://127.0.0.1:{upstream.server_address[1]}") as proxy:
                yield proxy, reached
        finally:
            upstream.shutdown()
            upstream.server_close()

    @staticmethod
    def beat(proxy: FaultProxy, watcher: str) -> int:
        request = urllib.request.Request(
            f"{proxy.base_url}/api/v1/watchers/{watcher}/heartbeat", data=b"{}", method="POST"
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status
        except urllib.error.HTTPError as exc:
            return exc.code

    def test_it_returns_after_a_refusal_and_nothing_gets_through_after_it(self) -> None:
        with self.upstream_and_proxy() as (proxy, reached):
            stop = threading.Event()

            def heartbeats() -> None:
                while not stop.wait(0.1):
                    self.beat(proxy, "w1")

            sender = threading.Thread(target=heartbeats, daemon=True)
            sender.start()
            wait_until(lambda: reached, 5, what="a heartbeat to get through")

            rule = silence_heartbeats(proxy, "w1", timeout=5)

            # Every heartbeat that was sent has been answered, and they stop reaching the server.
            gone_through = len(reached)
            seen = len(proxy.requests)
            wait_until(lambda: len(proxy.requests) >= seen + 3, 5, what="three more heartbeats")
            assert len(reached) == gone_through
            stop.set()
            sender.join(5)
            proxy.remove_fault(rule)
            assert self.beat(proxy, "w1") == 200

    def test_the_other_watchers_are_left_alone_when_one_is_named(self) -> None:
        with self.upstream_and_proxy() as (proxy, reached):
            waiter = threading.Thread(
                target=lambda: silence_heartbeats(proxy, "w1", timeout=5), daemon=True
            )
            waiter.start()

            # `w1` heartbeats until the helper's fault is in place and refuses one.
            wait_until(
                lambda: self.beat(proxy, "w1") == 503, 5, what="a heartbeat of w1 to be refused"
            )
            waiter.join(5)
            assert not waiter.is_alive()
            # `w2` is not affected.
            assert self.beat(proxy, "w2") == 200
            assert reached[-1] == "/api/v1/watchers/w2/heartbeat"

    def test_an_earlier_refusal_does_not_count(self) -> None:
        with self.upstream_and_proxy() as (proxy, _):
            with proxy.fault("status", path=r"/heartbeat$", status=503):
                assert self.beat(proxy, "w1") == 503

            with pytest.raises(TimeoutError):
                silence_heartbeats(proxy, "w1", timeout=0.5)


class TestInstallWheel:
    def test_a_reinstall_is_asked_for_only_when_wanted(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        commands: list[list[str]] = []
        root = tmp_path / "install"

        def fake_run(command: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
            commands.append(command)
            executable = ToolInstall(root).executable
            executable.parent.mkdir(parents=True, exist_ok=True)
            executable.touch()
            return subprocess.CompletedProcess(command, 0, "", "")

        monkeypatch.setattr(drivers.subprocess, "run", fake_run)
        monkeypatch.setattr(drivers, "uv_executable", lambda: "uv")
        monkeypatch.setattr(drivers, "uv_environment", lambda: {})
        wheel = tmp_path / "data_hub_watcher-1.0.0-py3-none-any.whl"

        install_watcher_tool(root, wheel)
        install_watcher_tool(root, wheel, reinstall=True)

        assert commands[0] == ["uv", "tool", "install", "--python", "3.12", str(wheel)]
        assert commands[1] == [
            "uv",
            "tool",
            "install",
            "--python",
            "3.12",
            "--reinstall",
            str(wheel),
        ]

    def test_the_shared_install_is_never_changed(self, tmp_path: Path) -> None:
        driver = make_driver(tmp_path)

        with pytest.raises(RuntimeError, match="own_install=True"):
            driver.install_wheel(tmp_path / "x.whl")

    def test_a_running_watcher_is_never_reinstalled_under(
        self, fake_driver: CliDriver, tmp_path: Path
    ) -> None:
        fake_driver.owns_install = True
        fake_driver.start()

        with pytest.raises(RuntimeError, match="Stop the watcher"):
            fake_driver.install_wheel(tmp_path / "x.whl")

    def test_the_wheel_is_reinstalled_into_the_pcs_own_install(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        driver = make_driver(tmp_path)
        driver.owns_install = True
        calls: list[tuple[Path, Path, str, bool]] = []

        def fake_install(
            root: Path, wheel: Path, *, python: str = "3.12", reinstall: bool = False, **_: Any
        ) -> ToolInstall:
            calls.append((root, wheel, python, reinstall))
            return ToolInstall(root)

        monkeypatch.setattr(drivers, "install_watcher_tool", fake_install)

        driver.install_wheel(tmp_path / "old.whl")

        assert calls == [(tmp_path / "install", tmp_path / "old.whl", "3.12", True)]


# ---------------------------------------------------------------------------
# Kinds of driver, the platforms marker and the factory
# ---------------------------------------------------------------------------


def test_which_driver_a_run_uses_comes_from_the_environment() -> None:
    assert active_driver_kind({}) == "cli"
    assert active_driver_kind({drivers.DRIVER_VARIABLE: ""}) == "cli"
    assert active_driver_kind({drivers.DRIVER_VARIABLE: "cli"}) == "cli"
    assert active_driver_kind({drivers.DRIVER_VARIABLE: " Service "}) == "service"
    with pytest.raises(ValueError, match="DATA_HUB_E2E_DRIVER='windows' is not one of"):
        active_driver_kind({drivers.DRIVER_VARIABLE: "windows"})


def test_the_cli_driver_is_the_class_of_the_cli_kind_and_the_service_waits_for_pr_3() -> None:
    assert driver_class_for("cli") is CliDriver
    assert CliDriver.kind == "cli"
    with pytest.raises(NotImplementedError, match="PR 3"):
        driver_class_for("service")


def test_a_platforms_marker_decides_which_kind_of_driver_runs_a_test() -> None:
    assert platforms_skip_reason(None, "test_a.py", "cli") is None
    assert platforms_skip_reason(None, "test_a.py", "service") is None
    assert platforms_skip_reason(("cli",), "test_a.py", "cli") is None
    assert platforms_skip_reason(("cli", "service"), "test_a.py", "service") is None
    assert platforms_skip_reason(("cli",), "test_a.py", "service") == (
        "this test is for the cli driver, and this run uses the service driver"
    )
    assert platforms_skip_reason(("service",), "test_a.py", "cli") is not None


def test_a_test_in_the_service_file_is_for_the_service_whatever_it_says() -> None:
    from e2e_support.catalog import SERVICE_TEST_FILE

    assert platforms_skip_reason(None, SERVICE_TEST_FILE, "service") is None
    assert platforms_skip_reason(None, SERVICE_TEST_FILE, "cli") is not None
    assert platforms_skip_reason(("cli", "service"), SERVICE_TEST_FILE, "cli") is not None
    assert "no driver" in (platforms_skip_reason(("cli",), SERVICE_TEST_FILE, "service") or "")


def test_a_platforms_marker_with_a_wrong_name_is_an_error_and_not_a_silent_skip() -> None:
    with pytest.raises(ValueError, match="not \\['linux'\\]"):
        platforms_skip_reason(("linux",), "test_a.py", "cli")
    with pytest.raises(ValueError, match="one or more of"):
        platforms_skip_reason((), "test_a.py", "cli")


def test_the_factory_refuses_a_wheel_without_an_install_of_its_own() -> None:
    nothing: Any = None
    factory = WatcherFactory(
        env=nothing,
        proxy=nothing,
        context=nothing,
        instrument_id="inst",
        watch_dir=Path("/nowhere"),
        watcher_token="dhub_key",
        driver_class=CliDriver,
        tool_install=nothing,
        new_install=lambda wheel: nothing,
        tmp_path=Path("/nowhere"),
    )

    with pytest.raises(ValueError, match="own_install=True"):
        factory(wheel=Path("data_hub_watcher-1.0.0-py3-none-any.whl"))


# ---------------------------------------------------------------------------
# The server's view
# ---------------------------------------------------------------------------


def uploaded_row(filename: str) -> FileRow:
    return FileRow(
        id=1,
        instrument_id="inst",
        run_id="RUN",
        relative_path=f"RUN/{filename}",
        filename=filename,
        status="uploaded",
        size_bytes=0,
        s3_bucket="raw",
        s3_key=f"inst/RUN/{filename}",
        upload_requested_at=None,
        uploaded_at=None,
        deleted_at=None,
        run_deleted_at=None,
        error_message=None,
    )


class TestWaitForUploaded:
    def view(self, *answers: bytes | None) -> ServerView:
        """A view whose stand-in answers each read in turn: bytes, or ``None`` for "no such
        object yet"."""
        view = ServerView(env=SimpleNamespace())  # type: ignore[arg-type]
        replies = iter(answers)

        def read_object(instrument_id: str, run_id: str, filename: str) -> bytes:
            reply = next(replies)
            if reply is None:
                raise FileNotFoundError(filename)
            return reply

        view.wait_for_file = lambda *a, **k: uploaded_row("empty.csv")  # type: ignore[method-assign]
        view.read_object = read_object  # type: ignore[method-assign]
        view.mirror_listing = lambda: []  # type: ignore[method-assign]
        return view

    def test_an_empty_file_is_done_when_the_stand_in_holds_it(self) -> None:
        view = self.view(b"")

        row = view.wait_for_uploaded("inst", "RUN", "RUN/empty.csv", content=b"", timeout=2)

        assert row.s3_key == "inst/RUN/empty.csv"

    def test_an_empty_file_that_arrives_late_is_waited_for(self) -> None:
        view = self.view(None, None, b"")

        view.wait_for_uploaded("inst", "RUN", "RUN/empty.csv", content=b"", timeout=5)

    def test_an_empty_file_that_should_have_bytes_is_a_mismatch(self) -> None:
        view = self.view(b"")

        with pytest.raises(AssertionError, match="stored 0 bytes that differ from the expected 3"):
            view.wait_for_uploaded("inst", "RUN", "RUN/empty.csv", content=b"abc", timeout=2)

    def test_a_missing_object_times_out_with_the_listing(self) -> None:
        view = self.view(*([None] * 100))

        with pytest.raises(WaitTimeout, match="the stand-in to hold inst/RUN/empty.csv"):
            view.wait_for_uploaded("inst", "RUN", "RUN/empty.csv", timeout=0.3)


class TestListWatchers:
    def view(self, paths: list[str]) -> ServerView:
        view = ServerView(env=SimpleNamespace())  # type: ignore[arg-type]

        def get(path: str, *, token: str | None = None) -> SimpleNamespace:
            paths.append(path)
            return SimpleNamespace(raise_for_status=lambda: None, body={"data": [{"id": "w1"}]})

        view.get = get  # type: ignore[method-assign]
        return view

    def test_the_filters_become_the_query_of_the_list_route(self) -> None:
        paths: list[str] = []
        view = self.view(paths)

        assert view.list_watchers() == [{"id": "w1"}]
        view.list_watchers(status="stale", instrument_id="inst one")

        assert paths == ["/api/v1/watchers", "/api/v1/watchers?status=stale&instrument_id=inst+one"]


# ---------------------------------------------------------------------------
# File helpers
# ---------------------------------------------------------------------------


class TestFileHelpers:
    def test_payload_is_repeatable_and_differs_by_seed(self) -> None:
        assert payload(100) == payload(100)
        assert len(payload(0)) == 0
        assert len(payload(5000)) == 5000
        assert payload(100, seed=1) != payload(100, seed=2)
        assert payload(50) == payload(100)[:50]

    def test_small_and_large_are_on_each_side_of_the_multipart_threshold(self) -> None:
        assert SMALL < MULTIPART_THRESHOLD_BYTES <= LARGE

    def test_write_file_creates_folders_and_returns_the_bytes(self, tmp_path: Path) -> None:
        target = tmp_path / "RUN1" / "deep" / "a.csv"

        data = write_file(target, 300)

        assert target.read_bytes() == data == payload(300)
        assert write_file(tmp_path / "b.csv", b"abc") == b"abc"

    def test_write_file_can_make_a_file_look_old(self, tmp_path: Path) -> None:
        target = tmp_path / "old.csv"

        write_file(target, mtime=1_000_000.0)

        assert target.stat().st_mtime == 1_000_000.0

    def test_write_run_defaults_to_one_file_each_side_of_the_threshold(
        self, tmp_path: Path
    ) -> None:
        written = write_run(tmp_path, "RUN7")

        assert sorted(written) == ["large.csv", "small.csv"]
        assert len(written["small.csv"]) == SMALL
        assert (tmp_path / "RUN7" / "large.csv").read_bytes() == written["large.csv"]
        assert len(written["large.csv"]) == LARGE

    def test_write_run_takes_names_with_sizes_or_bytes(self, tmp_path: Path) -> None:
        written = write_run(tmp_path, "RUN8", {"x.csv": 10, "y.csv": b"hello"})

        assert written == {"x.csv": payload(10), "y.csv": b"hello"}

    def test_a_growing_file_keeps_growing_until_stopped(self, tmp_path: Path) -> None:
        target = tmp_path / "RUN1" / "live.csv"

        with GrowingFile(target, chunk=b"ab", interval=0.02) as growing:
            deadline = time.monotonic() + 5
            while target.stat().st_size < 10 and time.monotonic() < deadline:
                time.sleep(0.01)
            grown = target.stat().st_size
        final = target.read_bytes()

        assert grown >= 10
        assert len(final) >= grown
        assert len(final) == growing.size
        time.sleep(0.1)
        assert target.read_bytes() == final
