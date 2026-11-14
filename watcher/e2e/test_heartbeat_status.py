"""Heartbeats and the status the server shows for a watcher.

The watcher sends a heartbeat every few seconds (2 s in this suite). The server stores each
one, keeps the newest status on the watcher row, and answers ``GET /watchers/:id`` with the
*effective* status, which turns a running watcher that has been silent for five minutes into
``stale``. A watcher that stopped cleanly stays ``stopped`` however old its last heartbeat
is. (One that stopped for a Windows restart or an update turns ``stale`` after 15 minutes.
A test here can't make a watcher send the mark for that, so the integration tests of the web
app cover it.) The suite never waits for those five minutes: it ages
``last_heartbeat_at`` in the database, after it has made sure the running watcher can't
refresh it (a fault on ``/heartbeat``, a 426, or a stopped watcher).
"""

from __future__ import annotations
from itertools import pairwise
from pathlib import Path

import pytest

from data_hub_shared.testing_proxy import FaultProxy, RecordedRequest
from data_hub_watcher import testing_overrides
from e2e_support.admin import Admin
from e2e_support.drivers import WatcherDriver
from e2e_support.factory import WatcherFactory
from e2e_support.files import SMALL, write_run
from e2e_support.proxy_helpers import silence_heartbeats
from e2e_support.server import (
    STALE_AFTER_MINUTES,
    SWEEP_GRACE_MINUTES,
    HeartbeatRow,
    ServerView,
)
from e2e_support.waiting import stays_true, wait_until

pytestmark = pytest.mark.e2e


def heartbeat_requests(proxy: FaultProxy) -> list[RecordedRequest]:
    """Every heartbeat the watcher sent through the proxy, faulted ones included."""
    return [r for r in proxy.requests if r.method == "POST" and r.path.endswith("/heartbeat")]


def failed_heartbeats(proxy: FaultProxy) -> int:
    """How many heartbeats the proxy has answered with an error: a fault, or a 426 from the
    server."""
    return sum(
        1
        for r in heartbeat_requests(proxy)
        if r.fault_mode == "status" or (r.upstream_status or 0) >= 400
    )


def wait_for_failed_heartbeat(proxy: FaultProxy, *, after: int = 0, timeout: float = 20.0) -> int:
    """Wait until more than ``after`` heartbeats have been answered with an error, and return
    how many have been so far."""

    def failed() -> int | None:
        count = failed_heartbeats(proxy)
        return count if count > after else None

    return wait_until(
        failed,
        timeout,
        lambda: "\n".join(
            f"{r.path} fault={r.fault_mode} {r.upstream_status}" for r in proxy.requests
        ),
        what="a failed heartbeat",
    )


def total(beats: list[HeartbeatRow], field: str) -> int:
    return sum(getattr(b, field) or 0 for b in beats)


def assert_total(beats: list[HeartbeatRow], field: str, expected: int) -> None:
    """Check that ``field`` adds up to ``expected`` over all heartbeats. The message shows
    each heartbeat's counters as ``(files, runs, errors)``, not the rows."""
    actual = total(beats, field)
    shown = " ".join(
        f"({b.files_uploaded_since_last},{b.runs_reported_since_last},{b.errors_since_last})"
        for b in beats
    )
    assert actual == expected, f"{field} adds up to {actual}, not {expected}; heartbeats: {shown}"


# ---------------------------------------------------------------------------
# registered, watching, stopped
# ---------------------------------------------------------------------------


