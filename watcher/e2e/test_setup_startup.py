"""Setting a watcher up (``init``) and starting it (``watch``), including the waiting state.

``init`` is the real wizard with its answers piped in. ``watch`` runs through the driver, so a
refused start is a process that exits with a message, and the server's view (the watcher row,
its heartbeats and events) says what the watcher did. Nothing here sends a signal. The one
POSIX-only scenario (a folder with no permissions) is marked ``platforms("cli")``, so the same
file can run against the Windows service driver.
"""

from __future__ import annotations
import hashlib
import shutil
import uuid
from dataclasses import replace
from pathlib import Path

import pytest

from data_hub_shared.testing_proxy import FaultProxy
from data_hub_watcher import testing_overrides
from e2e_support.admin import Admin
from e2e_support.drivers import InitAnswers, NewInstrument, RunDetection, WatcherDriver
from e2e_support.factory import WatcherFactory
from e2e_support.files import SMALL, write_run
from e2e_support.server import ServerView
from e2e_support.waiting import KnownBugStillPresent, known_bug, stays_true

pytestmark = pytest.mark.e2e

# A key that looks right and that the server does not know.
UNKNOWN_KEY = "dhub_" + "0" * 40


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def wizard_answers(
    pc: WatcherDriver, proxy: FaultProxy, watch_dir: Path, api_key: str
) -> InitAnswers:
    """The answers of a person who picks the only instrument and types plain values."""
    return InitAnswers(
        environment=pc.environment,
        api_base_url=f"{proxy.base_url}/api/v1",
        api_key=api_key,
        watch_directory=watch_dir,
        instrument=1,
        existing_instruments=1,
        file_patterns=["*.csv"],
        run_detection=RunDetection.TOP_SUBDIRECTORY,
        recursive=True,
        stability_period_seconds=1,
        upload_mode="auto",
    )


def watcher_count(server: ServerView) -> int:
    rows = server.query("SELECT count(*) FROM watchers")
    return int(str(rows[0][0]))


def reporting_requests(proxy: FaultProxy) -> list[str]:
    """The paths of the heartbeats and event batches a running watcher sends."""
    return [
        r.path
        for r in proxy.requests
        if r.path.endswith("/heartbeat") or r.path.endswith("/events")
    ]


def refused_start(pc: WatcherDriver) -> str:
    """Start the watcher, which must exit with an error, and return everything it printed."""
    pc.start()
    exit_code = pc.wait_exit(20)
    assert exit_code != 0, f"the watcher exited with 0.\n{pc.log_text()}"
    return pc.log_text()


def wait_for_status_reason(
    server: ServerView, watcher_id: str, text: str, timeout: float = 30.0
) -> str:
    """Wait until the stored ``status_reason`` contains ``text`` and return it."""

    def found() -> str | None:
        reason = server.watcher(watcher_id).status_reason
        return reason if reason is not None and text in reason else None

    return server.wait_until(
        found, timeout, what=f"the status reason to mention {text!r}", watcher_id=watcher_id
    )


def count_events(
    server: ServerView, watcher_id: str, event_type: str, *, kind: str | None = None
) -> int:
    return len(server.events(watcher_id, event_type=event_type, kind=kind))


# ---------------------------------------------------------------------------
# init
# ---------------------------------------------------------------------------


