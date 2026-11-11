"""What only exists under the Windows service: install, the SCM's recovery, the upgrade worker.

Every test here runs only under ``DATA_HUB_E2E_DRIVER=service`` (the suite's ``conftest.py``
skips the file under the CLI driver), on Windows, in an elevated shell. The shared scenario
files run under the service as well, through the driver. This file covers what has no CLI
counterpart: how the service is registered, what the Service Control Manager does when it
fails, the scheduled-task worker that upgrades it, and uninstalling it.

The driver turns the SCM's recovery actions off after ``service install``, so that a killed or
refused service stays down as a ``watch`` process does. A test of recovery asks for the
configuration the product sets with ``install_service(failure_actions="product")``. The restarts
those tests wait for are the real ones: 60 s after the first failure and 120 s after the second.
They are slow, so only three tests wait for them: a killed service, one whose start is refused
(``api_unreachable``), and the third failure that leaves the service stopped. Every start-up
refusal ends the same way (a ``SystemExit(1)``, which pywin32 reports as the same failure code),
so the others are shown by their log line and a non-zero exit with the recovery off. Where a test
only has to see that the SCM does *not* restart a service, it gives the SCM a 2-second restart
instead, so that a restart would show within seconds.

There is one service per machine, so these tests run one after the other, and each removes the
service when it ends.
"""

from __future__ import annotations
import os
import re
import time
from pathlib import Path
from typing import Any, cast

import pytest

from data_hub_shared.testing_index import LocalPackageIndex
from data_hub_shared.testing_proxy import FaultProxy
from data_hub_watcher import testing_overrides
from data_hub_watcher.updater import UPGRADE_MARKER_FILENAME
from data_hub_watcher.upgrade_worker import UPGRADE_REQUEST_FILENAME, UPGRADE_RESULT_FILENAME
from e2e_support.admin import Admin
from e2e_support.factory import WatcherFactory
from e2e_support.files import SMALL, ExclusiveWriter, payload, write_run
from e2e_support.server import HeartbeatRow, ServerView
from e2e_support.service_driver import READY_LINE, START_LINE, WindowsServiceDriver
from e2e_support.waiting import KnownBugStillPresent, known_bug, stays_true, wait_until
from e2e_support.windows_scm import SERVICE_FAILURE_EXIT_CODE, ServiceState

pytestmark = pytest.mark.e2e

# The SCM restarts a failed service after 60 s, and after 120 s the second time. The bounds
# allow for the time a failure takes to be seen and a restart to be noticed.
FIRST_RESTART_SECONDS = (45.0, 120.0)
SECOND_RESTART_SECONDS = (100.0, 180.0)