@pytest.mark.covers(
    "watcher.registered->watching",
    "heartbeat.tick->recorded",
)
def test_first_heartbeat_makes_the_watcher_watching_and_each_tick_is_recorded(
    watcher: WatcherFactory, server: ServerView, current_version: str
) -> None:
    pc = watcher(upload_mode="manual")

    before = server.watcher(pc.watcher_id)
    assert before.status == "registered"
    assert before.last_heartbeat_at is None
    assert server.effective_status(pc.watcher_id) == "registered"
    assert server.heartbeats(pc.watcher_id) == []

    pc.start()
    row = server.wait_for_watcher_status(pc.watcher_id, "watching")
    assert row.last_heartbeat_at is not None
    assert row.watcher_version == current_version
    assert row.status_reason is None
    assert server.effective_status(pc.watcher_id) == "watching"

    # The first heartbeat is sent at startup, the rest on the 2-second tick.
    beats = server.wait_for_heartbeats(pc.watcher_id, count=4)
    assert {b.status for b in beats} == {"watching"}
    assert {b.upload_mode for b in beats} == {"manual"}
    assert all(b.uptime_seconds is not None for b in beats)
    uptimes = [b.uptime_seconds or 0 for b in beats]
    assert uptimes == sorted(uptimes)
    assert uptimes[-1] - uptimes[0] >= 3, uptimes
    # The watcher waits the whole interval between ticks, so no two heartbeats are closer
    # than that (a margin for clock jitter).
    gaps = [(b.timestamp - a.timestamp).total_seconds() for a, b in pairwise(beats)]
    assert all(gap >= 1.5 for gap in gaps), gaps


@pytest.mark.covers("watcher.registered->never_stale")
def test_a_watcher_that_never_checked_in_stays_registered_however_old_its_timestamps(
    watcher: WatcherFactory, server: ServerView
) -> None:
    pc = watcher()

    assert server.effective_status(pc.watcher_id) == "registered"
    # Whatever `last_heartbeat_at` holds, six minutes, a day or nothing, the watcher is still
    # `registered`: the exemption doesn't depend on the timestamp.
    server.age_past_stale(pc.watcher_id)
    assert server.watcher(pc.watcher_id).status == "registered"
    assert server.effective_status(pc.watcher_id) == "registered"
    server.age_heartbeat(pc.watcher_id, 24 * 60)
    assert server.effective_status(pc.watcher_id) == "registered"
    server.clear_heartbeat(pc.watcher_id)
    assert server.effective_status(pc.watcher_id) == "registered"


@pytest.mark.covers(
    "watcher.watching->stopped",
    "watcher.stopped->watching",
)
def test_graceful_stop_shows_stopped_and_starting_again_shows_watching(
    watcher: WatcherFactory, server: ServerView
) -> None:
    pc = watcher()
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")

    assert pc.stop() == 0
    row = server.wait_for_watcher_status(pc.watcher_id, "stopped")
    assert server.heartbeats(pc.watcher_id)[-1].status == "stopped"
    assert row.status_reason is None
    assert server.effective_status(pc.watcher_id) == "stopped"

    stopped_at = server.last_heartbeat_id(pc.watcher_id)
    pc.start()
    row = server.wait_for_watcher_status(pc.watcher_id, "watching")
    fresh = server.wait_for_heartbeats(pc.watcher_id, count=2, after_id=stopped_at)
    assert {b.status for b in fresh} == {"watching"}
    assert row.last_heartbeat_at is not None
    assert server.effective_status(pc.watcher_id) == "watching"


@pytest.mark.covers("watcher.stopped->stays_stopped")
def test_a_cleanly_stopped_watcher_keeps_reading_stopped(
    watcher: WatcherFactory, server: ServerView
) -> None:
    pc = watcher()
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")
    assert pc.stop() == 0
    server.wait_for_watcher_status(pc.watcher_id, "stopped")
    assert server.effective_status(pc.watcher_id) == "stopped"

    # The stopped watcher sends no more heartbeats, so its last one only gets older. Docs
    # ("Watcher status" in concepts): Stopped is "the watcher shut down cleanly and said so
    # in its last heartbeat", and Unresponsive means "the process crashed, the PC is off, or
    # the network is blocking the API". A clean stop is neither of those, however long ago it
    # was: not past the 5-minute mark, not past the 15-minute one that applies to a stop for
    # a restart, and not a day on.
    for minutes in (STALE_AFTER_MINUTES + 1, SWEEP_GRACE_MINUTES + 1, 24 * 60):
        server.age_heartbeat(pc.watcher_id, minutes)
        assert server.effective_status(pc.watcher_id) == "stopped", minutes
    assert server.watcher(pc.watcher_id).status == "stopped"