@pytest.mark.covers("init.prompts->config_saved")
def test_init_registers_the_watcher_and_saves_what_was_typed(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    watch_dir: Path,
    watcher_token: str,
    instrument_id: str,
) -> None:
    pc = watcher(configure=False)
    answers = replace(
        wizard_answers(pc, proxy, watch_dir, watcher_token),
        file_patterns=["*.csv", "*.txt"],
        run_detection=RunDetection.FILENAME_PREFIX,
        recursive=False,
        stability_period_seconds=3,
        upload_mode="manual",
    )

    result = pc.init_interactive(answers)

    assert result.returncode == 0, result.output
    assert "Setup complete" in result.stdout
    assert "Config synced to Data Hub." in result.stdout

    # Every answer ended up in config.yaml, and the key in the env file next to it.
    config = pc.load_config()
    assert config.watcher_id == pc.watcher_id
    assert config.api_base_url == f"{proxy.base_url}/api/v1"
    inst = config.instrument
    assert inst.id == instrument_id
    assert inst.watch_directory == watch_dir
    assert inst.file_patterns == ["*.csv", "*.txt"]
    assert inst.upload_mode == "manual"
    assert inst.stability_period_seconds == 3
    assert inst.run_detection.pattern == r"^([^_]+)"
    assert inst.run_detection.recursive is False
    assert watcher_token in pc.env_path.read_text()

    # The server has the watcher, bound to the token that registered it, and the config
    # file as it is on disk.
    registered = server.watcher(pc.watcher_id)
    assert registered.instrument_id == instrument_id
    assert (registered.status, registered.last_heartbeat_at) == ("registered", None)
    assert registered.registered_by_token is not None
    assert registered.hostname
    assert registered.config_yaml == pc.config_path.read_text()
    digest = hashlib.sha256(pc.config_path.read_bytes()).hexdigest()
    assert registered.config_checksum == f"sha256:{digest}"


@pytest.mark.covers("init.existing_config->overwrite_declined")
def test_init_keeps_the_config_when_overwriting_is_declined(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    watch_dir: Path,
    watcher_token: str,
) -> None:
    pc = watcher()
    before = pc.config_path.read_bytes()
    registered = watcher_count(server)

    answers = replace(wizard_answers(pc, proxy, watch_dir, watcher_token), overwrite_config=False)
    result = pc.init_interactive(answers)

    assert result.returncode == 0, result.output
    assert "Config already exists" in result.stdout
    assert "Setup complete" not in result.stdout
    assert pc.config_path.read_bytes() == before
    assert watcher_count(server) == registered
    # It stopped at the question: nothing was asked of the server.
    assert proxy.requests == []


@pytest.mark.covers("init.malformed_key->refused")
def test_init_refuses_a_key_that_is_not_a_data_hub_key(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    watch_dir: Path,
) -> None:
    pc = watcher(configure=False)

    result = pc.init_interactive(wizard_answers(pc, proxy, watch_dir, "not-a-data-hub-key"))

    assert result.returncode != 0
    assert "must start with 'dhub_'" in result.output
    assert not pc.config_path.exists()
    assert not pc.env_path.exists()
    assert watcher_count(server) == 0
    # Refused at the PC: the server was never asked.
    assert proxy.requests == []


@pytest.mark.covers("init.rejected_key->not_saved")
def test_init_with_a_key_the_server_rejects_saves_nothing(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    watch_dir: Path,
) -> None:
    pc = watcher(configure=False)

    result = pc.init_interactive(wizard_answers(pc, proxy, watch_dir, UNKNOWN_KEY))

    assert result.returncode != 0
    assert "Failed to fetch instruments" in result.output
    assert "The API key was not saved" in result.output
    # The server said 401 to the request that checked the key, and that was the only one.
    assert [(r.method, r.upstream_status) for r in proxy.requests] == [("GET", 401)]
    assert not pc.config_path.exists()
    assert not pc.env_path.exists()
    assert watcher_count(server) == 0


@pytest.mark.covers("init.new_instrument->registered")
def test_init_can_register_a_new_instrument_for_the_watcher(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    watch_dir: Path,
    watcher_token: str,
) -> None:
    pc = watcher(configure=False)
    new_id = f"e2e-new-{uuid.uuid4().hex[:6]}"
    answers = replace(
        wizard_answers(pc, proxy, watch_dir, watcher_token),
        instrument=NewInstrument(new_id, "New Test Scope"),
    )

    result = pc.init_interactive(answers)

    assert result.returncode == 0, result.output
    created = server.query(
        "SELECT status::text, display_name FROM instruments WHERE id = %s", (new_id,)
    )
    assert created == [("pending", "New Test Scope")]
    assert pc.load_config().instrument.id == new_id
    assert server.watcher(pc.watcher_id).instrument_id == new_id
    # It is pending, so the watcher is told to wait before it may start.
    assert "still pending activation" in refused_start(pc)