CHECK_EVERY_HEARTBEAT = {testing_overrides.UPDATE_CHECK_INTERVAL_TICKS_ENV_VAR: "1"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def service_pc(watcher: WatcherFactory, **options: Any) -> WindowsServiceDriver:
    """A configured PC, as the service driver: these tests use what only it has."""
    pc = watcher(**options)
    assert isinstance(pc, WindowsServiceDriver), "this file needs DATA_HUB_E2E_DRIVER=service"
    return pc


def start_watching(pc: WindowsServiceDriver, server: ServerView) -> None:
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")


def count_in_log(pc: WindowsServiceDriver, text: str) -> int:
    return pc.log_text().count(text)


def starts_logged(pc: WindowsServiceDriver) -> int:
    """How many times the service has logged that it is starting."""
    return len(START_LINE.findall(pc.log_text()))


def idle_ticks(count: int) -> dict[str, str]:
    return {testing_overrides.UPDATE_IDLE_TICKS_ENV_VAR: str(count)}


def update_events(server: ServerView, pc: WindowsServiceDriver) -> list[str]:
    kinds = {"update_started", "update_succeeded", "update_failed"}
    return [e.event_type for e in server.events(pc.watcher_id) if e.event_type in kinds]


def update_event_sequence(server: ServerView, pc: WindowsServiceDriver) -> list[str]:
    """The update events in order, a repeat of the same event counted once: the scenarios about
    the upgrade compare this, and ``service.upgrade->worker_dispatch_once`` is the one that
    counts the repeats (the updater doesn't mark an upgrade it hands to the worker as in
    progress, so a check on the next heartbeat can dispatch it again)."""
    kinds = update_events(server, pc)
    return [kind for index, kind in enumerate(kinds) if index == 0 or kinds[index - 1] != kind]


def wait_for_wheel_request(
    pc: WindowsServiceDriver, index: LocalPackageIndex, version: str
) -> None:
    """Wait until the package index was asked for the wheel of ``version``: the worker's
    ``uv`` installed from the local index and not from PyPI."""
    prefix = f"/files/data_hub_watcher-{version}-"
    wait_until(
        lambda: any(path.startswith(prefix) for path in index.requested_paths),
        pc.install_timeout_seconds,
        lambda: "index requests:\n" + "\n".join(index.requested_paths),
        what=f"the package index to be asked for the {version} wheel",
    )


def wait_for_watching_on(server: ServerView, pc: WindowsServiceDriver, version: str) -> None:
    server.wait_until(
        lambda: (
            (row := server.watcher(pc.watcher_id)).status == "watching"
            and row.watcher_version == version
        ),
        90,
        what=f"the service to be watching on {version}",
        watcher_id=pc.watcher_id,
    )


def refused_start(pc: WindowsServiceDriver) -> float:
    """Start the service, which ends at once with a failure, and return when that was seen."""
    pc.start()
    assert pc.exit_code not in (None, 0), f"the service did not fail.\n{pc.log_text()}"
    assert pc.ended_at is not None
    return pc.ended_at


def recover(pc: WindowsServiceDriver, server: ServerView, failed_at: float) -> None:
    """Wait for the SCM's restart after a failure, check it came after about 60 s, and that the
    service then runs and watches."""
    status = pc.wait_for_new_process(None, timeout=150)
    waited = time.monotonic() - failed_at
    low, high = FIRST_RESTART_SECONDS
    assert low <= waited <= high, f"the SCM restarted the service {waited:.0f} s after it failed"
    assert status.state is ServiceState.RUNNING
    server.wait_for_watcher_status(pc.watcher_id, "watching", timeout=60)
    assert starts_logged(pc) == 2, pc.log_tail()


# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------


@pytest.mark.covers("service.not_installed->installed")
def test_install_registers_the_service_the_upgrade_worker_and_its_task(
    watcher: WatcherFactory,
) -> None:
    pc = service_pc(watcher)
    assert pc.service_status() is None, "a service is already installed on this machine"

    result = pc.install_service()

    assert "Service installed" in result.stdout, result.output
    status = pc.service_status()
    assert status is not None
    assert status.state is ServiceState.STOPPED
    config = pc.host.config()
    assert config is not None
    assert config.start_type == "AUTO_START"
    assert config.display_name == "Data Hub Watcher"
    # The interpreter of the install, running the service module, as `service install` says.
    binary = config.binary_path.lower()
    assert "data-hub-watcher" in binary
    assert "python.exe" in binary
    assert "-m data_hub_watcher.service" in binary
    # The upgrade worker and its on-demand task are in place. (`service install` also creates the
    # ProgramData log folder when it is missing, but on a machine that has run the service before
    # it is there already, so this test doesn't claim it.)
    assert pc.worker_script.is_file()
    assert pc.host.task_exists()
    task = pc.host.task_details()
    assert task["Run As User"].upper().endswith("SYSTEM")
    assert pc.worker_script.name in task["Task To Run"]
    assert "-File" in task["Task To Run"]


@pytest.mark.covers("service.install->registry_paths")
def test_the_registry_holds_the_config_and_env_file_the_service_will_load(
    watcher: WatcherFactory,
) -> None:
    pc = service_pc(watcher)

    pc.install_service()

    config_path, env_path = pc.registered_paths()
    assert os.path.normcase(config_path) == os.path.normcase(pc.config_path)
    assert os.path.normcase(env_path) == os.path.normcase(pc.env_path)
    # They are this test's own files, in its profile, not the operator's.
    assert os.path.normcase(pc.profile) in os.path.normcase(config_path)


@pytest.mark.covers("service.install->recovery_actions")
def test_install_sets_restart_after_60_then_120_seconds_and_no_action_after(
    watcher: WatcherFactory,
) -> None:
    pc = service_pc(watcher)

    pc.install_service(failure_actions="product")

    failure = pc.host.failure_actions()
    assert failure.restart_delays_ms == (60_000, 120_000)
    assert failure.other_actions == ()
    assert failure.reset_period_seconds == 86_400
    # A `SystemExit(1)` is a failure to the SCM only because of this flag.
    assert failure.on_noncrash_failures is True
    # `sc qfailure` prints no line for a "no action" entry, so the third entry is read from the
    # registry value the SCM keeps, which lists it. The third failure leaving the service
    # stopped is shown in action by `service.failures->stays_stopped_after_two`.
    assert pc.host.failure_action_list() == (
        ("restart", 60_000),
        ("restart", 120_000),
        ("none", 0),
    )


@pytest.mark.covers("service.install->delayed_start_and_dependencies")
def test_install_sets_a_delayed_start_after_the_network_services(watcher: WatcherFactory) -> None:
    pc = service_pc(watcher)

    pc.install_service()

    config = pc.host.config()
    assert config is not None
    assert config.delayed_start is True
    assert sorted(config.dependencies) == ["Dnscache", "Tcpip"]


# ---------------------------------------------------------------------------
# Running, stopping and starting again
# ---------------------------------------------------------------------------


@pytest.mark.covers("service.installed->running")
def test_start_takes_the_service_to_running_as_local_system(
    watcher: WatcherFactory, server: ServerView
) -> None:
    pc = service_pc(watcher)
    pc.install_service()

    pc.start()

    server.wait_for_watcher_status(pc.watcher_id, "watching")
    started = server.wait_for_event(pc.watcher_id, event_type="watcher_started")
    assert started.message.startswith("Service started on ")
    status = pc.service_status()
    assert status is not None
    assert status.state is ServiceState.RUNNING
    assert status.pid
    # `service status` says what the SCM says.
    shown = pc.run_cli("service", "status")
    assert "State: running" in shown.stdout, shown.output
    assert re.search(rf"PID:\s+{status.pid}\b", shown.stdout), shown.output
    config = pc.host.config()
    assert config is not None
    assert config.start_name == "LocalSystem"


@pytest.mark.covers("service.running->stopped")
def test_stop_ends_the_service_cleanly_and_the_scm_does_not_restart_it(
    watcher: WatcherFactory, server: ServerView
) -> None:
    pc = service_pc(watcher)
    pc.install_service()
    # A restart after 2 s for any failure, a stop that is not a clean one included: if the SCM
    # did take a clean stop for a failure, it would show well inside the wait below.
    pc.host.set_restart_actions([2_000, 2_000])
    start_watching(pc, server)

    assert pc.stop() == 0

    row = server.wait_for_watcher_status(pc.watcher_id, "stopped")
    assert row.status_reason is None
    assert server.heartbeats(pc.watcher_id)[-1].status == "stopped"
    stopped = [
        e.message
        for e in server.events(pc.watcher_id, event_type="watcher_stopped")
        if e.kind is None
    ]
    assert stopped == [pc.operator_stop_message]
    stays_true(
        lambda: not pc.is_running(),
        10,
        pc.log_tail,
        what="the SCM to leave a cleanly stopped service alone",
    )


@pytest.mark.covers("service.stop->clean_stop_during_start")
def test_a_stop_that_arrives_while_the_service_is_starting_is_not_lost(
    watcher: WatcherFactory, server: ServerView, proxy: FaultProxy
) -> None:
    pc = service_pc(watcher)
    # The first heartbeat is sent before the start-up scan, and a slow server holds it up.
    proxy.add_fault("delay", path=r"/heartbeat$", method="POST", delay_seconds=8, count=1)

    pc.start(wait_ready=False)
    wait_until(
        lambda: any(r.fault_mode == "delay" for r in proxy.requests),
        30,
        pc.log_tail,
        what="the service to be held up in its first heartbeat",
    )
    assert pc.is_running()
    pc.request_stop()

    # `SvcStop` only sets an event, which the service reads when its start has finished: the
    # stop waits for that, and then it is a clean one.
    assert pc.wait_exit(60) == 0
    server.wait_for_watcher_status(pc.watcher_id, "stopped")
    stopped = [
        e.message
        for e in server.events(pc.watcher_id, event_type="watcher_stopped")
        if e.kind is None
    ]
    assert stopped == [pc.operator_stop_message]
    assert server.heartbeats(pc.watcher_id)[-1].status == "stopped"


@pytest.mark.covers("service.stopped->running_again")
def test_a_stopped_service_starts_again_without_reporting_its_files_twice(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    watch_dir: Path,
    instrument_id: str,
) -> None:
    pc = service_pc(watcher)
    start_watching(pc, server)
    first = write_run(watch_dir, "RUN001", {"a.csv": SMALL})
    server.wait_for_uploaded(instrument_id, "RUN001", "RUN001/a.csv", content=first["a.csv"])
    wait_until(
        lambda: pc.state_query("SELECT count(*) FROM uploaded_files") == [(1,)],
        30,
        lambda: server.dump(pc.watcher_id, instrument_id),
        what="the service to record the upload",
    )
    proxy.clear_log()

    # Stop and start twice: each is a new process that remembers the run.
    seen_pids = {pc.pid}
    for _ in range(2):
        assert pc.stop() == 0
        assert pc.pid is None
        server.wait_for_watcher_status(pc.watcher_id, "stopped")
        pc.start()
        server.wait_for_watcher_status(pc.watcher_id, "watching")
        assert pc.pid not in seen_pids
        seen_pids.add(pc.pid)

    assert [
        (r.method, r.path)
        for r in proxy.requests
        if "/runs" in r.path or r.path.endswith("/request-upload-url")
    ] == []
    assert len(server.runs(instrument_id)) == 1
    assert len(server.events(pc.watcher_id, event_type="run_reported")) == 1
    assert len(server.events(pc.watcher_id, event_type="watcher_started")) == 3


@pytest.mark.covers("service.running->recovery_restart")
def test_a_killed_service_is_restarted_by_the_scm_after_a_minute(
    watcher: WatcherFactory, server: ServerView
) -> None:
    pc = service_pc(watcher)
    pc.install_service(failure_actions="product")
    start_watching(pc, server)
    old_pid = pc.pid
    assert old_pid is not None
    mark = pc.mark_logs()
    starts_before = pc.start_lines()

    # A crash, as far as the SCM can tell. There is no stopped heartbeat to explain it.
    pc.kill()
    killed_at = time.monotonic()
    assert pc.exit_code not in (None, 0)
    assert [b.status for b in server.heartbeats(pc.watcher_id)][-1] == "watching"

    status = pc.wait_for_new_process(old_pid, timeout=150, after_starts=starts_before)
    waited = time.monotonic() - killed_at
    low, high = FIRST_RESTART_SECONDS
    assert low <= waited <= high, f"the SCM restarted the service {waited:.0f} s after the kill"
    # A new process: another pid, or (Windows hands pids out again) another start line.
    assert status.pid != old_pid or pc.start_lines() > starts_before
    pc.wait_for_log(READY_LINE.pattern, timeout=60, since=mark)
    server.wait_for_events(pc.watcher_id, count=2, event_type="watcher_started")
    server.wait_for_watcher_status(pc.watcher_id, "watching")


# ---------------------------------------------------------------------------
# What it writes, and where
# ---------------------------------------------------------------------------


@pytest.mark.covers("service.running->logs_written")
def test_the_service_logs_to_programdata_and_to_the_event_log(
    watcher: WatcherFactory, server: ServerView
) -> None:
    pc = service_pc(watcher)
    start_watching(pc, server)

    line = pc.wait_for_log(READY_LINE.pattern)
    assert "[INFO]" in line

    # C:\ProgramData\DataHubWatcher\watcher.log, which the CLI shares.
    program_data = os.environ.get("ProgramData") or r"C:\ProgramData"
    assert os.path.normcase(pc.watcher_log) == os.path.normcase(
        Path(program_data) / "DataHubWatcher" / "watcher.log"
    )
    assert pc.watcher_log.is_file()
    assert START_LINE.search(pc.log_text())

    def in_event_log() -> bool:
        return any(
            "is running" in entry.message and entry.log == "Application"
            for entry in pc.event_log_entries()
        )

    wait_until(
        in_event_log,
        60,
        lambda: "\n".join(
            f"{e.log} {e.provider}: {e.message[:80]}" for e in pc.event_log_entries()
        ),
        what="the Windows Event Log to hold the service's 'is running' message",
        interval=2.0,
    )


@pytest.mark.covers("service.running->state_in_config_dir")
def test_state_and_the_upgrade_files_are_beside_the_registered_config_not_in_the_system_profile(
    watcher: WatcherFactory,
    server: ServerView,
    watch_dir: Path,
    instrument_id: str,
) -> None:
    pc = service_pc(watcher)
    start_watching(pc, server)
    content = write_run(watch_dir, "RUN001", {"a.csv": SMALL})
    server.wait_for_uploaded(instrument_id, "RUN001", "RUN001/a.csv", content=content["a.csv"])

    config_path, _ = pc.registered_paths()
    database = pc.state_db_path()
    assert database.is_file()
    assert os.path.normcase(database.parent) == os.path.normcase(config_path.parent)
    assert pc.state_query("SELECT count(*) FROM uploaded_files") == [(1,)]
    # The worker's script was written there too, so the sentinels it reads are the service's.
    assert os.path.normcase(pc.worker_script.parent) == os.path.normcase(config_path.parent)
    # And nothing went to the `.data-hub` of LocalSystem's own profile.
    system_profile = pc.system_root / "System32" / "config" / "systemprofile" / ".data-hub"
    assert not (system_profile / database.name).exists()


@pytest.mark.covers("service.env_file->overrides_applied")
def test_an_override_in_the_env_file_applies_once_the_service_has_restarted(
    watcher: WatcherFactory, server: ServerView
) -> None:
    variable = testing_overrides.HEARTBEAT_INTERVAL_ENV_VAR
    pc = service_pc(watcher)
    start_watching(pc, server)
    # The 2-second heartbeat of the suite's env file, announced when the service started.
    assert f"{variable}=2" in pc.log_text()
    pace = _watching_gaps(server.wait_for_heartbeats(pc.watcher_id, count=4))
    assert max(pace) < 4, pace

    # A new value in the file changes nothing until the service restarts.
    pc.write_env(overrides={variable: "5"})
    after = server.last_heartbeat_id(pc.watcher_id)
    still = _watching_gaps(server.wait_for_heartbeats(pc.watcher_id, count=3, after_id=after))
    assert max(still) < 4, still

    mark = pc.mark_logs()
    pc.restart()
    server.wait_for_watcher_status(pc.watcher_id, "watching")
    assert f"{variable}=5" in pc.log_text(mark)
    after = server.last_heartbeat_id(pc.watcher_id)
    slowed = _watching_gaps(server.wait_for_heartbeats(pc.watcher_id, count=3, after_id=after))
    assert min(slowed) >= 4, slowed


def _watching_gaps(beats: list[HeartbeatRow]) -> list[float]:
    """Seconds between consecutive heartbeats of a running service (``stopped`` ones left out)."""
    stamps = [b.created_at for b in beats if b.status == "watching"]
    return [
        (later - earlier).total_seconds()
        for earlier, later in zip(stamps, stamps[1:], strict=False)
    ]


@pytest.mark.xfail(
    strict=True,
    raises=KnownBugStillPresent,
    reason=(
        "ENG-2119: the service sets its log level before it loads the "
        "env file, so DATA_HUB_WATCHER_LOG_LEVEL there is ignored"
    ),
)
@pytest.mark.covers("service.env_file->log_level_honored")
def test_the_log_level_in_the_env_file_is_honored_by_the_service(
    watcher: WatcherFactory, server: ServerView, proxy: FaultProxy
) -> None:
    pc = service_pc(
        watcher,
        overrides={**CHECK_EVERY_HEARTBEAT, "DATA_HUB_WATCHER_LOG_LEVEL": "DEBUG"},
    )
    start_watching(pc, server)
    # The watcher checks for an update on every heartbeat and finds none, which it says at
    # DEBUG level ("Skipping update attempt"). Wait for the checks, which are the reason a
    # DEBUG line would be there.
    wait_until(
        lambda: (
            len([r for r in proxy.requests if r.path.split("?")[0].endswith("/update-check")]) >= 3
        ),
        60,
        lambda: server.dump(pc.watcher_id),
        what="three update checks",
    )
    server.wait_for_heartbeats(pc.watcher_id, count=2)

    with known_bug():
        pc.wait_for_log(r"\[DEBUG\]", timeout=10)


@pytest.mark.covers("service.config_revision->applied_without_restart")
def test_a_config_revision_is_applied_inside_the_running_service(
    watcher: WatcherFactory, server: ServerView, admin: Admin
) -> None:
    pc = service_pc(watcher)
    start_watching(pc, server)
    pid = pc.pid
    assert pid is not None

    created = admin.save_config_revision(pc.watcher_id, pc.revision_settings(upload_mode="manual"))
    assert created.status_code == 201, created
    number = int(cast("dict[str, Any]", created.body)["revision"])

    def applied() -> bool:
        return admin.config_revision(pc.watcher_id, number)["status"] == "applied"

    wait_until(applied, 60, lambda: server.dump(pc.watcher_id), what="the revision to be applied")
    assert pc.load_config().instrument.upload_mode == "manual"
    # The SCM never saw it stop: same process, still `RUNNING`, no stop event.
    status = pc.service_status()
    assert status is not None
    assert (status.state, status.pid) == (ServiceState.RUNNING, pid)
    assert server.events(pc.watcher_id, event_type="watcher_stopped") == []
    assert starts_logged(pc) == 1
    server.wait_for_event(
        pc.watcher_id,
        event_type="watcher_started",
        message_contains=f"with config revision {number}",
    )


@pytest.mark.covers("service.missing_folder->waits_without_restart_loop")
def test_a_missing_watch_folder_makes_the_service_wait_and_not_exit(
    watcher: WatcherFactory, server: ServerView, watch_dir: Path
) -> None:
    folder = watch_dir / "not-there-yet"
    pc = service_pc(watcher, watch_dir=folder, create_watch_dir=False)
    pc.install_service()
    # A restart 2 s after any failure: a service that exited because of the folder would be
    # back, with another pid, well inside the wait below.
    pc.host.set_restart_actions([2_000, 2_000])

    pc.start()

    server.wait_for_watcher_status(pc.watcher_id, "waiting")
    pid = pc.pid
    assert pid is not None
    assert "is waiting" in pc.log_text()
    stays_true(
        lambda: pc.pid == pid and starts_logged(pc) == 1,
        10,
        pc.log_tail,
        what="one process to keep waiting for the folder",
    )
    assert {b.status for b in server.heartbeats(pc.watcher_id)} == {"waiting"}

    folder.mkdir()
    server.wait_for_watcher_status(pc.watcher_id, "watching")
    assert pc.pid == pid


@pytest.mark.covers("file.locked->pending_until_released")
def test_a_file_its_writer_holds_open_is_reported_and_uploaded_once_it_is_closed(
    watcher: WatcherFactory, server: ServerView, watch_dir: Path, instrument_id: str
) -> None:
    pc = service_pc(watcher, stability_period_seconds=2)
    start_watching(pc, server)
    target = watch_dir / "RUN001" / "scan.csv"

    # An instrument that opens its file with no sharing, and writes to it for longer than the
    # stability period, a chunk a second. The watcher can't read the file, and as long as the
    # size it sees follows the writes (see `ExclusiveWriter`: NTFS may report it lazily) it
    # never calls it stable. A file that looks unchanged to the watcher is a different case:
    # `file.locked->uploaded_after_release`.
    with ExclusiveWriter(target) as writer:
        for number in range(8):
            writer.write(payload(300, seed=number))
            assert server.runs(instrument_id) == [], "the file was reported while it was held"
            time.sleep(1)
        with pytest.raises(PermissionError):
            target.read_bytes()
        assert server.runs(instrument_id) == []

    # Closed, it holds everything the writer wrote, and it is reported and uploaded.
    server.wait_for_uploaded(
        instrument_id, "RUN001", "RUN001/scan.csv", content=bytes(writer.content)
    )


# ---------------------------------------------------------------------------
# Start-up failures and the SCM's recovery
# ---------------------------------------------------------------------------


@pytest.mark.covers("service.registry_unreadable->failure_exit")
def test_a_service_that_cannot_read_its_registry_paths_logs_why_and_exits_with_a_failure(
    watcher: WatcherFactory,
) -> None:
    pc = service_pc(watcher)
    pc.install_service()
    pc.host.delete_registry_value("ConfigPath")

    refused_start(pc)

    assert "Cannot read config/env paths from registry" in pc.log_text()
    assert not pc.is_running()


@pytest.mark.covers("service.no_api_url->failure_exit")
def test_a_config_without_an_api_url_is_logged_and_the_service_exits_with_a_failure(
    watcher: WatcherFactory,
) -> None:
    pc = service_pc(watcher)
    pc.install_service()
    good = pc.load_config()
    pc.write_config(good.model_copy(update={"api_base_urls": {}}))

    refused_start(pc)

    assert "No API base URL configured for environment" in pc.log_text()
    assert not pc.is_running()


@pytest.mark.covers("service.api_unreachable->recovery_restart")
def test_an_unreachable_api_fails_the_service_and_it_runs_once_the_api_is_back(
    watcher: WatcherFactory, server: ServerView, proxy: FaultProxy
) -> None:
    pc = service_pc(watcher)
    pc.install_service(failure_actions="product")
    proxy.go_down()

    failed_at = refused_start(pc)

    assert "Cannot reach API during startup" in pc.log_text()
    # A `SystemExit(1)` reaches the SCM as the failure of the service-specific code 0x20000001
    # (pywin32 reports anything raised out of `SvcRun` that way), which the non-crash flag turns
    # into a failure the recovery acts on. This is the one start-up refusal whose restart the
    # suite waits for: the other refusals end in the same `SystemExit(1)`.
    assert pc.exit_code == SERVICE_FAILURE_EXIT_CODE
    proxy.come_up()
    recover(pc, server, failed_at)


@pytest.mark.covers("service.instrument_pending->failure_exit")
def test_a_pending_instrument_is_logged_and_the_service_exits_with_a_failure(
    watcher: WatcherFactory, server: ServerView, instrument_id: str
) -> None:
    pc = service_pc(watcher)
    pc.install_service()
    server.set_instrument_status(instrument_id, "pending")

    refused_start(pc)

    assert "is still pending activation" in pc.log_text()
    assert not pc.is_running()


@pytest.mark.covers("service.no_watcher_id->failure_exit")
def test_a_config_without_a_watcher_id_is_logged_and_the_service_exits_with_a_failure(
    watcher: WatcherFactory,
) -> None:
    pc = service_pc(watcher)
    pc.install_service()
    good = pc.load_config()
    pc.write_config(good.model_copy(update={"watcher_ids": {}}))

    refused_start(pc)

    assert "No watcher_id in config" in pc.log_text()
    assert not pc.is_running()


@pytest.mark.covers("service.failures->stays_stopped_after_two")
def test_the_third_failure_inside_the_window_leaves_the_service_stopped(
    watcher: WatcherFactory, server: ServerView, proxy: FaultProxy
) -> None:
    pc = service_pc(watcher)
    pc.install_service(failure_actions="product")
    message = "Cannot reach API during startup"
    start_watching(pc, server)

    # The first failure is a crash: the process is killed, and the SCM restarts it after 60 s.
    # The server is gone by then, so the restarted service ends with a `SystemExit(1)`, which is
    # the second failure (restart after 120 s) and the first refusal. The next restart is refused
    # too: the third failure. A crash and a `SystemExit(1)` count as failures of one service, so
    # the SCM has no restart left after two refusals.
    pc.kill()
    killed_at = time.monotonic()
    proxy.go_down()

    wait_until(
        lambda: count_in_log(pc, message) >= 1,
        150,
        pc.log_tail,
        what="the restart after the kill, which the API refuses",
    )
    first_refusal_at = time.monotonic()
    low, high = FIRST_RESTART_SECONDS
    assert low <= first_refusal_at - killed_at <= high

    wait_until(
        lambda: count_in_log(pc, message) >= 2,
        220,
        pc.log_tail,
        what="the second restart, which the API refuses",
    )
    low, high = SECOND_RESTART_SECONDS
    assert low <= time.monotonic() - first_refusal_at <= high

    # The third failure has no restart: the SCM's actions end with a "no action" entry, which
    # `sc qfailure` doesn't print and the registry value does. Showing it by waiting would take
    # more than the 120 s of the second restart, so the entry is read.
    pc.wait_for_state(ServiceState.STOPPED, timeout=30)
    assert pc.exit_code not in (None, 0)
    assert pc.host.failure_action_list() == (
        ("restart", 60_000),
        ("restart", 120_000),
        ("none", 0),
    )
    stays_true(
        lambda: not pc.is_running() and count_in_log(pc, message) == 2,
        10,
        pc.log_tail,
        what="no restart after the third failure",
    )


@pytest.mark.covers("service.broken_install->bootstrap_log")
def test_a_service_that_cannot_start_its_module_writes_the_traceback_to_the_bootstrap_log(
    watcher: WatcherFactory, tmp_path: Path
) -> None:
    pc = service_pc(watcher)
    pc.install_service()
    # A `sitecustomize` the service's interpreter runs before the module does, which makes the
    # call into the Service Control Manager fail, as a broken pywin32 or a damaged install would.
    fault = tmp_path / "broken-service-host"
    fault.mkdir()
    (fault / "sitecustomize.py").write_text(
        "import servicemanager\n"
        "def _broken(*args, **kwargs):\n"
        "    raise RuntimeError('e2e: simulated broken service host')\n"
        "servicemanager.StartServiceCtrlDispatcher = _broken\n",
        encoding="utf-8",
    )
    pc.host.set_environment({"PYTHONPATH": str(fault)})

    # The service can't start: `service start` may report that, and the SCM says it stopped.
    pc.run_cli("service", "start")
    pc.wait_for_state(ServiceState.STOPPED, timeout=60)

    assert pc.bootstrap_log.is_file(), (
        f"the service wrote no {pc.bootstrap_log.name}.\n{pc.log_tail()}"
    )
    written = pc.log_text()
    assert "bootstrap failure" in written, pc.log_tail()
    assert "RuntimeError: e2e: simulated broken service host" in written
    assert "Traceback (most recent call last)" in written


# ---------------------------------------------------------------------------
# The upgrade worker
# ---------------------------------------------------------------------------


@pytest.mark.covers("service.upgrade_task->repaired_after_deletion")
def test_a_deleted_upgrade_task_is_registered_again_at_the_next_start(
    watcher: WatcherFactory, server: ServerView
) -> None:
    pc = service_pc(watcher)
    pc.install_service()
    assert pc.host.task_exists()
    pc.host.delete_task()
    assert not pc.host.task_exists()
    assert pc.worker_script.is_file()

    start_watching(pc, server)

    wait_until(pc.host.task_exists, 60, pc.log_tail, what="the task to be registered again")
    assert "re-registering the task" in pc.log_text()
    task = pc.host.task_details()
    assert task["Run As User"].upper().endswith("SYSTEM")
    assert pc.worker_script.name in task["Task To Run"]


@pytest.mark.covers("service.upgrade_task->repair_impossible_warned")
def test_without_the_task_and_its_script_the_service_says_to_reinstall_and_keeps_running(
    watcher: WatcherFactory, server: ServerView
) -> None:
    pc = service_pc(watcher)
    pc.install_service()
    pc.host.delete_task()
    pc.worker_script.unlink()

    start_watching(pc, server)

    pc.wait_for_log(r"Cannot self-repair")
    assert "service reinstall" in pc.log_text()
    assert not pc.host.task_exists()
    pid = pc.pid
    server.wait_for_heartbeats(pc.watcher_id, count=3)
    assert pc.pid == pid
    assert pc.is_running()


@pytest.mark.covers("service.upgrade->worker_mandatory_installs")
def test_a_mandatory_release_is_installed_by_the_worker_and_the_service_comes_back_on_it(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    package_index: LocalPackageIndex,
    bumped_wheel: Path,
    bumped_version: str,
    current_version: str,
    watch_dir: Path,
    instrument_id: str,
) -> None:
    # A gate of 50 quiet heartbeats would hold a non-mandatory release for far longer than
    # these waits: a mandatory one ignores it.
    pc = service_pc(
        watcher,
        own_install=True,
        index_url=package_index.url,
        overrides={**CHECK_EVERY_HEARTBEAT, **idle_ticks(50)},
    )
    package_index.clear_requested_paths()
    start_watching(pc, server)
    files = write_run(watch_dir, "RUN001", {"a.csv": SMALL})
    server.wait_for_uploaded(instrument_id, "RUN001", "RUN001/a.csv", content=files["a.csv"])

    admin.set_release(bumped_version, mandatory=True).raise_for_status()

    # The service hands the install to the scheduled task, and says so. The spec keeps the
    # `windows-service` extra: without it the reinstall would remove pywin32.
    started = server.wait_for_event(pc.watcher_id, event_type="update_started")
    assert started.details["via_worker"] is True
    assert started.details["mandatory"] is True
    assert started.details["pkg_spec"] == f"data-hub-watcher[windows-service]=={bumped_version}"
    # The marker the updater writes before it dispatches is in the config directory, beside the
    # config the service was registered with, and not in the profile of LocalSystem.
    marker = pc.config_dir() / UPGRADE_MARKER_FILENAME
    wait_until(
        marker.exists, 30, pc.log_tail, what="the in-progress marker in the config directory"
    )
    wait_for_wheel_request(pc, package_index, bumped_version)

    # The worker stops the service (a clean stop, not an exit for the SCM to restart), runs uv,
    # and starts it again.
    pc.await_upgrade_restart(pc.install_timeout_seconds)
    stopped = server.wait_for_event(
        pc.watcher_id, event_type="watcher_stopped", message_contains=pc.update_stop_message
    )
    assert stopped.message == "Service stopped"
    succeeded = server.wait_for_event(pc.watcher_id, event_type="update_succeeded")
    assert succeeded.details["via_worker"] is True
    assert succeeded.details["worker_returncode"] == 0
    assert succeeded.details["previous_version"] == current_version
    assert succeeded.details["target_version"] == bumped_version
    wait_for_watching_on(server, pc, bumped_version)
    assert pc.installed_version() == bumped_version
    assert update_event_sequence(server, pc) == ["update_started", "update_succeeded"]
    # What the worker did is in its own log, in the config directory.
    worker_log = pc.worker_log.read_text(encoding="utf-8", errors="replace")
    assert "stopping service DataHubWatcher" in worker_log
    assert "uv exited 0" in worker_log
    assert "service started" in worker_log
    # The worker read its request and wrote its result where the service looks (its script was
    # rendered for the config directory, and the service read the result from there: the
    # `worker_returncode` above), and the service that came back cleared all three sentinels.
    # None of them was ever written for LocalSystem's own profile.
    system_profile = pc.system_root / "System32" / "config" / "systemprofile" / ".data-hub"
    for name in (UPGRADE_MARKER_FILENAME, UPGRADE_REQUEST_FILENAME, UPGRADE_RESULT_FILENAME):
        assert not (pc.config_dir() / name).exists(), f"{name} was left in the config directory"
        assert not (system_profile / name).exists(), f"{name} is in the profile of LocalSystem"


@pytest.mark.covers("service.upgrade->worker_idle_gated")
def test_a_non_mandatory_release_goes_to_the_worker_only_after_the_idle_window(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    package_index: LocalPackageIndex,
    bumped_wheel: Path,
    bumped_version: str,
    watch_dir: Path,
    instrument_id: str,
) -> None:
    quiet_needed = 4
    pc = service_pc(
        watcher,
        own_install=True,
        index_url=package_index.url,
        overrides={**CHECK_EVERY_HEARTBEAT, **idle_ticks(quiet_needed)},
    )
    package_index.clear_requested_paths()
    start_watching(pc, server)

    # The instrument keeps uploading for longer than the gate needs quiet heartbeats.
    admin.set_release(bumped_version).raise_for_status()
    offered_at = server.last_heartbeat_id(pc.watcher_id)
    number = 0
    while server.last_heartbeat_id(pc.watcher_id) - offered_at < quiet_needed + 2:
        number += 1
        assert number <= 40, "the heartbeats are not advancing"
        assert update_events(server, pc) == [], "the update started while uploads came in"
        name = f"file-{number}.csv"
        write_run(watch_dir, "RUN001", {name: SMALL})
        server.wait_for_uploaded(instrument_id, "RUN001", f"RUN001/{name}")
    assert update_events(server, pc) == []
    assert package_index.requested_paths == []

    # Once it is quiet the service dispatches it, and the worker installs it.
    started = server.wait_for_event(pc.watcher_id, event_type="update_started", timeout=60)
    assert started.details["mandatory"] is False
    assert started.details["via_worker"] is True
    wait_for_wheel_request(pc, package_index, bumped_version)
    pc.await_upgrade_restart(pc.install_timeout_seconds)
    server.wait_for_event(pc.watcher_id, event_type="update_succeeded")
    wait_for_watching_on(server, pc, bumped_version)
    assert pc.installed_version() == bumped_version


@pytest.mark.covers("service.upgrade->worker_failure_reported")
def test_a_failed_install_in_the_worker_is_reported_by_the_service_that_comes_back(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    package_index: LocalPackageIndex,
    bumped_wheel: Path,
    bumped_version: str,
    current_version: str,
) -> None:
    pc = service_pc(
        watcher, own_install=True, index_url=package_index.url, overrides=CHECK_EVERY_HEARTBEAT
    )
    package_index.clear_requested_paths()
    # uv can't find the package: the worker's install fails, and the old install is left as it is.
    package_index.set_project_unavailable("data-hub-watcher", 404)
    start_watching(pc, server)

    admin.set_release(bumped_version, mandatory=True).raise_for_status()
    server.wait_for_event(pc.watcher_id, event_type="update_started")
    # The release goes back at once, so the service that comes back is not offered the update
    # again and again.
    admin.set_release(current_version).raise_for_status()

    pc.await_upgrade_restart(pc.install_timeout_seconds)

    failed = server.wait_for_event(pc.watcher_id, event_type="update_failed", timeout=60)
    assert failed.details["via_worker"] is True
    assert failed.details["worker_returncode"] not in (0, None)
    assert failed.details["reason"]
    assert failed.details["target_version"] == bumped_version
    assert failed.message.startswith(f"Watcher upgrade to {bumped_version} failed")
    # It asked the index for the package, and nothing was installed: the service runs the old
    # version, and says so.
    assert any(p.startswith("/simple/data-hub-watcher/") for p in package_index.requested_paths)
    assert pc.installed_version() == current_version
    wait_for_watching_on(server, pc, current_version)
    assert update_event_sequence(server, pc) == ["update_started", "update_failed"]


# ---------------------------------------------------------------------------
# Reinstall and uninstall
# ---------------------------------------------------------------------------


@pytest.mark.covers("service.reinstall->service_replaced")
def test_reinstall_stops_removes_installs_and_starts_the_service_in_one_command(
    watcher: WatcherFactory, server: ServerView
) -> None:
    pc = service_pc(watcher)
    start_watching(pc, server)
    old_pid = pc.pid
    assert old_pid is not None

    result = pc.reinstall_service()

    for step in ("Service stopped", "Service uninstalled", "Service installed", "Service started"):
        assert step in result.stdout, result.output
    assert pc.pid not in (None, old_pid)
    # A new process, which the server saw stop and start again.
    server.wait_for_watcher_status(pc.watcher_id, "watching")
    assert len(server.events(pc.watcher_id, event_type="watcher_started")) == 2
    config_path, env_path = pc.registered_paths()
    assert os.path.normcase(config_path) == os.path.normcase(pc.config_path)
    assert os.path.normcase(env_path) == os.path.normcase(pc.env_path)
    assert pc.host.task_exists()
    assert pc.worker_script.is_file()


@pytest.mark.covers("service.uninstall->cleaned_up")
def test_uninstall_removes_the_service_its_registry_values_and_task_and_keeps_the_logs(
    watcher: WatcherFactory, server: ServerView
) -> None:
    pc = service_pc(watcher)
    start_watching(pc, server)
    assert pc.host.registry_values().get("ConfigPath")
    assert pc.host.task_exists()
    assert pc.worker_script.is_file()

    result = pc.run_cli("service", "uninstall")

    assert result.returncode == 0, result.output
    assert "Service removed" in result.stdout
    pc.wait_for_removal(60)
    assert pc.service_status() is None
    assert pc.host.registry_values() == {}
    assert not pc.host.task_exists()
    assert not pc.worker_script.exists()
    # The logs stay, for whoever looks at what happened.
    assert pc.watcher_log.is_file()
    assert START_LINE.search(pc.log_text())
    # Uninstalling stopped it gracefully first.
    server.wait_for_watcher_status(pc.watcher_id, "stopped")


# ---------------------------------------------------------------------------
# Known bugs
# ---------------------------------------------------------------------------


@pytest.mark.xfail(
    strict=True,
    raises=KnownBugStillPresent,
    reason=(
        "ENG-2117: a service whose watcher was deregistered "
        "keeps running with 404s instead of stopping cleanly, and staying stopped"
    ),
)
@pytest.mark.covers("service.deregistered->stays_stopped")
def test_a_deregistered_service_stops_and_the_scm_does_not_bring_it_back(
    watcher: WatcherFactory, server: ServerView, admin: Admin, proxy: FaultProxy
) -> None:
    pc = service_pc(watcher)
    pc.install_service()
    # Restart after 2 s for any failure: a deregistered watcher can never recover, so the
    # recovery actions must not bring it back, and a restart shows within seconds. (The intended
    # outcome, PROPOSED, is that the service exits 0: a clean stop for the SCM, which a failure
    # exit would not be. The SCM restarts only what fails.)
    pc.host.set_restart_actions([2_000, 2_000])
    start_watching(pc, server)
    admin.deregister_watcher(pc.watcher_id).raise_for_status()
    proxy.wait_for_request(
        lambda r: r.method == "POST" and r.path.endswith("/heartbeat") and r.upstream_status == 404,
        timeout=30,
    )

    with known_bug():
        wait_until(lambda: not pc.is_running(), 30, pc.log_tail, what="the service to stop")
        assert pc.exit_code == 0, f"the service stopped with {pc.exit_code}, not as a clean stop"
        stays_true(
            lambda: not pc.is_running(),
            10,
            pc.log_tail,
            what="the SCM not to restart a deregistered service",
        )


@pytest.mark.xfail(
    strict=True,
    raises=KnownBugStillPresent,
    reason=(
        "ENG-2131: the updater doesn't mark an upgrade it hands to the "
        "worker as in progress (the in-process path does), so a check on the next heartbeat "
        "dispatches it again before the worker has stopped the service"
    ),
)
@pytest.mark.covers("service.upgrade->worker_dispatch_once")
def test_an_upgrade_is_dispatched_to_the_worker_once(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    proxy: FaultProxy,
    package_index: LocalPackageIndex,
    bumped_wheel: Path,
    bumped_version: str,
    watch_dir: Path,
) -> None:
    # A heartbeat, and a check for an update, every second.
    pc = service_pc(
        watcher,
        own_install=True,
        index_url=package_index.url,
        overrides={**CHECK_EVERY_HEARTBEAT, testing_overrides.HEARTBEAT_INTERVAL_ENV_VAR: "1"},
    )
    package_index.clear_requested_paths()
    start_watching(pc, server)

    # An upload that is still under way when the worker's `Stop-Service` arrives. The stop waits
    # up to 5 seconds for it (`FileMonitor.stop`), and the heartbeat, with its update check every
    # second, keeps going until the stop gets past that wait. So checks come after the dispatch
    # however fast the worker is (on a runner it stops the service about a second after it is
    # triggered).
    proxy.add_fault("delay", path=r"/api/local-s3/", method="PUT", delay_seconds=20, count=1)
    write_run(watch_dir, "RUN001", {"held.csv": SMALL})
    proxy.wait_for_request(
        lambda r: r.method == "PUT" and "/api/local-s3/" in r.path and r.fault_mode == "delay",
        timeout=30,
    )

    admin.set_release(bumped_version, mandatory=True).raise_for_status()
    server.wait_for_event(pc.watcher_id, event_type="update_started")
    wait_for_wheel_request(pc, package_index, bumped_version)
    pc.await_upgrade_restart(pc.install_timeout_seconds)
    server.wait_for_event(pc.watcher_id, event_type="update_succeeded")
    wait_for_watching_on(server, pc, bumped_version)

    # One upgrade, one `update_started`.
    dispatches = server.events(pc.watcher_id, event_type="update_started")
    with known_bug():
        assert len(dispatches) == 1, (
            f"the upgrade was dispatched {len(dispatches)} times, at "
            + ", ".join(str(e.timestamp) for e in dispatches)
        )


@pytest.mark.xfail(
    strict=True,
    raises=KnownBugStillPresent,
    reason=(
        "ENG-2130: `_run_service_loop` calls `load_config` "
        "outside any `try`, so the error is raised out of `SvcRun` and reaches only the Event "
        "Log, where every other start-up refusal is logged in watcher.log"
    ),
)
@pytest.mark.covers("service.config_invalid->logged_in_watcher_log")
def test_a_config_that_does_not_load_is_logged_in_the_service_log(watcher: WatcherFactory) -> None:
    pc = service_pc(watcher)
    pc.install_service()
    pc.write_config_text("instrument: [unclosed\n")

    # The start is refused, as for any config that doesn't load, and the driver finds the
    # message where pywin32 put it: in the Event Log's entry for the failed `SvcRun`.
    refused_start(pc)
    assert "Malformed YAML" in pc.log_text()

    # PROPOSED: the service logs it, as it logs the other refusals, in the file an operator reads.
    with known_bug():
        assert "Malformed YAML" in pc.watcher_log_text(), (
            "watcher.log has no word about the config that failed to load:\n"
            + pc.watcher_log_text()[-1500:]
        )


@pytest.mark.xfail(
    strict=True,
    raises=KnownBugStillPresent,
    reason=(
        "ENG-2128: a file that is locked after its last write counts as "
        "stable (stability reads only the size and time), then reading it for the upload hits "
        "a sharing violation, and the file is tried again only at the next start"
    ),
)
@pytest.mark.covers("file.locked->uploaded_after_release")
def test_a_file_that_stays_locked_after_its_last_write_is_uploaded_once_it_is_released(
    watcher: WatcherFactory, server: ServerView, watch_dir: Path, instrument_id: str
) -> None:
    pc = service_pc(watcher, stability_period_seconds=2)
    start_watching(pc, server)
    target = watch_dir / "RUN001" / "scan.csv"

    with ExclusiveWriter(target) as writer:
        # One write, and the writer keeps the file open. Nothing changes after it, so after the
        # stability period the watcher calls the file stable, and then it can't read it.
        writer.write(payload(300, seed=7))
        pc.wait_for_log(r"File stable: .*scan\.csv", timeout=30)
        stays_true(
            lambda: pc.is_running(),
            5,
            pc.log_tail,
            what="the service to carry on while the file is locked",
        )
        with pytest.raises(PermissionError):
            target.read_bytes()

    # PROPOSED: released, the file is uploaded, without a restart of the service.
    with known_bug():
        server.wait_for_uploaded(
            instrument_id, "RUN001", "RUN001/scan.csv", content=bytes(writer.content), timeout=30
        )


@pytest.mark.xfail(
    strict=True,
    raises=KnownBugStillPresent,
    reason=(
        "ENG-2129: the service class has no `SvcShutdown`, so `sc "
        "queryex` lists IGNORES_SHUTDOWN and every reboot kills the service with no `stopped` "
        "heartbeat"
    ),
)
@pytest.mark.covers("service.system_shutdown->clean_stop")
def test_the_service_asks_to_be_told_about_a_shutdown_of_the_system(
    watcher: WatcherFactory, server: ServerView
) -> None:
    pc = service_pc(watcher)
    start_watching(pc, server)

    status = pc.service_status()
    assert status is not None
    assert status.state is ServiceState.RUNNING
    # `sc queryex` lists what the service accepts, and the listing was read.
    assert "STOPPABLE" in status.controls, status.controls

    # PROPOSED: it accepts a shutdown, so that a reboot stops it as `service stop` does.
    with known_bug():
        assert status.accepts_shutdown is True, f"sc queryex lists {', '.join(status.controls)}"