@pytest.mark.covers("watcher.stopped->stays_stopped_in_list")
def test_the_watcher_list_keeps_a_cleanly_stopped_watcher_stopped(
    watcher: WatcherFactory, server: ServerView
) -> None:
    pc = watcher()
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")
    assert pc.stop() == 0
    server.wait_for_watcher_status(pc.watcher_id, "stopped")

    def stopped_rows() -> list[tuple[str, str]]:
        return [(r["id"], r["status"]) for r in server.list_watchers(status="stopped")]

    assert stopped_rows() == [(pc.watcher_id, "stopped")]
    assert server.list_watchers(status="stale") == []

    # The stopped watcher sends no more heartbeats, so its last one only gets older. The list
    # route's `stale` filter and the status it prints both follow the same rule as the detail
    # route: a stop the watcher announced stays `stopped`, so the watcher is still listed
    # under `stopped`, with that status, and never under `stale`.
    for minutes in (STALE_AFTER_MINUTES + 1, SWEEP_GRACE_MINUTES + 1, 24 * 60):
        server.age_heartbeat(pc.watcher_id, minutes)
        assert stopped_rows() == [(pc.watcher_id, "stopped")], minutes
        assert server.list_watchers(status="stale") == [], minutes


# ---------------------------------------------------------------------------
# stale
# ---------------------------------------------------------------------------


@pytest.mark.covers("watcher.list->stale_filtered")
def test_the_watcher_list_filters_stale_watchers_by_the_age_of_their_heartbeat(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    tmp_path: Path,
) -> None:
    def another(name: str) -> WatcherDriver:
        return watcher(
            instrument_id=f"{instrument_id}-{name}", watch_dir=tmp_path / f"watch-{name}"
        )

    online, silent, stopped, never = (
        watcher(),
        another("silent"),
        another("stopped"),
        another("never"),
    )
    # One PC at a time, with the one that stays online last: under the Windows service there is
    # one service per machine, and starting the next PC takes it over from the one before.

    # One watcher goes quiet without a word. Its heartbeats are refused until a refusal has been
    # seen, so none is on its way when it is killed and its timestamp aged.
    silent.start()
    server.wait_for_watcher_status(silent.watcher_id, "watching")
    silence_heartbeats(proxy, silent.watcher_id)
    silent.kill()
    server.age_past_stale(silent.watcher_id)

    stopped.start()
    server.wait_for_watcher_status(stopped.watcher_id, "watching")
    assert stopped.stop() == 0
    server.wait_for_watcher_status(stopped.watcher_id, "stopped")

    online.start()
    server.wait_for_watcher_status(online.watcher_id, "watching")

    def shown(status: str | None) -> dict[str, str]:
        return {r["id"]: r["status"] for r in server.list_watchers(status=status)}

    # `stale` is computed from the heartbeat: only the quiet watcher is listed, and it says so.
    assert shown("stale") == {silent.watcher_id: "stale"}
    assert shown(None) == {
        online.watcher_id: "watching",
        silent.watcher_id: "stale",
        stopped.watcher_id: "stopped",
        never.watcher_id: "registered",
    }
    # The others are listed under their own status. A watcher that never checked in has no
    # heartbeat to be old, and is not stale.
    assert shown("watching").get(online.watcher_id) == "watching"
    assert shown("stopped") == {stopped.watcher_id: "stopped"}
    assert shown("registered") == {never.watcher_id: "registered"}

    # A watcher that has started but has no heartbeat at all is stale too.
    server.clear_heartbeat(silent.watcher_id)
    assert shown("stale") == {silent.watcher_id: "stale"}
    assert server.effective_status(silent.watcher_id) == "stale"