@pytest.mark.covers("init.instrument_taken->refused")
def test_init_for_an_instrument_that_has_a_watcher_names_it(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    watch_dir: Path,
    watcher_token: str,
) -> None:
    existing = watcher()
    new_pc = watcher(configure=False)

    result = new_pc.init_interactive(wizard_answers(new_pc, proxy, watch_dir, watcher_token))

    assert result.returncode != 0
    assert "already has an active watcher" in result.output
    assert existing.watcher_id in result.output
    assert "deregister" in result.output.lower()
    assert not new_pc.config_path.exists()
    assert watcher_count(server) == 1


@pytest.mark.covers("init.missing_watch_directory->refused")
def test_init_refuses_a_watch_directory_that_does_not_exist(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    watch_dir: Path,
    watcher_token: str,
) -> None:
    pc = watcher(configure=False)
    typo = watch_dir / "no-such-folder"

    result = pc.init_interactive(wizard_answers(pc, proxy, typo, watcher_token))

    assert result.returncode != 0
    assert "watch_directory not found" in result.output
    # The check comes before the watcher is registered, so nothing is left behind.
    assert not pc.config_path.exists()
    assert watcher_count(server) == 0


# ---------------------------------------------------------------------------
# watch: start-up checks
# ---------------------------------------------------------------------------


@pytest.mark.covers(
    "startup.stopped->watching",
    "event.watcher_started->emitted",
    "event.config_synced->emitted",
)
def test_start_syncs_the_config_and_reports_watching(
    watcher: WatcherFactory, server: ServerView, current_version: str, instrument_id: str
) -> None:
    pc = watcher()
    assert server.watcher(pc.watcher_id).config_yaml is None

    pc.start()

    row = server.wait_for_watcher_status(pc.watcher_id, "watching")
    assert row.watcher_version == current_version
    assert row.status_reason is None
    # The registration had no config, so the start pushed the file on disk.
    assert row.config_yaml == pc.config_path.read_text()
    assert pc.state_db_path().exists()
    assert pc.is_running()

    first = server.heartbeats(pc.watcher_id)[0]
    assert (first.status, first.upload_mode) == ("watching", "auto")
    started = server.wait_for_event(pc.watcher_id, event_type="watcher_started")
    assert started.message.startswith(pc.started_prefix)
    synced = server.wait_for_event(pc.watcher_id, event_type="config_synced")
    assert synced.details["trigger"] == "startup"


@pytest.mark.covers("startup.dry_run->validated")
def test_dry_run_checks_everything_and_starts_nothing(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    watch_dir: Path,
    instrument_id: str,
) -> None:
    pc = watcher()
    write_run(watch_dir, "RUN-A", {"one.csv": SMALL, "two.csv": SMALL})
    write_run(watch_dir, "RUN-B", {"three.csv": SMALL})
    (watch_dir / "loose.csv").write_bytes(b"not in a run folder\n")

    result = pc.run_cli("watch", "--dry-run")

    assert result.returncode == 0, result.output
    assert "Dry run complete" in result.stdout
    assert "Run RUN-A (2 file(s))" in result.stdout
    assert f"{instrument_id}/RUN-A/one.csv" in result.stdout
    assert "Run RUN-B (1 file(s))" in result.stdout
    assert "1 file(s) did not match any run pattern" in result.stdout
    assert "Total: 2 run(s), 3 grouped file(s)" in result.stdout

    # It asked the server about the instrument, and started nothing: no heartbeat, no
    # events, no runs, no state database, no process left behind.
    assert any(
        r.method == "GET" and r.path.endswith(f"/instruments/{instrument_id}")
        for r in proxy.requests
    )
    assert reporting_requests(proxy) == []
    assert not any("/runs" in r.path for r in proxy.requests)
    row = server.watcher(pc.watcher_id)
    assert (row.status, row.last_heartbeat_at) == ("registered", None)
    assert server.heartbeats(pc.watcher_id) == []
    assert server.runs(instrument_id) == []
    assert not pc.state_db_path().exists()
    assert not pc.is_running()


