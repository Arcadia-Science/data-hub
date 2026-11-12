"""Stopping the watcher: graceful stops, a kill, and the order of what it reports.

A scenario stops the watcher through the driver (``stop``, ``interrupt``, ``kill``) and reads
what the server ends up with: the stored status, the final heartbeat, the ``watcher_stopped``
event. A graceful stop must exit with code 0 and tell the server; a kill tells it nothing, so
the server learns only from the silence. No test sends a signal itself. The two that only make
sense under the CLI driver (Ctrl+C, and a stop before the signal handlers exist) are marked
``platforms("cli")``.
"""

from __future__ import annotations
import time
from pathlib import Path

import pytest

from data_hub_shared.testing_proxy import FaultProxy
from data_hub_watcher import testing_overrides
from e2e_support.drivers import WatcherDriver
from e2e_support.factory import WatcherFactory
from e2e_support.files import SMALL, write_file, write_run
from e2e_support.server import EventRow, ServerView
from e2e_support.waiting import KnownBugStillPresent, known_bug, stays_true, wait_until

pytestmark = pytest.mark.e2e

# The test server stores uploads of 1 KB or more in 1 KB parts (see e2e_support.files), so a
# file of this many parts is 20 KB and takes 20 PUTs.
PART_BYTES = 1024
PARTS = 20
SHORT_PARTS = 3


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def stop_events(server: ServerView, watcher_id: str) -> list[str]:
    """The messages of the ``watcher_stopped`` events the watcher itself sent. The server
    writes events of the same type when it reverts a queue, which have other messages."""
    return [
        e.message for e in server.events(watcher_id, event_type="watcher_stopped") if e.kind is None
    ]


def own_stop_event(server: ServerView, watcher_id: str) -> EventRow:
    """Wait for the ``watcher_stopped`` event the watcher itself sent, not the one of the same
    type that the server writes when it reverts a queue (that one has a ``kind``)."""

    def found() -> EventRow | None:
        events = server.events(watcher_id, event_type="watcher_stopped")
        return next((e for e in events if e.kind is None), None)

    return server.wait_until(
        found, 30, what="the watcher's own watcher_stopped event", watcher_id=watcher_id
    )


def start_watching(pc: WatcherDriver, server: ServerView) -> None:
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")


def part_puts(proxy: FaultProxy) -> list[str]:
    """The PUTs the watcher made to the S3 stand-in, one per part of a multipart upload."""
    return [r.path for r in proxy.requests if r.method == "PUT" and "/api/local-s3/" in r.path]


def pending_uploads(pc: WatcherDriver) -> list[str]:
    """The files the watcher's state database says it still has to upload."""
    rows = pc.state_query("SELECT relative_path FROM pending_uploads ORDER BY relative_path")
    return [str(row[0]) for row in rows]


# ---------------------------------------------------------------------------
# Graceful stops
# ---------------------------------------------------------------------------


@pytest.mark.covers(
    "process.stop->clean_exit",
    "event.watcher_started->emitted",
    "event.watcher_stopped->emitted",
)
def test_a_graceful_stop_exits_zero_after_telling_the_server(
    watcher: WatcherFactory, server: ServerView
) -> None:
    pc = watcher()
    start_watching(pc, server)

    assert pc.stop() == 0

    assert not pc.is_running()
    row = server.wait_for_watcher_status(pc.watcher_id, "stopped")
    assert row.status_reason is None
    assert server.heartbeats(pc.watcher_id)[-1].status == "stopped"
    assert server.effective_status(pc.watcher_id) == "stopped"
    assert stop_events(server, pc.watcher_id) == [pc.operator_stop_message]
    # The start is reported too, and before the stop.
    summary = server.event_summary(pc.watcher_id)
    assert summary.index("watcher_started") < summary.index("watcher_stopped")


@pytest.mark.platforms("cli")
@pytest.mark.covers("process.interrupt->clean_exit", "event.watcher_stopped->emitted")
def test_an_interrupt_stops_the_watcher_the_same_way(
    watcher: WatcherFactory, server: ServerView
) -> None:
    pc = watcher()
    start_watching(pc, server)

    pc.interrupt()

    assert pc.wait_exit(30) == 0
    server.wait_for_watcher_status(pc.watcher_id, "stopped")
    assert server.heartbeats(pc.watcher_id)[-1].status == "stopped"
    assert stop_events(server, pc.watcher_id) == [pc.operator_stop_message]


@pytest.mark.covers("process.stop->waiting_mode_clean_exit", "event.watcher_stopped->emitted")
def test_stopping_a_watcher_that_waits_for_its_folder(
    watcher: WatcherFactory, server: ServerView, watch_dir: Path
) -> None:
    pc = watcher(watch_dir=watch_dir / "not-there-yet", create_watch_dir=False)
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "waiting")

    assert pc.stop() == 0

    row = server.wait_for_watcher_status(pc.watcher_id, "stopped")
    assert row.status_reason is None
    assert server.heartbeats(pc.watcher_id)[-1].status == "stopped"
    assert stop_events(server, pc.watcher_id) == [pc.operator_stop_message]


