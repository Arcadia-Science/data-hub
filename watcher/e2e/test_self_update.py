"""The watcher updating itself, end to end.

Each scenario that installs an upgrade runs on a ``uv tool install`` of its own
(``private_install``), because the watcher reinstalls into the folder it runs from. The
"newer" release is the current wheel rebuilt under a higher version (``bumped_wheel``), which
the local package index serves in place of PyPI (``index_url=package_index.url``). Everything
else the install needs still comes from PyPI, through uv's cache. A test that offers the newer
release asks for ``bumped_wheel`` so that the wheel exists before the release is set.

What is driven and what is checked:

* The release is set through the admin route (``admin.set_release``), the way an admin does it
  in Settings. Gates (idle, quiet runs) are shaped with the heartbeat, the update-check and
  the idle-tick overrides, so a scenario takes seconds, and are shown by the server's own
  heartbeats and events, not by sleeping.
* An install is proved by what the index was asked for (``package_index.requested_paths``),
  by ``data-hub-watcher --version`` of the install, and by the version the restarted watcher
  heartbeats with.
* After the install the in-process updater makes ``watch`` exit with code 1 so that a
  supervisor starts it again. The driver plays that supervisor (``restart()``), see
  ``upgrade_restart``. The Windows service goes through the upgrade worker instead, which
  stops and starts the service itself, so the service driver will need its own version of
  that one helper.
"""

from __future__ import annotations
from collections.abc import Callable
from pathlib import Path

import pytest

from data_hub_shared.testing_index import LocalPackageIndex
from data_hub_shared.testing_proxy import FaultProxy, RecordedRequest
from data_hub_watcher import testing_overrides
from data_hub_watcher.updater import UPGRADE_MARKER_FILENAME
from e2e_support.admin import Admin
from e2e_support.drivers import ToolInstall, WatcherDriver
from e2e_support.factory import WatcherFactory
from e2e_support.files import SMALL, write_file, write_run
from e2e_support.server import HeartbeatRow, ServerView, WatcherRow
from e2e_support.waiting import wait_until

pytestmark = pytest.mark.e2e

# The `private_install` fixture: `private_install()` installs the current wheel,
# `private_install(bumped_wheel)` another one.
PrivateInstall = Callable[..., ToolInstall]

# A `uv tool install --reinstall` re-reads the metadata of every dependency from PyPI, which
# takes seconds on a good connection and longer on a bad one.
INSTALL_TIMEOUT = 180.0

# Check for an update on every heartbeat (the default is every 5th), so a scenario does not
# wait for the next check.
CHECK_EVERY_HEARTBEAT = {testing_overrides.UPDATE_CHECK_INTERVAL_TICKS_ENV_VAR: "1"}


def idle_ticks(count: int) -> dict[str, str]:
    """The override for how many quiet heartbeats a non-mandatory update waits for."""
    return {testing_overrides.UPDATE_IDLE_TICKS_ENV_VAR: str(count)}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def wheel_request_prefix(version: str) -> str:
    return f"/files/data_hub_watcher-{version}-"


def wait_for_wheel_request(index: LocalPackageIndex, version: str) -> None:
    """Wait until the index was asked for the wheel of ``version``: the install happened
    against the local index and not PyPI."""
    prefix = wheel_request_prefix(version)
    wait_until(
        lambda: any(path.startswith(prefix) for path in index.requested_paths),
        INSTALL_TIMEOUT,
        lambda: "index requests:\n" + "\n".join(index.requested_paths),
        what=f"the package index to be asked for the {version} wheel",
    )


def upgrade_marker(pc: WatcherDriver) -> Path:
    """The file the updater writes before it installs and the next start reads and removes."""
    return pc.config_dir() / UPGRADE_MARKER_FILENAME


def upgrade_restart(pc: WatcherDriver) -> None:
    """Carry an update through its restart: once the new version is installed the watcher
    exits with code 1, and the driver, standing in for its supervisor, starts it again.

    This is the one step that differs on the Windows service, where the upgrade worker
    stops and starts the service itself.
    """
    assert pc.wait_exit(timeout=INSTALL_TIMEOUT) == 1, pc.log_tail()
    pc.restart()