@pytest.mark.covers("startup.config_invalid->refused")
@pytest.mark.parametrize("problem", ["missing", "malformed_yaml", "invalid_value"])
def test_start_refuses_a_config_that_is_missing_or_broken(
    watcher: WatcherFactory, server: ServerView, proxy: FaultProxy, problem: str
) -> None:
    pc = watcher()
    if problem == "missing":
        pc.config_path.unlink()
        expected = "Config file not found"
    elif problem == "malformed_yaml":
        pc.write_config_text("instrument: [unclosed\n")
        expected = "Malformed YAML"
    else:
        pc.write_config_text(
            pc.config_path.read_text().replace("upload_mode: auto", "upload_mode: sometimes")
        )
        expected = "Config validation failed"

    output = refused_start(pc)

    assert expected in output
    # It never got as far as asking the server anything.
    assert proxy.requests == []
    assert server.heartbeats(pc.watcher_id) == []


@pytest.mark.covers("startup.watcher_id_missing->refused")
def test_start_without_a_watcher_id_says_to_run_init(
    watcher: WatcherFactory, proxy: FaultProxy
) -> None:
    pc = watcher(register=False)

    output = refused_start(pc)

    assert "No watcher_id in config" in output
    assert "Run 'data-hub-watcher init' first." in output
    assert proxy.requests == []


@pytest.mark.covers("startup.api_unreachable->refused")
def test_start_refuses_when_the_server_cannot_be_reached(
    watcher: WatcherFactory, server: ServerView, proxy: FaultProxy
) -> None:
    pc = watcher()
    proxy.go_down()

    output = refused_start(pc)

    assert "Cannot reach API" in output
    # Nothing reached the server, so the watcher never checked in.
    assert server.watcher(pc.watcher_id).status == "registered"
    assert server.heartbeats(pc.watcher_id) == []


@pytest.mark.covers("startup.api_key_rejected->refused")
def test_start_refuses_when_the_server_rejects_the_key(
    watcher: WatcherFactory, server: ServerView, proxy: FaultProxy, instrument_id: str
) -> None:
    pc = watcher()
    pc.write_env(api_key=UNKNOWN_KEY)

    output = refused_start(pc)

    assert "Cannot reach API" in output
    # The server was reached, and it answered the first request with a 401.
    first = proxy.requests[0]
    assert first.path.endswith(f"/instruments/{instrument_id}")
    assert first.upstream_status == 401
    assert server.heartbeats(pc.watcher_id) == []


@pytest.mark.covers(
    "startup.instrument_pending->refused", "startup.instrument_pending->activated_starts"
)
def test_a_pending_instrument_blocks_the_start_until_it_is_activated(
    watcher: WatcherFactory, server: ServerView, admin: Admin, instrument_id: str
) -> None:
    pc = watcher()
    server.set_instrument_status(instrument_id, "pending")

    output = refused_start(pc)

    assert "still pending activation" in output
    assert server.heartbeats(pc.watcher_id) == []
    assert server.watcher(pc.watcher_id).status == "registered"

    admin.activate_instrument(instrument_id).raise_for_status()
    pc.start()

    server.wait_for_watcher_status(pc.watcher_id, "watching")
    assert pc.is_running()


@pytest.mark.covers("startup.instrument_inactive->watching")
def test_a_retired_instrument_does_not_stop_the_watcher_from_starting(
    watcher: WatcherFactory, server: ServerView, instrument_id: str
) -> None:
    pc = watcher()
    # Set in the database: retiring through the route also deregisters the watcher.
    server.set_instrument_status(instrument_id, "inactive")

    pc.start()

    server.wait_for_watcher_status(pc.watcher_id, "watching")
    assert pc.is_running()