@pytest.mark.covers("process.stop->upload_deferred", "event.file_uploaded->emitted")
def test_a_stop_during_a_long_upload_defers_it_to_the_next_start(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    watch_dir: Path,
    instrument_id: str,
) -> None:
    pc = watcher(upload_parallelism=1)
    start_watching(pc, server)
    # Every part takes 2 s to arrive, so a file of 20 parts takes 40 s unless the stop cuts it
    # short.
    proxy.add_fault("delay", path=r"/api/local-s3/", method="PUT", delay_seconds=2)
    contents = write_run(
        watch_dir, "RUN001", {"first.csv": PARTS * PART_BYTES, "second.csv": PARTS * PART_BYTES}
    )
    wait_until(
        lambda: part_puts(proxy),
        60,
        lambda: server.dump(pc.watcher_id, instrument_id),
        what="the first part to be on its way",
    )

    pc.request_stop()
    assert pc.wait_exit(25) == 0

    # The stop cut the upload short: some of the first file went out, and none of the files is
    # done.
    assert 0 < len(part_puts(proxy)) < PARTS
    assert not [f for f in server.files(instrument_id, "RUN001") if f.status == "uploaded"]
    # The unfinished file is still the watcher's to upload. The second one may be pending too
    # (when both files were found stable in the same pass), or not yet handed to the uploader,
    # in which case the next start's scan finds it.
    assert "RUN001/first.csv" in pending_uploads(pc)
    server.wait_for_watcher_status(pc.watcher_id, "stopped")
    assert stop_events(server, pc.watcher_id) == [pc.operator_stop_message]

    # The next start uploads both.
    proxy.clear_faults()
    pc.start()
    for name, data in contents.items():
        server.wait_for_uploaded(
            instrument_id, "RUN001", f"RUN001/{name}", content=data, timeout=90
        )
    wait_until(
        lambda: pending_uploads(pc) == [],
        30,
        lambda: server.dump(pc.watcher_id, instrument_id),
        what="the pending uploads to be cleared",
    )


@pytest.mark.covers("process.stop->upload_deferred")
def test_a_stop_while_pending_uploads_are_retried_does_not_use_up_their_attempts(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    watch_dir: Path,
    instrument_id: str,
) -> None:
    pc = watcher(upload_parallelism=1)
    start_watching(pc, server)
    # No upload URL can be had, so both files of the run are left pending.
    proxy.add_fault("status", path=r"/request-upload-url$", status=503)
    contents = write_run(
        watch_dir, "RUN001", {"a.csv": PARTS * PART_BYTES, "b.csv": PARTS * PART_BYTES}
    )
    server.wait_for_events(pc.watcher_id, count=2, event_type="upload_failed")
    wait_until(
        lambda: pending_uploads(pc) == ["RUN001/a.csv", "RUN001/b.csv"],
        30,
        lambda: server.dump(pc.watcher_id, instrument_id),
        what="both files to be pending",
    )
    assert pc.stop() == 0

    # The next start retries them one at a time, slowly, and is stopped during the first.
    proxy.clear_faults()
    proxy.clear_log()
    proxy.add_fault("delay", path=r"/api/local-s3/", method="PUT", delay_seconds=2)
    pc.start()
    wait_until(
        lambda: part_puts(proxy),
        60,
        lambda: server.dump(pc.watcher_id, instrument_id),
        what="the retry of the first file to be on its way",
    )
    pc.request_stop()
    assert pc.wait_exit(25) == 0

    assert 0 < len(part_puts(proxy)) < PARTS
    # Both are still pending, and being cut off did not count against either one's three
    # starts.
    rows = pc.state_query("SELECT relative_path, attempts FROM pending_uploads ORDER BY 1")
    assert rows == [("RUN001/a.csv", 0), ("RUN001/b.csv", 0)]
    assert server.events(pc.watcher_id, kind="upload_retries_exhausted") == []

    # Then, with nothing in the way, both are uploaded.
    proxy.clear_faults()
    pc.start()
    for name, data in contents.items():
        server.wait_for_uploaded(
            instrument_id, "RUN001", f"RUN001/{name}", content=data, timeout=90
        )
    wait_until(
        lambda: pending_uploads(pc) == [],
        30,
        lambda: server.dump(pc.watcher_id, instrument_id),
        what="the pending uploads to be cleared",
    )


# ---------------------------------------------------------------------------
# A kill
# ---------------------------------------------------------------------------