@pytest.mark.covers(
    "watcher.watching->stale",
    "watcher.stale->watching",
)
def test_a_silent_watcher_reads_stale_and_a_new_heartbeat_makes_it_watching_again(
    watcher: WatcherFactory, server: ServerView, proxy: FaultProxy
) -> None:
    pc = watcher()
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")
    assert server.effective_status(pc.watcher_id) == "watching"

    with proxy.fault("status", path=r"/heartbeat$", status=503):
        # Once one heartbeat has been refused, none that came before is still on its way,
        # so the row can be aged without the watcher overwriting it.
        wait_for_failed_heartbeat(proxy)
        server.age_past_stale(pc.watcher_id)

        assert server.effective_status(pc.watcher_id) == "stale"
        # `stale` is computed on read: the stored status is untouched, and the process is
        # alive and well.
        assert server.watcher(pc.watcher_id).status == "watching"
        assert pc.is_running()

    # The fault is gone: the next heartbeat is stored and the watcher is fresh again.
    server.wait_for_effective_status(pc.watcher_id, "watching")
    row = server.watcher(pc.watcher_id)
    assert row.status == "watching"
    assert row.last_heartbeat_at is not None


# ---------------------------------------------------------------------------
# waiting
# ---------------------------------------------------------------------------


@pytest.mark.covers(
    "watcher.waiting->reason_recorded",
    "watcher.waiting->reason_cleared",
)
def test_waiting_watcher_stores_its_reason_and_clears_it_when_it_resumes(
    watcher: WatcherFactory, server: ServerView, tmp_path: Path
) -> None:
    folder = tmp_path / "instrument-share"
    pc = watcher(watch_dir=folder, create_watch_dir=False)
    assert not pc.watch_dir.exists()

    pc.start()
    row = server.wait_for_watcher_status(pc.watcher_id, "waiting")
    assert row.status_reason == f"watch_directory not found: {pc.watch_dir}"
    assert server.effective_status(pc.watcher_id) == "waiting"
    assert not pc.watch_dir.exists()

    # Every heartbeat of a waiting watcher says so, and carries the same reason on the row.
    waiting = server.wait_for_heartbeats(pc.watcher_id, count=3)
    assert {b.status for b in waiting} == {"waiting"}
    assert server.watcher(pc.watcher_id).status_reason == row.status_reason

    # The reason follows the problem: a file where the folder should be is another one.
    pc.watch_dir.write_text("not a folder")
    row = wait_until(
        lambda: (
            r
            if (r := server.watcher(pc.watcher_id)).status_reason
            == f"watch_directory is not a folder: {pc.watch_dir}"
            else None
        ),
        30,
        lambda: server.dump(pc.watcher_id),
        what="the waiting reason to change",
    )
    assert row.status == "waiting"

    # The folder appears and the watcher starts watching: the reason is cleared.
    pc.watch_dir.unlink()
    pc.watch_dir.mkdir()
    row = server.wait_for_watcher_status(pc.watcher_id, "watching")
    assert row.status_reason is None
    assert server.effective_status(pc.watcher_id) == "watching"
    assert server.heartbeats(pc.watcher_id)[-1].status == "watching"


# ---------------------------------------------------------------------------
# counters
# ---------------------------------------------------------------------------


@pytest.mark.covers("heartbeat.counters->reported_and_reset")
def test_heartbeats_report_what_happened_since_the_last_one_and_start_again_from_zero(
    watcher: WatcherFactory, server: ServerView, instrument_id: str, watch_dir: Path
) -> None:
    # A 6-second tick, so the run is reported and uploaded well inside one interval. With the
    # 2-second tick the file checks and the heartbeats run in step, and a count that arrives
    # while a heartbeat is being sent is lost (see the in-flight test below).
    pc = watcher(overrides={testing_overrides.HEARTBEAT_INTERVAL_ENV_VAR: "6"})
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")

    files = write_run(watch_dir, "RUN001")  # a small and a large file
    for name, content in files.items():
        server.wait_for_uploaded(instrument_id, "RUN001", f"RUN001/{name}", content=content)

    # The next tick reports them ...
    server.wait_until(
        lambda: total(server.heartbeats(pc.watcher_id), "files_uploaded_since_last") == 2,
        30,
        what="a heartbeat to report both uploads",
        watcher_id=pc.watcher_id,
    )
    # ... and the one after it starts from zero. If the counters were not reset after each
    # send, it would repeat the totals.
    after = server.last_heartbeat_id(pc.watcher_id)
    [quiet] = server.wait_for_heartbeats(pc.watcher_id, count=1, after_id=after)
    assert (
        quiet.files_uploaded_since_last,
        quiet.runs_reported_since_last,
        quiet.errors_since_last,
    ) == (0, 0, 0)

    # Everything that happened is in the heartbeats exactly once.
    beats = server.heartbeats(pc.watcher_id)
    assert_total(beats, "files_uploaded_since_last", 2)
    assert_total(beats, "runs_reported_since_last", 1)
    assert_total(beats, "errors_since_last", 0)