def wait_for_watching_on(server: ServerView, pc: WatcherDriver, version: str) -> WatcherRow:
    """Wait until the server shows the watcher as watching with ``version``, which is what
    its heartbeats say it is running."""

    def running() -> WatcherRow | None:
        row = server.watcher(pc.watcher_id)
        return row if row.status == "watching" and row.watcher_version == version else None

    return server.wait_until(
        running, 60, what=f"the watcher to be watching on {version}", watcher_id=pc.watcher_id
    )


def wait_for_upload_heartbeat(server: ServerView, watcher_id: str) -> HeartbeatRow:
    """Wait for a heartbeat that reports uploaded files, the one that restarts the count of
    quiet heartbeats an update waits for."""
    return server.wait_until(
        lambda: next(
            (b for b in server.heartbeats(watcher_id) if (b.files_uploaded_since_last or 0) > 0),
            None,
        ),
        30,
        what="a heartbeat that reports an upload",
        watcher_id=watcher_id,
    )


def update_checks(proxy: FaultProxy) -> list[RecordedRequest]:
    """The update-check requests the watcher has made."""
    return [r for r in proxy.requests if r.path.split("?")[0].endswith("/update-check")]


def answered_update_checks(proxy: FaultProxy) -> list[RecordedRequest]:
    return [r for r in update_checks(proxy) if r.upstream_status == 200]


def update_events(server: ServerView, pc: WatcherDriver) -> list[str]:
    """The update events the watcher has sent, oldest first."""
    kinds = {"update_started", "update_succeeded", "update_failed"}
    return [e.event_type for e in server.events(pc.watcher_id) if e.event_type in kinds]


def assert_no_update_attempted(
    server: ServerView,
    proxy: FaultProxy,
    package_index: LocalPackageIndex,
    pc: WatcherDriver,
    current_version: str,
    *,
    checks: int = 3,
) -> None:
    """Wait for ``checks`` more answered update checks, then check that none of them led to
    an install: no update event, no request to the package index, still the same version."""
    already = len(answered_update_checks(proxy))
    last_heartbeat = server.last_heartbeat_id(pc.watcher_id)
    server.wait_until(
        lambda: len(answered_update_checks(proxy)) >= already + checks,
        60,
        what=f"{checks} more update checks",
        watcher_id=pc.watcher_id,
    )
    # An event is flushed on the heartbeat after the one that queued it, so one more heartbeat
    # shows an event the last check would have made.
    server.wait_for_heartbeats(pc.watcher_id, count=2, after_id=last_heartbeat)
    assert update_events(server, pc) == []
    assert package_index.requested_paths == []
    assert pc.is_running()
    assert server.watcher(pc.watcher_id).watcher_version == current_version


# ---------------------------------------------------------------------------
# The upgrade, start to finish
# ---------------------------------------------------------------------------


