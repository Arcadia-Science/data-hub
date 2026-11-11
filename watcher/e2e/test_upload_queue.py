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
from collections.abc import Mapping
from pathlib import Path
from typing import NamedTuple

import pytest

from data_hub_shared.testing_proxy import FaultProxy, FaultRule, RecordedRequest
from data_hub_watcher import testing_overrides
from e2e_support.admin import Admin
from e2e_support.drivers import WatcherDriver
from e2e_support.factory import WatcherFactory
from e2e_support.files import LARGE, SMALL, write_file, write_run
from e2e_support.server import FileRow, ServerView
from e2e_support.waiting import KnownBugStillPresent, known_bug, stays_true, wait_until

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


def manual_watcher(watcher: WatcherFactory, server: ServerView) -> WatcherDriver:
    """A started manual-mode watcher that polls the queue every second."""
    pc = watcher(upload_mode="manual", overrides=POLL_EVERY_SECOND)
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")
    return pc


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
    pc.kill()
    server.age_past_stale(pc.watcher_id)
    assert server.effective_status(pc.watcher_id) == "stale"
    assert_refused(a)

    # The next heartbeat brings the watcher back, and the same request goes through.
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
    # reported missing again, and gives up again only after three more polls.
    admin.request_upload(instrument_id, RUN, [a.row.id]).raise_for_status()
    wait_for_cancellation(server, pc, count=2)
    assert len(server.events(pc.watcher_id, event_type="error", kind="queued_file_missing")) == 2
    again = server.file(instrument_id, RUN, f"{RUN}/a.csv")
    assert again is not None and again.status == "detected"

    # With the file back on disk the third request uploads it.
    write_file(path, a.content)
    admin.request_upload(instrument_id, RUN, [a.row.id]).raise_for_status()
    server.wait_for_uploaded(instrument_id, RUN, f"{RUN}/a.csv", content=a.content)
    assert len(server.events(pc.watcher_id, event_type="error", kind="queued_file_missing")) == 2


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
    # A refused upload-URL request fails the file at once. A failing PUT would do the same
    # after seven seconds of backoff for every poll.
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
    pc = manual_watcher(watcher, server)
    a = detect_run(server, instrument_id, watch_dir, RUN, {"a.csv": SMALL})["a.csv"]
    # A file next to the watch folder, which a path that leads out of it would reach. The row
    # is changed by hand, as a buggy or hostile server could answer.
    outside = watch_dir.parent / "outside.csv"
    write_file(outside, SMALL)
    server.execute(
        "UPDATE files SET relative_path = %s WHERE id = %s", ("../outside.csv", a.row.id)
    )
    hold = hold_queue(proxy)
    admin.request_upload(instrument_id, RUN, [a.row.id]).raise_for_status()
    assert [entry["relative_path"] for entry in server.upload_queue(pc.watcher_id)] == [
        "../outside.csv"
    ]
    proxy.remove_fault(hold)

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
    wait_until(
        lambda: heartbeat_total(server, pc.watcher_id, "errors_since_last") >= 1,
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

    # The watcher dies without a `stopped` heartbeat, so nothing reverts the queue.
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


@pytest.mark.xfail(
    strict=True,
    raises=KnownBugStillPresent,
    reason="bug-04-queue-lists-deleted-run-files: the upload queue still lists files of a "
    "run that was deleted",
)
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
    hold_queue(proxy)
    admin.request_upload_all(instrument_id, RUN).raise_for_status()
    assert queue_ids(server, pc) == {f.row.id for f in files.values()}

    # The run is deleted after its files were queued.
    admin.delete_run(instrument_id, RUN).raise_for_status()

    # Intended: files of a deleted run are not offered to the watcher. Today they still are.
    with known_bug():
        assert queue_ids(server, pc) == set()
