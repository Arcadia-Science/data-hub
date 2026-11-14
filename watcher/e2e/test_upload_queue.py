"""The server's upload queue end to end: "Request upload", the watcher's queue polls, the
watcher giving up on a file, and the server taking files out of the queue.

A manual-mode watcher reports files and leaves them ``detected``. An admin asks for some of
them with ``request-upload`` (the "Request upload" button), the files become
``upload_requested``, and the watcher finds them on its next poll of
``GET /watchers/<id>/upload-queue`` and uploads them. An auto-mode watcher polls the same queue.

Most scenarios start by *holding* the queue: a 503 on the watcher's queue poll, so a requested
file stays queued while the test looks at it, and releasing the hold lets the next poll take it.
``ServerView.upload_queue`` reads the real route directly, not through the proxy, so it still
shows what the watcher would get. Polls run every second here (the suite's default is 2 s) to
keep the three-poll scenarios short.
"""

from __future__ import annotations
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import NamedTuple

import pytest

from data_hub_shared.testing_proxy import FaultProxy, FaultRule, RecordedRequest
from data_hub_watcher import testing_overrides
from e2e_support.admin import Admin
from e2e_support.drivers import WatcherDriver
from e2e_support.factory import WatcherFactory
from e2e_support.files import LARGE, SMALL, make_readable, write_file, write_run
from e2e_support.proxy_helpers import silence_heartbeats
from e2e_support.server import FileRow, ServerView
from e2e_support.waiting import stays_true, wait_until

pytestmark = pytest.mark.e2e

RUN = "RUN001"

QUEUE = r"/upload-queue$"
PRESIGN = r"/request-upload-url$"