@pytest.mark.covers("process.kill->stale")
def test_a_killed_watcher_sends_nothing_and_the_server_calls_it_stale(
    watcher: WatcherFactory, server: ServerView
) -> None:
    pc = watcher()
    start_watching(pc, server)
    server.wait_for_heartbeats(pc.watcher_id, count=2)

    pc.kill()

    assert not pc.is_running()
    # No `stopped` heartbeat and no stop event: as far as the server knows it is still there.
    stays_true(
        lambda: (
            server.watcher(pc.watcher_id).status == "watching"
            and stop_events(server, pc.watcher_id) == []
        ),
        3,
        lambda: server.dump(pc.watcher_id),
        what="the watcher to still read as watching after a kill",
    )
    assert server.heartbeats(pc.watcher_id)[-1].status == "watching"
    assert server.effective_status(pc.watcher_id) == "watching"

    # Once its last heartbeat is five minutes old, the server says what happened.
    server.age_past_stale(pc.watcher_id)
    assert server.effective_status(pc.watcher_id) == "stale"
    assert server.watcher(pc.watcher_id).status == "watching"


@pytest.mark.covers(
    "process.kill->restart_resumes",
    "event.watcher_started->emitted",
    "event.run_reported->emitted",
    "event.file_uploaded->emitted",
)
def test_a_watcher_started_again_after_a_kill_resumes_without_reporting_twice(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    watch_dir: Path,
    instrument_id: str,
) -> None:
    pc = watcher()
    start_watching(pc, server)
    first = write_run(watch_dir, "RUN001", {"a.csv": SMALL})
    server.wait_for_uploaded(instrument_id, "RUN001", "RUN001/a.csv", content=first["a.csv"])
    # Wait for the watcher's own record of the upload, which comes after the server's.
    wait_until(
        lambda: (
            pending_uploads(pc) == []
            and pc.state_query("SELECT count(*) FROM uploaded_files") == [(1,)]
        ),
        30,
        lambda: server.dump(pc.watcher_id, instrument_id),
        what="the watcher to record the upload",
    )
    server.wait_for_event(pc.watcher_id, event_type="file_uploaded")

    pc.kill()
    proxy.clear_log()
    last_heartbeat = server.last_heartbeat_id(pc.watcher_id)
    pc.start()

    # Back to watching: a heartbeat of the new process, and a second start event.
    beats = server.wait_for_heartbeats(pc.watcher_id, count=3, after_id=last_heartbeat)
    assert {b.status for b in beats} == {"watching"}
    assert len(server.wait_for_events(pc.watcher_id, count=2, event_type="watcher_started")) == 2
    assert server.watcher(pc.watcher_id).status == "watching"

    # The run and its file were not reported or uploaded again.
    assert [
        (r.method, r.path)
        for r in proxy.requests
        if "/runs" in r.path or r.path.endswith("/request-upload-url")
    ] == []
    assert len(server.runs(instrument_id)) == 1
    assert len(server.files(instrument_id, "RUN001")) == 1
    assert len(server.events(pc.watcher_id, event_type="run_reported")) == 1
    assert len(server.events(pc.watcher_id, event_type="file_uploaded")) == 1

    # And it keeps working, and still knows the run: a new file in it is added to the run that
    # exists, not reported as a new one.
    second = write_file(watch_dir / "RUN001" / "b.csv", SMALL)
    server.wait_for_uploaded(instrument_id, "RUN001", "RUN001/b.csv", content=second)
    run_requests = [(r.method, r.path) for r in proxy.requests if "/runs" in r.path]
    assert ("PATCH", f"/api/v1/instruments/{instrument_id}/runs/RUN001") in run_requests
    assert not [m for m, path in run_requests if m == "POST" and path.endswith("/runs")]
    assert len(server.events(pc.watcher_id, event_type="run_reported")) == 1


# ---------------------------------------------------------------------------
# Known bugs: the intended behavior, until they are fixed
# ---------------------------------------------------------------------------


@pytest.mark.xfail(
    strict=True,
    raises=KnownBugStillPresent,
    reason=(
        "ENG-2126: `stop_runtime` joins the file monitor for up to "
        "5 s before it stops the upload worker, so an auto upload on the monitor's thread "
        "keeps starting parts, and the next file, after a stop"
    ),
)
@pytest.mark.covers("process.stop->no_new_uploads_after_stop")
def test_a_stop_starts_no_new_part_or_file_of_an_auto_upload(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    watch_dir: Path,
    instrument_id: str,
) -> None:
    pc = watcher(upload_parallelism=1)
    start_watching(pc, server)
    # Each part takes a second to arrive. A file of three parts is short enough that the second
    # file would start well inside the five seconds the stop spends waiting for the monitor, yet
    # long enough that the stop arrives while the first is on its way.
    proxy.add_fault("delay", path=r"/api/local-s3/", method="PUT", delay_seconds=1)
    write_run(
        watch_dir,
        "RUN001",
        {"first.csv": SHORT_PARTS * PART_BYTES, "second.csv": SHORT_PARTS * PART_BYTES},
    )
    wait_until(
        lambda: part_puts(proxy),
        60,
        lambda: server.dump(pc.watcher_id, instrument_id),
        what="the first part to be on its way",
    )

    pc.request_stop()
    # Taken after the request returns: under the service `request_stop` spends a second or two in
    # a command first, and a part that arrives meanwhile is not one the stop failed to prevent.
    stopped_at = time.time()
    assert pc.wait_exit(25) == 0

    # The proxy logs a part when it arrives, so a part logged after the stop (with some room for
    # the signal to be handled) is one that was started after it.
    started_after_stop = [
        r.path for r in proxy.requests if r.method == "PUT" and r.timestamp > stopped_at + 0.5
    ]
    with known_bug():
        assert started_after_stop == [], (
            f"{len(started_after_stop)} part(s) were started more than half a second after "
            "the stop was requested"
        )