# ---------------------------------------------------------------------------
# The waiting state
# ---------------------------------------------------------------------------


@pytest.mark.covers(
    "startup.watching->waiting_folder_missing",
    "waiting.folder_created->resumed",
    "event.watch_directory_unavailable->emitted",
    "event.watcher_started->emitted",
)
def test_a_missing_watch_folder_waits_and_resumes_when_it_appears(
    watcher: WatcherFactory, server: ServerView, watch_dir: Path, instrument_id: str
) -> None:
    folder = watch_dir / "not-there-yet"
    pc = watcher(watch_dir=folder, create_watch_dir=False)

    pc.start()

    # It waits, and says why, in the status, in the heartbeats and in two events.
    row = server.wait_for_watcher_status(pc.watcher_id, "waiting")
    assert row.status_reason == f"watch_directory not found: {folder}"
    assert server.effective_status(pc.watcher_id) == "waiting"
    assert pc.is_running()
    started = server.wait_for_event(pc.watcher_id, event_type="watcher_started")
    assert started.message.startswith(pc.started_prefix)
    unavailable = server.wait_for_event(
        pc.watcher_id, event_type="error", kind="watch_directory_unavailable"
    )
    assert unavailable.details["watch_directory"] == str(folder)
    assert unavailable.details["reason"] == row.status_reason
    beats = server.wait_for_heartbeats(pc.watcher_id, count=2)
    assert {b.status for b in beats} == {"waiting"}

    # Creating the folder is enough: the next tick starts watching.
    last_event = server.last_event_id(pc.watcher_id)
    folder.mkdir()
    row = server.wait_for_watcher_status(pc.watcher_id, "watching")
    assert row.status_reason is None
    resumed = server.wait_for_event(
        pc.watcher_id, event_type="watcher_started", after_id=last_event
    )
    assert resumed.message.startswith(pc.resumed_prefix)

    # It is really watching: a run written now is reported and uploaded.
    written = write_run(folder, "RUN001", {"a.csv": SMALL})
    server.wait_for_uploaded(instrument_id, "RUN001", "RUN001/a.csv", content=written["a.csv"])


@pytest.mark.platforms("cli")  # A folder with no permissions is a POSIX setup.
@pytest.mark.covers(
    "startup.watching->waiting_folder_unreadable",
    "event.watch_directory_unavailable->emitted",
)
def test_a_watch_folder_that_cannot_be_listed_waits_with_that_reason(
    watcher: WatcherFactory, server: ServerView, unreadable_folder: Path
) -> None:
    pc = watcher(watch_dir=unreadable_folder, create_watch_dir=False)

    pc.start()

    row = server.wait_for_watcher_status(pc.watcher_id, "waiting")
    assert row.status_reason is not None
    assert row.status_reason.startswith("watch_directory is not readable")
    assert str(unreadable_folder) in row.status_reason
    unavailable = server.wait_for_event(
        pc.watcher_id, event_type="error", kind="watch_directory_unavailable"
    )
    assert unavailable.details["reason"] == row.status_reason


@pytest.mark.covers("waiting.reason->changed", "event.watch_directory_unavailable->emitted")
def test_a_changed_waiting_reason_is_reported_once(
    watcher: WatcherFactory, server: ServerView, watch_dir: Path
) -> None:
    folder = watch_dir / "later"
    pc = watcher(watch_dir=folder, create_watch_dir=False)
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "waiting")
    server.wait_for_event(pc.watcher_id, event_type="error", kind="watch_directory_unavailable")

    # A file takes the folder's place: still waiting, for another reason.
    folder.write_text("this is a file\n")

    reason = wait_for_status_reason(server, pc.watcher_id, "is not a folder")
    assert reason == f"watch_directory is not a folder: {folder}"
    events = server.wait_for_events(
        pc.watcher_id, count=2, event_type="error", kind="watch_directory_unavailable"
    )
    assert [e.details["reason"] for e in events] == [
        f"watch_directory not found: {folder}",
        reason,
    ]

    # The new reason is reported once, and the watcher did not start a second time.
    stays_true(
        lambda: (
            count_events(server, pc.watcher_id, "error", kind="watch_directory_unavailable") == 2
            and count_events(server, pc.watcher_id, "watcher_started") == 1
        ),
        5,
        lambda: server.dump(pc.watcher_id),
        what="one event for the changed reason, and one watcher_started",
    )
    assert server.watcher(pc.watcher_id).status == "waiting"