@pytest.mark.covers(
    "selfupdate.mandatory->started",
    "selfupdate.installed->exit_for_restart",
    "selfupdate.restart->succeeded",
    "event.update_started->emitted",
    "event.update_succeeded->emitted",
    "event.watcher_stopped->emitted",
)
def test_mandatory_release_installs_and_restarts_into_the_new_version(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    package_index: LocalPackageIndex,
    private_install: PrivateInstall,
    bumped_wheel: Path,
    bumped_version: str,
    current_version: str,
    watch_dir: Path,
    instrument_id: str,
) -> None:
    install = private_install()
    # With 50 quiet heartbeats required (100 s), a gate that applied would hold the update
    # for far longer than the waits below.
    pc = watcher(
        tool_install=install,
        index_url=package_index.url,
        overrides={**CHECK_EVERY_HEARTBEAT, **idle_ticks(50)},
    )
    package_index.clear_requested_paths()
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")
    assert install.version() == current_version
    assert server.watcher(pc.watcher_id).watcher_version == current_version

    # The instrument has just finished a run, so a non-mandatory release would have to wait.
    files = write_run(watch_dir, "RUN001", {"a.csv": SMALL})
    server.wait_for_uploaded(instrument_id, "RUN001", "RUN001/a.csv", content=files["a.csv"])
    wait_for_upload_heartbeat(server, pc.watcher_id)

    admin.set_release(bumped_version, mandatory=True).raise_for_status()

    # The update starts at the next check, gates or not.
    started = server.wait_for_event(pc.watcher_id, event_type="update_started")
    assert started.details["current_version"] == current_version
    assert started.details["target_version"] == bumped_version
    assert started.details["mandatory"] is True
    assert started.details["install_method"] == "uv-tool"
    wait_for_wheel_request(package_index, bumped_version)
    assert any(p.startswith("/simple/data-hub-watcher/") for p in package_index.requested_paths)
    assert upgrade_marker(pc).exists()

    # Installed: the watcher stops with exit code 1 and says why, and the server sees it stop.
    assert pc.wait_exit(timeout=INSTALL_TIMEOUT) == 1, pc.log_tail()
    stopped = server.wait_for_event(pc.watcher_id, event_type="watcher_stopped")
    assert "restarting for auto-update" in stopped.message
    server.wait_for_watcher_status(pc.watcher_id, "stopped")
    assert install.version() == bumped_version
    assert server.watcher(pc.watcher_id).watcher_version == current_version  # not restarted yet

    # The supervisor starts it again, and it is on the new version.
    pc.restart()
    succeeded = server.wait_for_event(pc.watcher_id, event_type="update_succeeded")
    assert succeeded.details["previous_version"] == current_version
    assert succeeded.details["target_version"] == bumped_version
    wait_for_watching_on(server, pc, bumped_version)
    assert not upgrade_marker(pc).exists()
    assert server.effective_status(pc.watcher_id) == "watching"
    assert update_events(server, pc) == ["update_started", "update_succeeded"]

    # Running the advertised version, it is not updated again.
    server.wait_for_heartbeats(
        pc.watcher_id, count=3, after_id=server.last_heartbeat_id(pc.watcher_id)
    )
    assert update_events(server, pc) == ["update_started", "update_succeeded"]
    assert pc.is_running()


@pytest.mark.covers("selfupdate.mandatory->rollback_installed")
def test_mandatory_release_older_than_the_running_version_rolls_back(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    package_index: LocalPackageIndex,
    private_install: PrivateInstall,
    bumped_wheel: Path,
    bumped_version: str,
    current_version: str,
) -> None:
    # A PC running the newer build, and an admin who pulls the release back to the older one.
    install = private_install(bumped_wheel)
    assert install.version() == bumped_version
    pc = watcher(tool_install=install, index_url=package_index.url, overrides=CHECK_EVERY_HEARTBEAT)
    package_index.clear_requested_paths()
    pc.start()
    wait_for_watching_on(server, pc, bumped_version)

    admin.set_release(current_version, mandatory=True).raise_for_status()

    started = server.wait_for_event(pc.watcher_id, event_type="update_started")
    assert started.details["current_version"] == bumped_version
    assert started.details["target_version"] == current_version
    wait_for_wheel_request(package_index, current_version)
    upgrade_restart(pc)

    server.wait_for_event(pc.watcher_id, event_type="update_succeeded")
    wait_for_watching_on(server, pc, current_version)
    assert install.version() == current_version
    assert not any(
        p.startswith(wheel_request_prefix(bumped_version)) for p in package_index.requested_paths
    )


@pytest.mark.covers("selfupdate.below_floor->recovers_by_update")
def test_watcher_below_the_minimum_version_updates_and_heartbeats_again(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    proxy: FaultProxy,
    package_index: LocalPackageIndex,
    private_install: PrivateInstall,
    bumped_wheel: Path,
    bumped_version: str,
    current_version: str,
) -> None:
    # Everything older than the new release is turned away, and the release is mandatory.
    admin.set_release(
        bumped_version, min_supported_version=bumped_version, mandatory=True
    ).raise_for_status()
    install = private_install()
    pc = watcher(tool_install=install, index_url=package_index.url, overrides=CHECK_EVERY_HEARTBEAT)
    package_index.clear_requested_paths()
    pc.start()

    def refusals() -> list[RecordedRequest]:
        return [
            r for r in proxy.requests if r.path.endswith("/heartbeat") and r.upstream_status == 426
        ]

    # Its heartbeats get a 426 and the server records none of them, but the update check
    # is a different route, and the watcher still makes it.
    wait_until(
        lambda: len(refusals()) >= 2,
        30,
        lambda: server.dump(pc.watcher_id),
        what="two heartbeats refused with a 426",
    )
    assert server.heartbeats(pc.watcher_id) == []
    assert server.watcher(pc.watcher_id).status == "registered"

    server.wait_for_event(pc.watcher_id, event_type="update_started")
    wait_for_wheel_request(package_index, bumped_version)
    upgrade_restart(pc)

    # On the new version it is accepted again.
    server.wait_for_event(pc.watcher_id, event_type="update_succeeded")
    wait_for_watching_on(server, pc, bumped_version)
    assert server.effective_status(pc.watcher_id) == "watching"
    refused = len(refusals())
    server.wait_for_heartbeats(pc.watcher_id, count=2)
    assert len(refusals()) == refused
    assert install.version() == bumped_version