@pytest.mark.xfail(
    strict=True,
    raises=KnownBugStillPresent,
    reason=(
        "ENG-2116: the final `stopped` heartbeat reaches the "
        "server before the `watcher_stopped` event"
    ),
)
@pytest.mark.covers("process.stop->event_before_stopped_heartbeat")
def test_the_stop_event_reaches_the_server_before_the_stopped_heartbeat(
    watcher: WatcherFactory, server: ServerView
) -> None:
    # One heartbeat at start, then none for a minute. A tick that is under way when the stop comes
    # sends the queued stop event with its own flush, ahead of the final heartbeat, and hides the
    # order the stop itself uses. Stopping the service takes about as long as the usual 2-second
    # interval, so with that interval a tick usually is under way.
    pc = watcher(overrides={testing_overrides.HEARTBEAT_INTERVAL_ENV_VAR: "60"})
    start_watching(pc, server)

    assert pc.stop() == 0

    event = own_stop_event(server, pc.watcher_id)
    final = server.heartbeats(pc.watcher_id)[-1]
    assert final.status == "stopped"
    with known_bug():
        assert event.created_at <= final.created_at, (
            f"the watcher_stopped event was stored at {event.created_at}, after the stopped "
            f"heartbeat at {final.created_at}"
        )


@pytest.mark.xfail(
    strict=True,
    raises=KnownBugStillPresent,
    reason=(
        "ENG-2127: a stop against a server that has stopped "
        "answering waits for the stuck heartbeat, the final heartbeat and the event flush, "
        "each up to the client's read timeout, and takes up to about 95 s"
    ),
)
@pytest.mark.covers("process.stop->bounded_when_server_hangs")
def test_a_stop_completes_within_thirty_seconds_even_if_the_server_stops_answering(
    watcher: WatcherFactory, server: ServerView, proxy: FaultProxy
) -> None:
    pc = watcher()
    start_watching(pc, server)
    # Every heartbeat and event request is held for longer than the client waits for an answer
    # (30 s), so each one the watcher sends is stuck until it gives up on it.
    proxy.add_fault("delay", path=r"/(heartbeat|events)$", method="POST", delay_seconds=45)
    wait_until(
        lambda: any(r.fault_mode == "delay" for r in proxy.requests),
        30,
        pc.log_tail,
        what="a heartbeat to be held up",
    )
    assert pc.is_running()

    pc.request_stop()

    # PROPOSED bound: the process is gone within about 30 s. A test that outlasts it leaves the
    # watcher to the driver, which stops it for good when the test ends.
    with known_bug():
        pc.wait_exit(30)


@pytest.mark.xfail(
    strict=True,
    raises=KnownBugStillPresent,
    reason=(
        "ENG-2118: a stop that arrives while the watcher is still starting "
        "(before its start-up scan ends) kills it with no stopped heartbeat and no stop event"
    ),
)
@pytest.mark.platforms("cli")  # The Windows service already stops cleanly while it starts.
@pytest.mark.covers("process.stop->clean_stop_during_scan")
def test_a_stop_during_start_up_still_ends_with_a_clean_stop(
    watcher: WatcherFactory, server: ServerView, proxy: FaultProxy
) -> None:
    pc = watcher()
    # The first heartbeat is sent before the start-up scan, and a slow server holds it up.
    proxy.add_fault("delay", path=r"/heartbeat$", method="POST", delay_seconds=8, count=1)

    pc.start(wait_ready=False)
    wait_until(
        lambda: any(r.fault_mode == "delay" for r in proxy.requests),
        30,
        pc.log_tail,
        what="the watcher to be held up in its first heartbeat",
    )
    assert pc.is_running()
    pc.request_stop()

    with known_bug():
        assert pc.wait_exit(30) == 0
        server.wait_for_watcher_status(pc.watcher_id, "stopped")
        own_stop_event(server, pc.watcher_id)
