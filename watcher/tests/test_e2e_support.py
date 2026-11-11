"""Unit tests for the helpers behind the end-to-end suite (``watcher/e2e/e2e_support``).

They need no server. The one that matters most for the rest of the suite is that
``InitAnswers`` still matches the prompts of the real ``init`` wizard: it is checked here, by
running ``init`` with a fake API client, so changing a prompt in ``cli.py`` fails this normal
test and not only the end-to-end run.
"""

from __future__ import annotations
import os
import stat
import sys
import textwrap
import time
from pathlib import Path
from typing import Any

import pytest
from click.testing import CliRunner

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
    clean_environment,
)
from e2e_support.waiting import WaitTimeout, stays_true, wait_until

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

    assert cleaned == {"PATH": "/usr/bin", "HOME": "/home/me"}


def make_driver(tmp_path: Path, executable: Path | None = None) -> CliDriver:
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
    import os, signal, sys, time

    mode = os.environ.get("FAKE_MODE", "graceful")
    if sys.argv[1:2] == ["echo"]:
        print("home=" + os.environ["HOME"])
        print("api_key_set=" + str("DATA_HUB_API_KEY" in os.environ))
        print("stdin=" + sys.stdin.read().strip())
        sys.exit(int(os.environ.get("FAKE_EXIT", "0")))

    time.sleep(float(os.environ.get("FAKE_START_DELAY", "0")))
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
    while True:
        time.sleep(0.05)
"""


@pytest.fixture
def fake_driver(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> CliDriver:
    monkeypatch.setattr(drivers, "uv_environment", lambda: {})
    driver = make_driver(tmp_path)
    driver.tool_install.bin_dir.mkdir(parents=True)
    script = driver.tool_install.executable
    script.write_text(textwrap.dedent(FAKE_WATCHER).format(python=sys.executable))
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return driver


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
        assert len(list(fake_driver.logs())) == 6

    def test_starting_twice_is_refused(self, fake_driver: CliDriver) -> None:
        fake_driver.start()

        with pytest.raises(RuntimeError, match="already running"):
            fake_driver.start()

    def test_wait_exit_times_out_with_the_log_tail(self, fake_driver: CliDriver) -> None:
        fake_driver.extra_environment["FAKE_MODE"] = "stubborn"
        fake_driver.start()
        fake_driver.request_stop()

        with pytest.raises(WaitTimeout, match="still running 0.3 s after it was asked to stop"):
            fake_driver.wait_exit(0.3)

    def test_close_kills_a_watcher_that_will_not_stop(
        self, fake_driver: CliDriver, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake_driver.extra_environment["FAKE_MODE"] = "stubborn"
        fake_driver.start()
        real_wait = fake_driver._process.wait  # type: ignore[union-attr]
        monkeypatch.setattr(
            fake_driver._process,  # type: ignore[arg-type]
            "wait",
            lambda timeout=None: real_wait(timeout=0.2 if timeout == 15 else timeout),
        )

        fake_driver.close()

        assert not fake_driver.is_running()
        fake_driver.close()  # Safe to call twice.

    def test_wait_for_log_finds_a_line_and_fails_with_the_tail(
        self, fake_driver: CliDriver
    ) -> None:
        fake_driver.start()
        fake_driver.config_dir().mkdir(parents=True, exist_ok=True)
        (fake_driver.config_dir() / "watcher.log").write_text("one\nInitial scan complete: 3\n")

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
        import sqlite3

        assert fake_driver.state_query("SELECT 1") == []
        fake_driver.config_dir().mkdir(parents=True)
        with sqlite3.connect(fake_driver.state_db_path()) as conn:
            conn.execute("CREATE TABLE pending_uploads (relative_path TEXT)")
            conn.execute("INSERT INTO pending_uploads VALUES ('RUN1/a.csv')")

        assert fake_driver.state_query("SELECT relative_path FROM pending_uploads") == [
            ("RUN1/a.csv",)
        ]