# ---------------------------------------------------------------------------
# The gates in front of a non-mandatory release
# ---------------------------------------------------------------------------


@pytest.mark.covers(
    "selfupdate.idle_gate->waits_for_quiet_uploads",
    "selfupdate.idle_window->installs",
)
def test_non_mandatory_release_waits_for_quiet_uploads_then_installs(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    package_index: LocalPackageIndex,
    private_install: PrivateInstall,
    bumped_wheel: Path,
    bumped_version: str,
    current_version: str,
    watch_dir: Path,
    instrument_id: str,
) -> None:
    quiet_needed = 4
    install = private_install()
    pc = watcher(
        tool_install=install,
        index_url=package_index.url,
        overrides={**CHECK_EVERY_HEARTBEAT, **idle_ticks(quiet_needed)},
    )
    package_index.clear_requested_paths()
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")

    # An upload, and the heartbeat that reports it.
    write_file(watch_dir / "RUN001" / "file-0.csv", SMALL)
    server.wait_for_uploaded(instrument_id, "RUN001", "RUN001/file-0.csv")
    wait_for_upload_heartbeat(server, pc.watcher_id)

    # A release is offered, and the instrument keeps uploading (each file after the one
    # before it is done, so there is an upload in every few heartbeats) for longer than the
    # gate needs quiet heartbeats. The watcher checks on every one of them.
    admin.set_release(bumped_version).raise_for_status()
    offered_at = server.last_heartbeat_id(pc.watcher_id)
    number = 0
    while server.last_heartbeat_id(pc.watcher_id) - offered_at < quiet_needed + 2:
        number += 1
        assert number <= 40, "the heartbeats are not advancing"
        assert update_events(server, pc) == [], "the update started while uploads were coming in"
        name = f"file-{number}.csv"
        write_file(watch_dir / "RUN001" / name, SMALL)
        server.wait_for_uploaded(instrument_id, "RUN001", f"RUN001/{name}")
    assert update_events(server, pc) == []
    assert package_index.requested_paths == []

    # Once it is quiet it installs, after as many quiet heartbeats as the gate needs.
    started = server.wait_for_event(pc.watcher_id, event_type="update_started", timeout=60)
    assert started.details["mandatory"] is False
    heartbeats = [b for b in server.heartbeats(pc.watcher_id) if b.created_at <= started.created_at]
    last_busy = max(b.id for b in heartbeats if (b.files_uploaded_since_last or 0) > 0)
    quiet = [b for b in heartbeats if b.id > last_busy]
    assert len(quiet) >= quiet_needed, (
        f"it started after {len(quiet)} quiet heartbeats, the gate needs {quiet_needed}"
    )

    wait_for_wheel_request(package_index, bumped_version)
    upgrade_restart(pc)
    server.wait_for_event(pc.watcher_id, event_type="update_succeeded")
    wait_for_watching_on(server, pc, bumped_version)
    assert install.version() == bumped_version