@pytest.mark.covers(
    "waiting.start_failure->backoff_retry",
    "event.watch_directory_unavailable->emitted",
    "event.watcher_started->emitted",
)
def test_a_start_that_keeps_failing_backs_off_and_then_succeeds(
    watcher: WatcherFactory, server: ServerView, watch_dir: Path
) -> None:
    folder = watch_dir / "later"
    # A 1 s heartbeat makes the waits between attempts 1, 2, 4 and 8 s. Each failed attempt also
    # spends the database's 5 s busy timeout, which is why this test takes a while.
    pc = watcher(
        watch_dir=folder,
        create_watch_dir=False,
        overrides={testing_overrides.HEARTBEAT_INTERVAL_ENV_VAR: "1"},
    )
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "waiting")
    server.wait_for_event(pc.watcher_id, event_type="error", kind="watch_directory_unavailable")

    with pc.lock_state_db():
        # The folder exists now, but starting to watch fails: the state database is locked.
        folder.mkdir()
        for delay in (1, 2, 4, 8):
            pc.wait_for_log(rf"[Cc]ould not start watching.*trying again in {delay}s", timeout=45)
        row = server.watcher(pc.watcher_id)
        assert row.status == "waiting"
        assert row.status_reason is not None
        assert row.status_reason.startswith("could not start watching")
        # Four failures, and two events in all: the missing folder, and the first failure.
        # The same failure again reports nothing, and the watcher did not "start" in between.
        reasons = [
            e.details["reason"]
            for e in server.events(
                pc.watcher_id, event_type="error", kind="watch_directory_unavailable"
            )
        ]
        assert len(reasons) == 2
        assert reasons[0].startswith("watch_directory not found")
        assert reasons[1] == row.status_reason
        assert count_events(server, pc.watcher_id, "watcher_started") == 1

    # With the database free again, the next attempt starts watching and says it resumed.
    row = server.wait_for_watcher_status(pc.watcher_id, "watching", timeout=60)
    assert row.status_reason is None
    resumed = server.wait_for_events(pc.watcher_id, count=2, event_type="watcher_started")
    assert resumed[-1].message.startswith(pc.resumed_prefix)


@pytest.mark.xfail(
    strict=True,
    raises=KnownBugStillPresent,
    reason=(
        "bug-01-folder-vanishes: a watch folder that disappears while the watcher runs "
        "leaves it reporting `watching` instead of `waiting`"
    ),
)
@pytest.mark.covers("waiting.folder_vanished->waiting_then_resumed")
def test_a_watch_folder_that_vanishes_puts_the_watcher_back_to_waiting(
    watcher: WatcherFactory, server: ServerView, watch_dir: Path, instrument_id: str
) -> None:
    folder = watch_dir / "instrument-output"
    pc = watcher(watch_dir=folder)
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")

    # The folder goes away while the watcher runs, as when a network drive drops.
    shutil.rmtree(folder)

    with known_bug():
        row = server.wait_for_watcher_status(pc.watcher_id, "waiting", timeout=12)
        assert row.status_reason is not None
        assert row.status_reason.startswith("watch_directory not found")

    # And it picks up again when the folder comes back.
    folder.mkdir()
    server.wait_for_watcher_status(pc.watcher_id, "watching")
    written = write_run(folder, "RUN001", {"a.csv": SMALL})
    server.wait_for_uploaded(instrument_id, "RUN001", "RUN001/a.csv", content=written["a.csv"])