@pytest.mark.covers("heartbeat.failed->counts_carried")
def test_counts_from_a_heartbeat_that_failed_are_carried_into_the_next_one(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher()
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")

    with proxy.fault("status", path=r"/heartbeat$", status=503):
        wait_for_failed_heartbeat(proxy)
        # A file is uploaded while no heartbeat can get through ...
        content = write_run(watch_dir, "RUN001", {"small.csv": SMALL})["small.csv"]
        server.wait_for_uploaded(instrument_id, "RUN001", "RUN001/small.csv", content=content)
        # ... and two heartbeats are refused after that, each of which was due to report it.
        wait_for_failed_heartbeat(proxy, after=failed_heartbeats(proxy) + 1)
    after = server.last_heartbeat_id(pc.watcher_id)
    server.wait_for_heartbeats(pc.watcher_id, count=2, after_id=after)

    beats = server.heartbeats(pc.watcher_id)
    # The upload and the run report were not lost with the failed heartbeats: they reach the
    # server with the first heartbeat that gets through.
    assert_total(beats, "files_uploaded_since_last", 1)
    assert_total(beats, "runs_reported_since_last", 1)


@pytest.mark.covers("heartbeat.in_flight->counts_kept")
def test_counts_added_while_a_heartbeat_is_being_sent_are_reported_in_the_next_one(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher()
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")

    def held_heartbeat() -> RecordedRequest:
        """The delayed heartbeat as the proxy logs it now. (A request the proxy returned
        earlier is a snapshot: the proxy fills in the upstream status on a new record.)"""
        return next(r for r in heartbeat_requests(proxy) if r.fault_mode == "delay")

    # Hold one heartbeat for a while. Its payload was built before the hold, so it says
    # nothing happened. What is counted while it is held goes out with a later heartbeat.
    with proxy.fault("delay", path=r"/heartbeat$", delay_seconds=6, count=1):
        proxy.wait_for_request(
            lambda r: r.fault_mode == "delay" and r.path.endswith("/heartbeat"), 15
        )
        stored_before = server.last_heartbeat_id(pc.watcher_id)
        content = write_run(watch_dir, "RUN001", {"small.csv": SMALL})["small.csv"]
        server.wait_for_uploaded(instrument_id, "RUN001", "RUN001/small.csv", content=content)
        # The run was reported and the file uploaded while the heartbeat was still held: the
        # server has not answered it, and has stored nothing new.
        assert held_heartbeat().upstream_status is None
        assert server.last_heartbeat_id(pc.watcher_id) == stored_before
        # The held heartbeat gets through, and two more follow it.
        server.wait_for_heartbeats(pc.watcher_id, count=3, after_id=stored_before)

    beats = server.heartbeats(pc.watcher_id)
    # Every count reaches the server in exactly one heartbeat.
    assert_total(beats, "files_uploaded_since_last", 1)
    assert_total(beats, "runs_reported_since_last", 1)


# ---------------------------------------------------------------------------
# outages
# ---------------------------------------------------------------------------


@pytest.mark.covers(
    "heartbeat.outage->watcher_survives",
    "heartbeat.outage->recovery_event",
    "event.heartbeat_recovered->emitted",
)
def test_watcher_survives_a_server_outage_and_reports_the_gap_when_it_ends(
    watcher: WatcherFactory, server: ServerView, proxy: FaultProxy
) -> None:
    # No queue polling, so no event is queued during the outage. A flush that fails waits
    # between its attempts, which would stretch each tick and leave fewer failed heartbeats in
    # the time the outage lasts.
    pc = watcher(overrides={testing_overrides.UPLOAD_POLL_INTERVAL_ENV_VAR: "600"})
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")
    last_before = server.last_heartbeat_id(pc.watcher_id)

    mark = pc.mark_logs()
    proxy.go_down()
    # The outage lasts until two heartbeats have been refused, however long a refused connection
    # takes (about two seconds on Windows, and no time on Linux). A fixed time would leave fewer
    # failures on Windows. The watcher keeps running and nothing is stored.
    wait_until(
        lambda: pc.log_text(mark).count("Heartbeat failed") >= 2,
        60,
        lambda: server.dump(pc.watcher_id) + "\n" + pc.log_tail(),
        what="two refused heartbeats during the outage",
    )
    assert pc.is_running()
    assert server.last_heartbeat_id(pc.watcher_id) == last_before
    proxy.come_up()

    fresh = server.wait_for_heartbeats(pc.watcher_id, count=2, after_id=last_before)
    assert {b.status for b in fresh} == {"watching"}
    server.wait_for_watcher_status(pc.watcher_id, "watching")
    assert pc.is_running()

    recovered = server.wait_for_event(pc.watcher_id, event_type="error", kind="heartbeat_recovered")
    assert recovered.details["consecutive_failures"] >= 2
    # The gap runs from the first failed heartbeat to the first one that got through: two waits
    # of 2 s at least, in whole seconds (the watcher truncates), so 3 allows for a timer that
    # fires a few milliseconds early.
    assert recovered.details["gap_seconds"] >= 3
    assert "consecutive failure" in recovered.message
    # One event for the whole outage, not one per failed heartbeat.
    assert len(server.events(pc.watcher_id, kind="heartbeat_recovered")) == 1


# ---------------------------------------------------------------------------
# minimum supported version
# ---------------------------------------------------------------------------


@pytest.mark.covers("heartbeat.below_minimum_version->rejected")
def test_server_refuses_every_heartbeat_of_a_watcher_below_the_minimum_version(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    admin: Admin,
    current_version: str,
    bumped_version: str,
) -> None:
    admin.set_release(current_version, min_supported_version=bumped_version).raise_for_status()
    pc = watcher()
    pc.start()

    # The watcher starts and tries again on each tick, and each try is a 426 that stores
    # nothing, so it never leaves `registered`.
    failed = wait_for_failed_heartbeat(proxy)
    wait_for_failed_heartbeat(proxy, after=failed)
    answers = {r.upstream_status for r in heartbeat_requests(proxy)}
    assert answers == {426}, answers
    assert server.heartbeats(pc.watcher_id) == []
    row = server.watcher(pc.watcher_id)
    assert (row.status, row.last_heartbeat_at, row.watcher_version) == ("registered", None, None)
    assert pc.is_running()

    # Lifting the floor lets the next heartbeat in.
    admin.set_release(current_version).raise_for_status()
    row = server.wait_for_watcher_status(pc.watcher_id, "watching")
    assert row.watcher_version == current_version
    assert server.heartbeats(pc.watcher_id)


@pytest.mark.covers("watcher.below_minimum_version->stale")
def test_a_watcher_that_is_refused_with_a_426_reads_stale_while_it_keeps_running(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    admin: Admin,
    current_version: str,
    bumped_version: str,
) -> None:
    pc = watcher()
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")

    admin.set_release(current_version, min_supported_version=bumped_version).raise_for_status()
    wait_for_failed_heartbeat(proxy)
    stored = server.heartbeats(pc.watcher_id)

    # No heartbeat can refresh the timestamp now, so five minutes of silence are one UPDATE
    # away. The watcher reads stale and nothing more is stored, while its process is fine.
    server.age_past_stale(pc.watcher_id)
    assert server.effective_status(pc.watcher_id) == "stale"
    stays_true(
        lambda: (
            server.effective_status(pc.watcher_id) == "stale"
            and pc.is_running()
            and server.heartbeats(pc.watcher_id) == stored
        ),
        5,
        lambda: server.dump(pc.watcher_id),
        what="a stale, running watcher with no new heartbeats",
    )
    assert server.watcher(pc.watcher_id).status == "watching"

    admin.set_release(current_version).raise_for_status()
    server.wait_for_effective_status(pc.watcher_id, "watching")