@pytest.mark.covers("selfupdate.run_gate->waits_for_quiet_runs")
def test_non_mandatory_release_waits_for_a_quiet_instrument_after_a_new_run(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    package_index: LocalPackageIndex,
    private_install: PrivateInstall,
    bumped_wheel: Path,
    bumped_version: str,
    watch_dir: Path,
    instrument_id: str,
) -> None:
    stability_seconds = 3
    quiet_seconds = 5 * stability_seconds  # what the watcher requires since the last new run
    install = private_install()
    # Manual uploads: nothing is ever uploaded, so only the run gate can hold the update.
    pc = watcher(
        upload_mode="manual",
        stability_period_seconds=stability_seconds,
        tool_install=install,
        index_url=package_index.url,
        overrides={**CHECK_EVERY_HEARTBEAT, **idle_ticks(1)},
    )
    package_index.clear_requested_paths()
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")
    server.wait_for_heartbeats(pc.watcher_id, count=2)

    write_run(watch_dir, "RUN001", {"a.csv": SMALL})
    server.wait_for_run(instrument_id, "RUN001")
    reported = server.wait_for_event(pc.watcher_id, event_type="run_reported")

    # With a check on every heartbeat, a missing gate would start the update at the next one.
    # Two heartbeats are about 4 s, well inside the 15 s the watcher has to wait.
    admin.set_release(bumped_version).raise_for_status()
    server.wait_for_heartbeats(
        pc.watcher_id, count=2, after_id=server.last_heartbeat_id(pc.watcher_id)
    )
    assert update_events(server, pc) == []
    assert package_index.requested_paths == []

    # It starts once the quiet time since the run has passed, as the watcher's own clock says.
    started = server.wait_for_event(pc.watcher_id, event_type="update_started", timeout=90)
    waited = (started.timestamp - reported.timestamp).total_seconds()
    assert waited >= quiet_seconds - 1, (
        f"the update started {waited:.1f} s after the run, it should wait {quiet_seconds} s"
    )
    wait_for_wheel_request(package_index, bumped_version)
    assert pc.wait_exit(timeout=INSTALL_TIMEOUT) == 1, pc.log_tail()
    assert install.version() == bumped_version


# ---------------------------------------------------------------------------
# Nothing to update to
# ---------------------------------------------------------------------------


@pytest.mark.covers("selfupdate.current_version->no_update")
def test_no_update_when_the_release_is_the_running_version_or_older(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    proxy: FaultProxy,
    package_index: LocalPackageIndex,
    current_version: str,
) -> None:
    pc = watcher(index_url=package_index.url, overrides=CHECK_EVERY_HEARTBEAT)
    package_index.clear_requested_paths()
    admin.set_release(current_version).raise_for_status()
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")

    # The release is the version it runs.
    assert_no_update_attempted(server, proxy, package_index, pc, current_version)

    # A release that is only older, and not mandatory, is not a reason to go back.
    admin.set_release("0.0.1").raise_for_status()
    assert_no_update_attempted(server, proxy, package_index, pc, current_version)


@pytest.mark.covers("selfupdate.no_release->no_update")
def test_no_update_when_the_server_has_no_release(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    proxy: FaultProxy,
    package_index: LocalPackageIndex,
    current_version: str,
) -> None:
    admin.set_release(None).raise_for_status()
    assert admin.get_release()["latest_version"] is None
    pc = watcher(index_url=package_index.url, overrides=CHECK_EVERY_HEARTBEAT)
    package_index.clear_requested_paths()
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")

    assert_no_update_attempted(server, proxy, package_index, pc, current_version)


# ---------------------------------------------------------------------------
# Failures
# ---------------------------------------------------------------------------