POLL_EVERY_SECOND: Mapping[str, str | None] = {testing_overrides.UPLOAD_POLL_INTERVAL_ENV_VAR: "1"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class Detected(NamedTuple):
    """A file the watcher reported: the bytes written to disk and the server's row."""

    content: bytes
    row: FileRow


def _route(request: RecordedRequest) -> str:
    return request.path.split("?", 1)[0]


def calls(proxy: FaultProxy, method: str, suffix: str) -> list[RecordedRequest]:
    return [r for r in proxy.requests if r.method == method and _route(r).endswith(suffix)]


def s3_puts(proxy: FaultProxy) -> list[RecordedRequest]:
    return [r for r in proxy.requests if r.method == "PUT" and r.path.startswith("/api/local-s3/")]


def pending(pc: WatcherDriver) -> list[tuple[str, str, int]]:
    rows = pc.state_query(
        "SELECT relative_path, run_id, attempts FROM pending_uploads ORDER BY rowid"
    )
    return [(str(path), str(run), int(attempts)) for path, run, attempts in rows]


def recorded_uploads(pc: WatcherDriver) -> list[str]:
    rows = pc.state_query("SELECT relative_path FROM uploaded_files ORDER BY relative_path")
    return [str(row[0]) for row in rows]


def heartbeat_total(server: ServerView, watcher_id: str, counter: str) -> int:
    return sum(getattr(beat, counter) or 0 for beat in server.heartbeats(watcher_id))


def hold_queue(proxy: FaultProxy) -> FaultRule:
    """Make the watcher's queue poll fail, so queued files stay queued until the hold is lifted."""
    return proxy.add_fault("status", path=QUEUE, method="GET", status=503)


def manual_watcher(
    watcher: WatcherFactory,
    server: ServerView,
    *,
    overrides: Mapping[str, str | None] | None = None,
    upload_parallelism: int = 4,
) -> WatcherDriver:
    """A started manual-mode watcher that polls the queue every second. ``overrides`` change the
    suite's other timers for it, and ``upload_parallelism`` the budget of simultaneous PUTs."""
    pc = watcher(
        upload_mode="manual",
        upload_parallelism=upload_parallelism,
        overrides={**POLL_EVERY_SECOND, **(overrides or {})},
    )
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")
    return pc


def last_file_patch(proxy: FaultProxy, file_id: int) -> int:
    """The position in the proxy's log of the newest ``PATCH /files/<id>`` the watcher sent,
    which is the request that cancels a queued file."""
    return max(
        i
        for i, r in enumerate(proxy.requests)
        if r.method == "PATCH" and _route(r).endswith(f"/files/{file_id}")
    )


def wait_for_good_poll_after(proxy: FaultProxy, mark: int, *, timeout: float = 20) -> None:
    """Wait until the watcher has read the queue, and the server has answered, in a poll that
    came after request number ``mark`` of the proxy's log (``len(proxy.requests)`` then).

    The watcher forgets what it knows about a queued file when a poll no longer lists it, so this
    is how a scenario knows that an earlier cancellation has been forgotten.
    """

    def polled() -> bool:
        return any(
            r.method == "GET"
            and _route(r).endswith("/upload-queue")
            and r.fault_mode is None
            and r.upstream_status == 200
            for r in proxy.requests[mark:]
        )

    wait_until(polled, timeout, what="a queue poll that the server answered")


def detect_run(
    server: ServerView, instrument_id: str, watch_dir: Path, run_id: str, files: Mapping[str, int]
) -> dict[str, Detected]:
    """Write a run folder and wait until the server lists every file as ``detected``."""
    contents = write_run(watch_dir, run_id, files)
    return {
        name: Detected(
            contents[name],
            server.wait_for_file(instrument_id, run_id, f"{run_id}/{name}", status="detected"),
        )
        for name in files
    }


def queue_ids(server: ServerView, pc: WatcherDriver) -> set[int]:
    return {int(entry["id"]) for entry in server.upload_queue(pc.watcher_id)}


def statuses(server: ServerView, instrument_id: str, run_id: str) -> dict[str, str]:
    """``{file name: status}`` of the run's files, dismissed ones left out."""
    return {f.filename: f.status for f in server.files(instrument_id, run_id)}


def wait_for_cancellation(
    server: ServerView, pc: WatcherDriver, *, count: int = 1, timeout: float = 30
) -> list[dict[str, object]]:
    events = server.wait_for_events(
        pc.watcher_id,
        event_type="error",
        kind="upload_request_cancelled",
        count=count,
        timeout=timeout,
    )
    return [e.details for e in events]


# ---------------------------------------------------------------------------
# Asking for uploads
# ---------------------------------------------------------------------------


@pytest.mark.covers("queue.manual_mode->files_detected", "event.run_reported->emitted")
def test_manual_mode_reports_files_and_uploads_nothing(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = manual_watcher(watcher, server)

    files = detect_run(server, instrument_id, watch_dir, RUN, {"a.csv": SMALL, "b.csv": LARGE})
    assert {n: f.row.status for n, f in files.items()} == {"a.csv": "detected", "b.csv": "detected"}
    assert server.run_status(instrument_id, RUN) == "pending"
    reported = server.wait_for_event(pc.watcher_id, event_type="run_reported")
    assert reported.details["run_id"] == RUN

    # The watcher keeps polling the queue, which is empty, and uploads nothing on its own.
    stays_true(
        lambda: (
            not s3_puts(proxy)
            and not calls(proxy, "POST", "/request-upload-url")
            and set(statuses(server, instrument_id, RUN).values()) == {"detected"}
        ),
        4,
        lambda: server.dump(pc.watcher_id, instrument_id),
        what="manual mode to leave the files detected",
    )
    assert len(calls(proxy, "GET", "/upload-queue")) >= 3
    assert server.upload_queue(pc.watcher_id) == []
    assert not server.object_exists(instrument_id, RUN, "a.csv")
    assert pending(pc) == []  # manual mode records nothing to retry


@pytest.mark.covers(
    "queue.detected->upload_requested",
    "queue.upload_requested->uploaded",
    "event.file_uploaded->emitted",
)
def test_requested_files_are_queued_and_the_next_poll_uploads_them(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    admin: Admin,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = manual_watcher(watcher, server)
    files = detect_run(
        server, instrument_id, watch_dir, RUN, {"a.csv": SMALL, "b.csv": LARGE, "c.csv": SMALL}
    )
    a, b = files["a.csv"], files["b.csv"]
    hold = hold_queue(proxy)

    result = admin.request_upload(instrument_id, RUN, [a.row.id, b.row.id]).raise_for_status()
    assert result.body["files_queued"] == 2

    # The chosen files are `upload_requested` with a request time and are in the queue. The
    # one that wasn't chosen is untouched.
    for chosen in (a, b):
        queued = server.file(instrument_id, RUN, chosen.row.relative_path or "")
        assert queued is not None
        assert queued.status == "upload_requested" and queued.upload_requested_at is not None
    assert queue_ids(server, pc) == {a.row.id, b.row.id}
    assert statuses(server, instrument_id, RUN)["c.csv"] == "detected"
    assert s3_puts(proxy) == []

    # Lift the hold: the next poll uploads both, and they leave the queue.
    proxy.remove_fault(hold)
    server.wait_for_uploaded(instrument_id, RUN, f"{RUN}/a.csv", content=a.content)
    server.wait_for_uploaded(instrument_id, RUN, f"{RUN}/b.csv", content=b.content)
    wait_until(
        lambda: queue_ids(server, pc) == set(),
        20,
        lambda: server.dump(pc.watcher_id),
        what="the queue to empty",
    )
    assert statuses(server, instrument_id, RUN)["c.csv"] == "detected"
    assert not server.object_exists(instrument_id, RUN, "c.csv")
    assert server.run_status(instrument_id, RUN) == "pending"  # c is still waiting
    uploaded = {
        e.details["s3_key"]: e.details["part_count"]
        for e in server.wait_for_events(pc.watcher_id, event_type="file_uploaded", count=2)
    }
    assert uploaded == {
        f"{instrument_id}/{RUN}/a.csv": 1,
        f"{instrument_id}/{RUN}/b.csv": 5,
    }


@pytest.mark.covers("queue.detected->upload_requested_all")
def test_request_upload_all_queues_every_detected_file_of_the_run(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    admin: Admin,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = manual_watcher(watcher, server)
    first = detect_run(server, instrument_id, watch_dir, RUN, {"a.csv": SMALL, "b.csv": LARGE})
    other = detect_run(server, instrument_id, watch_dir, "RUN002", {"c.csv": SMALL})
    hold = hold_queue(proxy)

    result = admin.request_upload_all(instrument_id, RUN).raise_for_status()
    assert result.body["files_queued"] == 2

    assert set(statuses(server, instrument_id, RUN).values()) == {"upload_requested"}
    assert queue_ids(server, pc) == {f.row.id for f in first.values()}
    # Another run's file is not part of this run's "all".
    assert statuses(server, instrument_id, "RUN002") == {"c.csv": "detected"}

    proxy.remove_fault(hold)
    for name, detected in first.items():
        server.wait_for_uploaded(instrument_id, RUN, f"{RUN}/{name}", content=detected.content)
    assert not server.object_exists(instrument_id, "RUN002", "c.csv")
    assert other["c.csv"].row.id not in queue_ids(server, pc)


@pytest.mark.covers("queue.batch->parallel_within_budget")
def test_queued_files_are_uploaded_in_parallel_but_never_more_than_the_budget(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    admin: Admin,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    budget = 2
    hold = 1.0
    pc = manual_watcher(watcher, server, upload_parallelism=budget)
    # Four files of different sizes, so each has bytes of its own.
    files = detect_run(
        server, instrument_id, watch_dir, RUN, {f"f{n}.csv": SMALL + n for n in range(4)}
    )
    # Every PUT takes at least `hold` seconds in the proxy, so PUTs that start closer together
    # than that overlap, and a PUT can't start while `budget` others still run.
    proxy.add_fault("delay", path=r"^/api/local-s3/", method="PUT", delay_seconds=hold)
    queue_hold = hold_queue(proxy)
    admin.request_upload_all(instrument_id, RUN).raise_for_status()
    assert queue_ids(server, pc) == {f.row.id for f in files.values()}

    # The next poll lists all four and takes them together.
    proxy.remove_fault(queue_hold)
    for name, detected in files.items():
        server.wait_for_uploaded(
            instrument_id, RUN, f"{RUN}/{name}", content=detected.content, timeout=60
        )

    puts = s3_puts(proxy)
    assert len(puts) == 4
    starts = sorted(r.timestamp for r in puts)
    slack = 0.1
    # No PUT starts less than `hold` after the one `budget` places before it, because that one
    # is still running.
    for earlier, later in zip(starts, starts[budget:], strict=False):
        assert later - earlier >= hold - slack, starts
    # And files really are uploaded at the same time: one PUT starts while another, to a different
    # object, is still held.
    assert any(
        a.timestamp <= b.timestamp < a.timestamp + hold - slack and _route(a) != _route(b)
        for a in puts
        for b in puts
    ), starts


@pytest.mark.covers("queue.in_flight_and_requested->uploaded_once")
def test_a_file_that_is_requested_while_its_own_upload_runs_is_uploaded_only_once(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    admin: Admin,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher(upload_mode="auto", overrides=POLL_EVERY_SECOND)
    # Each part is held a second, so the upload of the large file takes a few seconds.
    proxy.add_fault("delay", path=r"^/api/local-s3/", method="PUT", delay_seconds=1.0)
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")

    content = write_run(watch_dir, RUN, {"a.csv": LARGE})["a.csv"]
    # The automatic upload is under way: the first part is held in the proxy, and the file is
    # still `detected` on the server. An admin asks for it now.
    proxy.wait_for_request(lambda r: r.method == "PUT" and "partNumber=" in r.path, timeout=30)
    row = server.wait_for_file(instrument_id, RUN, f"{RUN}/a.csv", status="detected")
    admin.request_upload(instrument_id, RUN, [row.id]).raise_for_status()

    # The queue poll finds the file while the first upload still has it. It does not start a
    # second upload of the same file, which would make the server abort the first: it waits, and
    # finds the file done.
    server.wait_for_uploaded(instrument_id, RUN, f"{RUN}/a.csv", content=content, timeout=60)
    server.wait_for_event(pc.watcher_id, event_type="file_uploaded")
    wait_until(
        lambda: queue_ids(server, pc) == set() and pending(pc) == [],
        20,
        lambda: server.dump(pc.watcher_id, instrument_id),
        what="the queue and the pending uploads to be empty",
    )
    assert len(calls(proxy, "POST", "/request-upload-url")) == 1
    assert len(s3_puts(proxy)) == 5
    assert len(calls(proxy, "POST", "/multipart-upload/complete")) == 1
    assert calls(proxy, "DELETE", "/multipart-upload") == []
    assert len(server.events(pc.watcher_id, event_type="file_uploaded")) == 1
    assert server.events(pc.watcher_id, kind="upload_request_cancelled") == []
    assert server.events(pc.watcher_id, event_type="upload_failed") == []
    assert recorded_uploads(pc) == [f"{RUN}/a.csv"]


@pytest.mark.covers("queue.auto_mode->requested_file_uploaded")
def test_auto_mode_watcher_uploads_a_file_requested_after_its_own_attempt_gave_up(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    admin: Admin,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher(upload_mode="auto", overrides=POLL_EVERY_SECOND)
    refusal = proxy.add_fault("status", path=PRESIGN, method="POST", status=503)
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")

    content = write_run(watch_dir, RUN, {"a.csv": SMALL})["a.csv"]
    server.wait_for_event(pc.watcher_id, event_type="upload_failed")
    row = server.wait_for_file(instrument_id, RUN, f"{RUN}/a.csv", status="detected")
    assert pending(pc) == [(f"{RUN}/a.csv", RUN, 0)]

    # The automatic upload failed. Asking for the file from the run page queues it, and the
    # auto-mode watcher uploads it from its queue poll.
    proxy.remove_fault(refusal)
    admin.request_upload(instrument_id, RUN, [row.id]).raise_for_status()
    server.wait_for_uploaded(instrument_id, RUN, f"{RUN}/a.csv", content=content)
    wait_until(
        lambda: pending(pc) == [],
        20,
        lambda: str(pending(pc)),
        what="the pending row to clear",
    )
    assert recorded_uploads(pc) == [f"{RUN}/a.csv"]
    assert len(s3_puts(proxy)) == 1


@pytest.mark.covers("queue.request->watcher_offline_refused")
def test_request_upload_is_refused_while_the_watcher_is_offline(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    admin: Admin,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = manual_watcher(watcher, server)
    files = detect_run(server, instrument_id, watch_dir, RUN, {"a.csv": SMALL, "b.csv": SMALL})
    a, b = files["a.csv"], files["b.csv"]

    def assert_refused(file: Detected) -> None:
        for refused in (
            admin.request_upload(instrument_id, RUN, [file.row.id]),
            admin.request_upload_all(instrument_id, RUN),
        ):
            assert refused.status_code == 409 and refused.error_code == "WATCHER_OFFLINE", refused
        untouched = server.file(instrument_id, RUN, file.row.relative_path or "")
        assert untouched is not None and untouched.status == "detected"
        assert untouched.upload_requested_at is None

    # The process dies, so its last heartbeat ages. The stored status is still `watching`, but
    # once the heartbeat is over five minutes old nobody is there to take an upload.
    refusal = silence_heartbeats(proxy)
    pc.kill()
    server.age_past_stale(pc.watcher_id)
    assert server.effective_status(pc.watcher_id) == "stale"
    assert_refused(a)

    # The next heartbeat brings the watcher back, and the same request goes through.
    proxy.remove_fault(refusal)
    before = server.last_heartbeat_id(pc.watcher_id)
    pc.start()
    server.wait_for_heartbeats(pc.watcher_id, after_id=before)
    server.wait_for_effective_status(pc.watcher_id, "watching")
    admin.request_upload(instrument_id, RUN, [a.row.id]).raise_for_status()
    server.wait_for_uploaded(instrument_id, RUN, f"{RUN}/a.csv", content=a.content)

    # A watcher that stopped is no more online than a dead one, however fresh its heartbeat.
    assert pc.stop() == 0
    server.wait_for_watcher_status(pc.watcher_id, "stopped")
    assert_refused(b)


@pytest.mark.covers("queue.deleted_run->request_refused")
def test_request_upload_for_a_deleted_run_is_refused(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = manual_watcher(watcher, server)
    a = detect_run(server, instrument_id, watch_dir, RUN, {"a.csv": SMALL})["a.csv"]
    admin.delete_run(instrument_id, RUN).raise_for_status()

    for refused in (
        admin.request_upload(instrument_id, RUN, [a.row.id]),
        admin.request_upload_all(instrument_id, RUN),
    ):
        assert refused.status_code == 409 and refused.error_code == "CONFLICT", refused
    row = server.file(instrument_id, RUN, f"{RUN}/a.csv")
    assert row is not None and row.status == "detected" and row.upload_requested_at is None
    assert server.upload_queue(pc.watcher_id) == []

    # The run is only deleted, not lost: restoring it makes the request possible again.
    admin.restore_run(instrument_id, RUN).raise_for_status()
    admin.request_upload(instrument_id, RUN, [a.row.id]).raise_for_status()
    server.wait_for_uploaded(instrument_id, RUN, f"{RUN}/a.csv", content=a.content)


# ---------------------------------------------------------------------------
# The queue poll
# ---------------------------------------------------------------------------


@pytest.mark.covers(
    "queue.poll->failed_first_event",
    "queue.poll->failed_every_tenth_event",
    "event.upload_queue_poll_failed->emitted",
)
def test_failed_queue_polls_are_reported_on_the_first_failure_and_every_tenth(
    watcher: WatcherFactory, server: ServerView, proxy: FaultProxy
) -> None:
    pc = manual_watcher(watcher, server)
    outage = hold_queue(proxy)

    first = server.wait_for_event(
        pc.watcher_id, event_type="error", kind="upload_queue_poll_failed"
    )
    assert first.details["consecutive_failures"] == 1
    assert first.message.startswith("Failed to fetch upload queue")
    wait_until(
        lambda: heartbeat_total(server, pc.watcher_id, "errors_since_last") >= 1,
        20,
        lambda: server.dump(pc.watcher_id),
        what="a heartbeat to count the failed poll as an error",
    )

    # A sustained outage adds an event on every tenth failure and none in between.
    wait_until(
        lambda: outage.hits >= 10,
        40,
        lambda: f"failed polls so far: {outage.hits}",
        what="ten failed polls",
    )
    events = server.wait_for_events(
        pc.watcher_id, event_type="error", kind="upload_queue_poll_failed", count=2
    )
    assert [e.details["consecutive_failures"] for e in events] == [1, 10]

    # One good poll ends the outage, and the next outage is counted from one again.
    proxy.remove_fault(outage)
    mark = len(proxy.requests)
    wait_until(
        lambda: any(
            r.method == "GET" and _route(r).endswith("/upload-queue") and r.fault_mode is None
            for r in proxy.requests[mark:]
        ),
        20,
        what="a good queue poll",
    )
    hold_queue(proxy)
    events = server.wait_for_events(
        pc.watcher_id, event_type="error", kind="upload_queue_poll_failed", count=3
    )
    assert [e.details["consecutive_failures"] for e in events] == [1, 10, 1]


# ---------------------------------------------------------------------------
# The watcher gives up on a file
# ---------------------------------------------------------------------------


@pytest.mark.covers(
    "queue.file->missing_reported_once",
    "queue.file->cancelled_after_three_polls",
    "queue.cancelled->requested_again",
    "event.queued_file_missing->emitted",
    "event.upload_request_cancelled->emitted",
)
def test_queued_file_that_is_missing_is_reported_once_and_cancelled_after_three_polls(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    admin: Admin,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = manual_watcher(watcher, server)
    a = detect_run(server, instrument_id, watch_dir, RUN, {"a.csv": SMALL})["a.csv"]
    path = watch_dir / RUN / "a.csv"
    path.unlink()

    # Hold the queue while asking, so that every poll that gets through lists the file.
    hold = hold_queue(proxy)
    admin.request_upload(instrument_id, RUN, [a.row.id]).raise_for_status()
    # The log position is taken before the hold is lifted, so no poll that gets through is
    # missed. Polls that are still refused are left out of the count below.
    mark = len(proxy.requests)
    proxy.remove_fault(hold)
    [cancelled] = wait_for_cancellation(server, pc)

    assert cancelled["file_id"] == a.row.id
    assert cancelled["attempts"] == 3
    assert cancelled["reason"] == "missing"
    # The file is back to `detected` and out of the queue, and the cancel came on the third
    # poll that listed it: three polls got through before the request that cancelled it.
    row = server.file(instrument_id, RUN, f"{RUN}/a.csv")
    assert row is not None and row.status == "detected" and row.upload_requested_at is None
    assert queue_ids(server, pc) == set()
    log = proxy.requests
    cancel_at = next(
        i
        for i, r in enumerate(log)
        if r.method == "PATCH" and _route(r).endswith(f"/files/{a.row.id}")
    )
    good_polls = [
        r
        for r in log[mark:cancel_at]
        if r.method == "GET" and _route(r).endswith("/upload-queue") and r.fault_mode is None
    ]
    assert len(good_polls) == 3

    # "Missing" was reported once, on the first of those polls, and not on the other two.
    [missing] = server.events(pc.watcher_id, event_type="error", kind="queued_file_missing")
    assert missing.details["file_id"] == a.row.id
    assert str(missing.details["expected_path"]).endswith("a.csv")
    assert missing.message == "Queued file missing: a.csv"
    assert s3_puts(proxy) == []

    # A cancelled file can be requested again and starts over with three attempts: it is
    # reported missing again, and gives up again only after three more polls. This request
    # waits for a poll that the server answered after the cancellation. A request that comes
    # sooner is another scenario, tested below.
    wait_for_good_poll_after(proxy, cancel_at)
    admin.request_upload(instrument_id, RUN, [a.row.id]).raise_for_status()
    wait_for_cancellation(server, pc, count=2)
    assert len(server.events(pc.watcher_id, event_type="error", kind="queued_file_missing")) == 2
    again = server.file(instrument_id, RUN, f"{RUN}/a.csv")
    assert again is not None and again.status == "detected"

    # With the file back on disk the third request, made after a poll that the server answered
    # after the second cancellation, uploads it.
    write_file(path, a.content)
    wait_for_good_poll_after(proxy, last_file_patch(proxy, a.row.id))
    admin.request_upload(instrument_id, RUN, [a.row.id]).raise_for_status()
    server.wait_for_uploaded(instrument_id, RUN, f"{RUN}/a.csv", content=a.content)
    assert len(server.events(pc.watcher_id, event_type="error", kind="queued_file_missing")) == 2


@pytest.mark.covers("queue.cancelled->requested_before_next_poll")
def test_a_file_requested_again_right_after_its_cancellation_gets_its_attempts_back(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    admin: Admin,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = manual_watcher(watcher, server)
    a = detect_run(server, instrument_id, watch_dir, RUN, {"a.csv": SMALL})["a.csv"]
    # The upload fails three polls in a row, so the watcher gives up on the file.
    refusal = proxy.add_fault("status", path=PRESIGN, method="POST", status=503)
    admin.request_upload(instrument_id, RUN, [a.row.id]).raise_for_status()
    proxy.wait_for_request(
        lambda r: r.method == "PATCH" and _route(r).endswith(f"/files/{a.row.id}"), timeout=30
    )
    # The cancellation is on its way to the server. The next poll is a second away, so the queue
    # is held at once: no poll can forget the cancellation before the file is requested again.
    hold = hold_queue(proxy)
    wait_for_cancellation(server, pc)
    server.wait_for_file(instrument_id, RUN, f"{RUN}/a.csv", status="detected")

    # The cause is gone, and the file is requested again while the queue is still held.
    proxy.remove_fault(refusal)
    admin.request_upload(instrument_id, RUN, [a.row.id]).raise_for_status()
    assert queue_ids(server, pc) == {a.row.id}
    mark = len(proxy.requests)
    proxy.remove_fault(hold)

    # The first poll that gets through lists the file, and the watcher does something with it:
    # it asks for an upload URL (an attempt), or it cancels the request again.
    def attempts() -> list[RecordedRequest]:
        return [
            r
            for r in proxy.requests[mark:]
            if r.method == "POST" and _route(r).endswith("/request-upload-url")
        ]

    def patches() -> list[RecordedRequest]:
        # The request that cancels a file, or the one that marks it uploaded after its PUT.
        return [
            r
            for r in proxy.requests[mark:]
            if r.method == "PATCH" and _route(r).endswith(f"/files/{a.row.id}")
        ]

    wait_until(
        lambda: attempts() or patches(),
        30,
        lambda: server.dump(pc.watcher_id, instrument_id),
        what="the watcher to attempt the file or cancel it again",
    )

    # A request is a new request, with three attempts of its own: the watcher forgot the
    # three failed attempts when it cancelled the file, so it tries the file, which uploads
    # now that nothing refuses it.
    assert attempts(), "the file was cancelled again without an attempt being made"
    server.wait_for_uploaded(instrument_id, RUN, f"{RUN}/a.csv", content=a.content, timeout=15)


@pytest.mark.covers(
    "queue.upload_failing->cancelled_after_three_polls",
    "event.upload_request_cancelled->emitted",
    "event.upload_failed->emitted",
)
def test_queued_file_whose_upload_keeps_failing_is_cancelled_after_three_polls(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    admin: Admin,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = manual_watcher(watcher, server)
    a = detect_run(server, instrument_id, watch_dir, RUN, {"a.csv": SMALL})["a.csv"]
    # A refused upload-URL request fails the file at once. A failing PUT would do the same, but
    # only after backing off between its attempts, at every poll.
    proxy.add_fault("status", path=PRESIGN, method="POST", status=503)

    admin.request_upload(instrument_id, RUN, [a.row.id]).raise_for_status()
    [cancelled] = wait_for_cancellation(server, pc)

    assert cancelled["file_id"] == a.row.id
    assert cancelled["attempts"] == 3
    assert cancelled["reason"] == "upload_failed"
    row = server.file(instrument_id, RUN, f"{RUN}/a.csv")
    assert row is not None and row.status == "detected" and row.upload_requested_at is None
    # Three polls, three failed attempts, and then the watcher stopped asking.
    assert len(calls(proxy, "POST", "/request-upload-url")) == 3
    failed = server.events(pc.watcher_id, event_type="upload_failed")
    assert [e.message for e in failed] == ["Presigned URL request failed: a.csv"] * 3
    assert s3_puts(proxy) == []


@pytest.mark.platforms("cli")
@pytest.mark.covers("queue.unreadable_file->stays_queued_until_readable")
def test_a_requested_file_that_cannot_be_read_yet_stays_requested_and_uploads_once_it_can(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    admin: Admin,
    instrument_id: str,
    watch_dir: Path,
    unreadable_file: Callable[[Path], None],
) -> None:
    pc = manual_watcher(watcher, server)
    a = detect_run(server, instrument_id, watch_dir, RUN, {"a.csv": SMALL})["a.csv"]
    target = watch_dir / RUN / "a.csv"
    unreadable_file(target)

    admin.request_upload(instrument_id, RUN, [a.row.id]).raise_for_status()
    waiting = server.wait_for_event(
        pc.watcher_id, event_type="upload_failed", message_contains="Can't read a.csv yet"
    )
    assert waiting.details["will_retry"] is True
    assert waiting.details["file_id"] == a.row.id

    # More polls than the three that cancel a request whose upload keeps failing (one a second
    # here). The file can't be read, which is not a failed attempt: it stays requested, the
    # server is asked for nothing, and there is no cancellation and no second event.
    stays_true(
        lambda: (
            statuses(server, instrument_id, RUN)["a.csv"] == "upload_requested"
            and queue_ids(server, pc) == {a.row.id}
            and not calls(proxy, "POST", PRESIGN)
            and not server.events(
                pc.watcher_id, event_type="error", kind="upload_request_cancelled"
            )
            and len(server.events(pc.watcher_id, event_type="upload_failed")) == 1
        ),
        6,
        lambda: server.dump(pc.watcher_id, instrument_id),
        what="the request to stay queued while the file can't be read",
    )

    make_readable(target)
    server.wait_for_uploaded(instrument_id, RUN, f"{RUN}/a.csv", content=a.content)
    assert len(server.events(pc.watcher_id, event_type="upload_failed")) == 1


@pytest.mark.covers(
    "queue.unsafe_path->rejected",
    "event.unsafe_upload_path->emitted",
    "event.upload_request_cancelled->emitted",
)
def test_queue_entry_with_a_path_outside_the_watch_folder_is_rejected_and_cancelled(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    admin: Admin,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    # A 6-second tick, so that the one error this scenario counts is counted well inside an
    # interval. The queue is not held: a held queue fails every poll, and each failed poll
    # counts an error too.
    pc = manual_watcher(
        watcher, server, overrides={testing_overrides.HEARTBEAT_INTERVAL_ENV_VAR: "6"}
    )
    a = detect_run(server, instrument_id, watch_dir, RUN, {"a.csv": SMALL})["a.csv"]
    # A file next to the watch folder, which a path that leads out of it would reach. The row
    # is changed by hand, as a buggy or hostile server could answer.
    outside = watch_dir.parent / "outside.csv"
    write_file(outside, SMALL)
    server.execute(
        "UPDATE files SET relative_path = %s WHERE id = %s", ("../outside.csv", a.row.id)
    )
    admin.request_upload(instrument_id, RUN, [a.row.id]).raise_for_status()

    unsafe = server.wait_for_event(pc.watcher_id, event_type="error", kind="unsafe_upload_path")
    assert unsafe.details["file_id"] == a.row.id
    assert unsafe.details["relative_path"] == "../outside.csv"
    # The request is cancelled at once, not after three tries.
    [cancelled] = wait_for_cancellation(server, pc)
    assert cancelled["file_id"] == a.row.id and cancelled["reason"] == "unsafe_path"
    row = server.file(instrument_id, RUN, "../outside.csv")
    assert row is not None and row.status == "detected" and row.upload_requested_at is None
    assert len(server.events(pc.watcher_id, event_type="error", kind="unsafe_upload_path")) == 1

    # The file outside the watch folder was never read or uploaded.
    assert calls(proxy, "POST", "/request-upload-url") == []
    assert s3_puts(proxy) == []
    assert not server.object_exists(instrument_id, RUN, "outside.csv")
    assert outside.read_bytes() != b""  # still there, untouched
    # Nothing else went wrong (no fault is set), so the one error a heartbeat counts is the
    # rejected path.
    wait_until(
        lambda: heartbeat_total(server, pc.watcher_id, "errors_since_last") == 1,
        20,
        lambda: server.dump(pc.watcher_id),
        what="a heartbeat to count the rejected path as an error",
    )


# ---------------------------------------------------------------------------
# The server takes files out of the queue
# ---------------------------------------------------------------------------


@pytest.mark.covers("queue.watcher_stopped->reverted", "event.upload_requests_cancelled->recorded")
def test_stopping_the_watcher_sends_queued_files_back_to_detected(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    admin: Admin,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = manual_watcher(watcher, server)
    files = detect_run(
        server, instrument_id, watch_dir, RUN, {"a.csv": SMALL, "b.csv": SMALL, "c.csv": SMALL}
    )
    hold_queue(proxy)
    admin.request_upload(
        instrument_id, RUN, [files["a.csv"].row.id, files["b.csv"].row.id]
    ).raise_for_status()
    assert queue_ids(server, pc) == {files["a.csv"].row.id, files["b.csv"].row.id}

    # A graceful stop ends with a `stopped` heartbeat, and nobody is left to take the uploads.
    assert pc.stop() == 0
    server.wait_for_watcher_status(pc.watcher_id, "stopped")

    assert statuses(server, instrument_id, RUN) == {
        "a.csv": "detected",
        "b.csv": "detected",
        "c.csv": "detected",
    }
    assert all(f.upload_requested_at is None for f in server.files(instrument_id, RUN))
    assert server.upload_queue(pc.watcher_id) == []
    [revert] = server.events(pc.watcher_id, kind="upload_requests_cancelled")
    assert revert.event_type == "watcher_stopped"
    assert revert.details["reason"] == "watcher_stopped"
    assert revert.details["cancelled_count"] == 2
    assert s3_puts(proxy) == []


@pytest.mark.covers(
    "queue.stale_watcher->reverted_by_sweep",
    "queue.sweep->within_grace_left",
    "event.upload_requests_cancelled->recorded",
)
def test_cron_sweep_reverts_queued_files_only_once_the_grace_period_has_passed(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    admin: Admin,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = manual_watcher(watcher, server)
    files = detect_run(server, instrument_id, watch_dir, RUN, {"a.csv": SMALL, "b.csv": LARGE})
    hold_queue(proxy)
    admin.request_upload_all(instrument_id, RUN).raise_for_status()
    assert set(statuses(server, instrument_id, RUN).values()) == {"upload_requested"}

    # The watcher dies without a `stopped` heartbeat, so nothing reverts the queue. (No heartbeat
    # may be on its way to the server when the timestamp is aged below.)
    silence_heartbeats(proxy)
    pc.kill()
    assert set(statuses(server, instrument_id, RUN).values()) == {"upload_requested"}

    # Six minutes without a heartbeat: the watcher reads as stale, but the sweep waits.
    server.age_past_stale(pc.watcher_id)
    assert server.effective_status(pc.watcher_id) == "stale"
    early = admin.sweep().raise_for_status().body
    assert early == {"swept_instruments": 0, "reverted_files": 0, "failed_instruments": 0}
    assert set(statuses(server, instrument_id, RUN).values()) == {"upload_requested"}
    assert queue_ids(server, pc) == {f.row.id for f in files.values()}
    assert server.events(pc.watcher_id, kind="upload_requests_cancelled") == []

    # Sixteen minutes: the sweep gives up on the watcher and reverts what it left queued.
    server.age_past_sweep_grace(pc.watcher_id)
    swept = admin.sweep().raise_for_status().body
    assert swept == {"swept_instruments": 1, "reverted_files": 2, "failed_instruments": 0}
    assert set(statuses(server, instrument_id, RUN).values()) == {"detected"}
    assert all(f.upload_requested_at is None for f in server.files(instrument_id, RUN))
    assert queue_ids(server, pc) == set()
    [revert] = server.events(pc.watcher_id, kind="upload_requests_cancelled")
    assert revert.event_type == "error"
    assert revert.details["reason"] == "watcher_offline_sweep"
    assert revert.details["cancelled_count"] == 2
    # Nothing is left for a second sweep.
    assert admin.sweep().raise_for_status().body["reverted_files"] == 0


@pytest.mark.covers("queue.dismissed->left_queue")
def test_dismissed_files_leave_the_queue_and_are_not_uploaded(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    admin: Admin,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = manual_watcher(watcher, server)
    files = detect_run(
        server, instrument_id, watch_dir, RUN, {"a.csv": SMALL, "b.csv": SMALL, "c.csv": SMALL}
    )
    a, b, c = files["a.csv"], files["b.csv"], files["c.csv"]
    hold = hold_queue(proxy)
    admin.request_upload(instrument_id, RUN, [a.row.id, b.row.id]).raise_for_status()
    assert queue_ids(server, pc) == {a.row.id, b.row.id}

    # Dismiss one queued file and one that was never requested.
    for dismissed in (a, c):
        result = admin.dismiss_file(dismissed.row.id).raise_for_status()
        assert result.body["already_applied"] is False
    assert queue_ids(server, pc) == {b.row.id}
    assert {f.filename for f in server.files(instrument_id, RUN)} == {"b.csv"}
    gone = {
        f.filename: f.deleted_at for f in server.files(instrument_id, RUN, include_deleted=True)
    }
    assert gone["a.csv"] is not None and gone["c.csv"] is not None and gone["b.csv"] is None

    # The watcher's poll now returns only the file that is still wanted.
    proxy.remove_fault(hold)
    server.wait_for_uploaded(instrument_id, RUN, f"{RUN}/b.csv", content=b.content)
    assert not server.object_exists(instrument_id, RUN, "a.csv")
    assert not server.object_exists(instrument_id, RUN, "c.csv")
    assert len(calls(proxy, "POST", "/request-upload-url")) == 1
    assert len(s3_puts(proxy)) == 1
    assert server.run_status(instrument_id, RUN) == "uploaded"  # the dismissed ones don't count


@pytest.mark.covers("queue.uploaded_file->dismiss_refused")
def test_an_uploaded_file_cannot_be_dismissed(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher()
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")
    content = write_run(watch_dir, RUN, {"a.csv": SMALL})["a.csv"]
    row = server.wait_for_uploaded(instrument_id, RUN, f"{RUN}/a.csv", content=content)

    refused = admin.dismiss_file(row.id)
    assert refused.status_code == 409 and refused.error_code == "CONFLICT", refused
    kept = server.file(instrument_id, RUN, f"{RUN}/a.csv", include_deleted=True)
    assert kept is not None and kept.deleted_at is None and kept.status == "uploaded"
    assert server.read_object(instrument_id, RUN, "a.csv") == content


@pytest.mark.covers("queue.deleted_run_file->not_listed")
def test_upload_queue_does_not_list_files_of_a_deleted_run(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    admin: Admin,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = manual_watcher(watcher, server)
    files = detect_run(server, instrument_id, watch_dir, RUN, {"a.csv": SMALL, "b.csv": SMALL})
    hold = hold_queue(proxy)
    admin.request_upload_all(instrument_id, RUN).raise_for_status()
    assert queue_ids(server, pc) == {f.row.id for f in files.values()}

    # The run is deleted after its files were queued.
    admin.delete_run(instrument_id, RUN).raise_for_status()

    # Deleting the run cancelled the requests. The files read `detected` again, they are not
    # offered to the watcher, and the watcher's event log says why.
    assert queue_ids(server, pc) == set()
    assert statuses(server, instrument_id, RUN) == {"a.csv": "detected", "b.csv": "detected"}
    assert all(f.upload_requested_at is None for f in server.files(instrument_id, RUN))
    (cancelled,) = server.events(pc.watcher_id, event_type="upload_requests_cancelled")
    assert cancelled.details == {
        "kind": "upload_requests_cancelled",
        "reason": "run_deleted",
        "run_id": RUN,
        "cancelled_count": 2,
    }

    # When its queue polls work again, the watcher finds nothing to upload.
    mark = len(proxy.requests)
    proxy.remove_fault(hold)
    wait_for_good_poll_after(proxy, mark)
    stays_true(
        lambda: not calls(proxy, "POST", "/request-upload-url") and not s3_puts(proxy),
        3,
        lambda: server.dump(pc.watcher_id, instrument_id),
        what="the watcher to leave the files of the deleted run alone",
    )