@pytest.mark.covers(
    "selfupdate.install_failed->update_failed",
    "event.update_failed->emitted",
    "event.update_started->emitted",
)
def test_failed_install_is_reported_and_the_watcher_keeps_running_until_it_can_retry(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    package_index: LocalPackageIndex,
    private_install: PrivateInstall,
    bumped_wheel: Path,
    bumped_version: str,
    current_version: str,
) -> None:
    install = private_install()
    pc = watcher(
        tool_install=install,
        index_url=package_index.url,
        overrides={testing_overrides.UPDATE_CHECK_INTERVAL_TICKS_ENV_VAR: "3"},
    )
    # A 404 makes uv give up at once, where it would retry a 5xx.
    package_index.set_project_unavailable("data-hub-watcher", 404)
    package_index.clear_requested_paths()
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")

    admin.set_release(bumped_version, mandatory=True).raise_for_status()
    failed = server.wait_for_event(pc.watcher_id, event_type="update_failed", timeout=90)
    assert failed.details["current_version"] == current_version
    assert failed.details["target_version"] == bumped_version
    assert str(failed.details["reason"]).startswith("subprocess exited ")
    assert failed.details["install_method"] == "uv-tool"
    assert "data-hub-watcher" in str(failed.details["stderr_tail"])
    reason = failed.details["reason"]
    assert failed.message == f"Watcher upgrade to {bumped_version} failed: {reason}"
    assert update_events(server, pc)[:2] == ["update_started", "update_failed"]
    assert any(p.startswith("/simple/data-hub-watcher/") for p in package_index.requested_paths)

    # It is still the old version and still running, and the marker is gone, so the next
    # start does not report a second failure.
    assert pc.is_running()
    assert install.version() == current_version
    assert not upgrade_marker(pc).exists()
    server.wait_for_heartbeats(
        pc.watcher_id, count=2, after_id=server.last_heartbeat_id(pc.watcher_id)
    )
    row = server.watcher(pc.watcher_id)
    assert (row.status, row.watcher_version) == ("watching", current_version)

    # The failure is not final: when the index works again the next check installs it.
    package_index.clear_unavailable()
    upgrade_restart(pc)
    server.wait_for_event(pc.watcher_id, event_type="update_succeeded")
    wait_for_watching_on(server, pc, bumped_version)
    assert install.version() == bumped_version


@pytest.mark.covers("selfupdate.uv_missing->update_failed", "event.update_failed->emitted")
def test_update_fails_with_a_clear_reason_when_uv_cannot_be_found(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    package_index: LocalPackageIndex,
    private_install: PrivateInstall,
    bumped_wheel: Path,
    bumped_version: str,
    current_version: str,
    tmp_path: Path,
) -> None:
    install = private_install()
    # The watcher looks for `uv` on its PATH (and in a few places under its home), so a PATH
    # that holds nothing hides it. The env file is what both drivers load into the process.
    nowhere = tmp_path / "empty-path"
    nowhere.mkdir()
    pc = watcher(
        tool_install=install,
        index_url=package_index.url,
        overrides={**CHECK_EVERY_HEARTBEAT, "PATH": str(nowhere)},
    )
    package_index.clear_requested_paths()
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")

    admin.set_release(bumped_version, mandatory=True).raise_for_status()
    failed = server.wait_for_event(pc.watcher_id, event_type="update_failed")
    assert failed.details["reason"] == "uv executable not found"
    assert failed.details["target_version"] == bumped_version
    assert failed.details["attempted_subprocess"] is False
    assert failed.details["candidates_tried"]
    assert "uv executable not found" in failed.message

    # It gave up before it started: no `update_started`, nothing asked of the index, and
    # the same version running.
    assert "update_started" not in update_events(server, pc)
    assert package_index.requested_paths == []
    assert pc.is_running()
    assert install.version() == current_version
    assert not upgrade_marker(pc).exists()
    server.wait_for_heartbeats(
        pc.watcher_id, count=2, after_id=server.last_heartbeat_id(pc.watcher_id)
    )
    assert server.watcher(pc.watcher_id).status == "watching"


@pytest.mark.covers(
    "selfupdate.check_failed->update_check_failed",
    "event.update_check_failed->emitted",
)
def test_three_failed_update_checks_in_a_row_are_reported_once(
    watcher: WatcherFactory, server: ServerView, proxy: FaultProxy, package_index: LocalPackageIndex
) -> None:
    pc = watcher(index_url=package_index.url, overrides=CHECK_EVERY_HEARTBEAT)

    # The first two checks fail and the third works: three failures, but not in a row.
    proxy.add_fault("status", path="/update-check", status=503, count=2)
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")
    wait_until(
        lambda: len(answered_update_checks(proxy)) >= 1,
        30,
        lambda: server.dump(pc.watcher_id),
        what="an update check that works after two that failed",
    )
    assert [r.fault_mode for r in update_checks(proxy)][:3] == ["status", "status", None]
    server.wait_for_heartbeats(
        pc.watcher_id, count=2, after_id=server.last_heartbeat_id(pc.watcher_id)
    )
    assert server.events(pc.watcher_id, kind="update_check_failed") == []

    # Now every check fails. The third in a row is reported, with the count.
    failing = proxy.add_fault("status", path="/update-check", status=503)
    event = server.wait_for_event(pc.watcher_id, kind="update_check_failed")
    assert event.event_type == "error"
    assert event.details["consecutive_failures"] == 3
    assert "503" in str(event.details["error"])
    assert event.message.startswith("Update check failed for 3 consecutive attempts")

    # More failures are not reported again, and the watcher carries on.
    failures_so_far = failing.hits
    wait_until(
        lambda: failing.hits >= failures_so_far + 2,
        30,
        lambda: server.dump(pc.watcher_id),
        what="two more failed update checks",
    )
    server.wait_for_heartbeats(
        pc.watcher_id, count=2, after_id=server.last_heartbeat_id(pc.watcher_id)
    )
    assert len(server.events(pc.watcher_id, kind="update_check_failed")) == 1
    assert pc.is_running()
    assert server.watcher(pc.watcher_id).status == "watching"
    assert update_events(server, pc) == []


# ---------------------------------------------------------------------------
# The `self-update` command
# ---------------------------------------------------------------------------


@pytest.mark.covers("selfupdate.cli_check->reports")
def test_self_update_check_reports_the_target_and_installs_nothing(
    watcher: WatcherFactory,
    admin: Admin,
    package_index: LocalPackageIndex,
    tool_install: ToolInstall,
    bumped_version: str,
    current_version: str,
) -> None:
    pc = watcher(index_url=package_index.url)
    package_index.clear_requested_paths()

    admin.set_release(bumped_version, mandatory=True).raise_for_status()
    result = pc.run_cli("self-update", "--check")
    assert result.returncode == 0, result.output
    assert f"Current version: {current_version}" in result.stdout
    assert f"Server target:   {bumped_version} [mandatory]" in result.stdout
    assert "Would upgrade: server marked release as mandatory." in result.stdout

    admin.set_release(bumped_version).raise_for_status()
    result = pc.run_cli("self-update", "--check")
    assert result.returncode == 0, result.output
    assert f"Server target:   {bumped_version}\n" in result.stdout
    assert "Would upgrade: newer version available." in result.stdout

    admin.set_release(current_version).raise_for_status()
    result = pc.run_cli("self-update", "--check")
    assert result.returncode == 0, result.output
    assert "No upgrade needed: already at or ahead of target." in result.stdout

    admin.set_release(None).raise_for_status()
    result = pc.run_cli("self-update", "--check")
    assert result.returncode == 0, result.output
    assert "Server target:   (none configured)" in result.stdout
    assert "No upgrade needed: server has no release info configured." in result.stdout

    # Checking changes nothing.
    assert package_index.requested_paths == []
    assert tool_install.version() == current_version


@pytest.mark.covers("selfupdate.cli_install->installed")
def test_self_update_installs_the_advertised_version_for_the_next_start(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    package_index: LocalPackageIndex,
    private_install: PrivateInstall,
    bumped_wheel: Path,
    bumped_version: str,
    current_version: str,
) -> None:
    install = private_install()
    pc = watcher(tool_install=install, index_url=package_index.url)
    package_index.clear_requested_paths()
    admin.set_release(bumped_version).raise_for_status()

    result = pc.run_cli("self-update", timeout=INSTALL_TIMEOUT)
    assert result.returncode == 0, result.output
    assert f"Upgrading {current_version} -> {bumped_version}" in result.stdout
    assert f"Upgrade to {bumped_version} complete" in result.stdout
    assert "Restart the watcher" in result.stdout
    wait_for_wheel_request(package_index, bumped_version)
    assert install.version() == bumped_version

    # The operator starts the watcher, and it is the new version.
    pc.start()
    wait_for_watching_on(server, pc, bumped_version)

    # It is the newest, so a second run has nothing to do.
    package_index.clear_requested_paths()
    result = pc.run_cli("self-update")
    assert result.returncode == 0, result.output
    assert "Already up to date" in result.stdout
    assert package_index.requested_paths == []
