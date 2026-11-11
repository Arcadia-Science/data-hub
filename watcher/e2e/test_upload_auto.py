"""Auto mode end to end: a file is uploaded right after its run is reported, and an upload
that didn't finish is retried at the next start.

Every scenario runs the real watcher against the real server and checks what the server and the
S3 stand-in end up holding. Failures come from the fault proxy, which sits in front of the
server and also in front of the stand-in, because upload URLs are relative:

* a PUT to the stand-in is any ``PUT /api/local-s3/...``. A whole file has no query string and a
  part of a multipart upload has ``?uploadId=...&partNumber=N``;
* a failing presign is a 503 on ``request-upload-url``, which fails an upload at once, where a
  failing PUT takes the watcher 7 seconds of backoff to give up on;
* a part that fails for good is a 4xx on ``part-urls``, the one failure the watcher doesn't retry.

The queue (manual mode, "Request upload") has its own file, ``test_upload_queue.py``.
"""

from __future__ import annotations
import contextlib
import hashlib
import re
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from data_hub_shared.testing_proxy import FaultProxy, RecordedRequest
from e2e_support.admin import Admin
from e2e_support.drivers import WatcherDriver
from e2e_support.factory import WatcherFactory
from e2e_support.files import LARGE, SMALL, payload, write_file, write_run
from e2e_support.server import ServerView
from e2e_support.waiting import wait_until

pytestmark = pytest.mark.e2e

RUN = "RUN001"
SMALL_PATH = f"{RUN}/small.csv"
LARGE_PATH = f"{RUN}/large.csv"

# Where the watcher PUTs file bytes: the S3 stand-in's route.
LOCAL_S3 = r"^/api/local-s3/"
PRESIGN = r"/request-upload-url$"
PART_URLS = r"/multipart-upload/part-urls$"
MARK_UPLOADED = r"/api/v1/files/\d+$"
ABORT = r"/multipart-upload$"
POST_RUN = r"/instruments/[^/]+/runs$"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _route(request: RecordedRequest) -> str:
    """The request's path without its query string."""
    return request.path.split("?", 1)[0]


def calls(proxy: FaultProxy, method: str, suffix: str) -> list[RecordedRequest]:
    """The requests of this ``method`` whose path (without the query) ends with ``suffix``."""
    return [r for r in proxy.requests if r.method == method and _route(r).endswith(suffix)]


def s3_puts(proxy: FaultProxy) -> list[RecordedRequest]:
    """Every PUT of file bytes to the stand-in, whole files and parts."""
    return [r for r in proxy.requests if r.method == "PUT" and r.path.startswith("/api/local-s3/")]


def part_puts(proxy: FaultProxy) -> list[RecordedRequest]:
    return [r for r in s3_puts(proxy) if "partNumber=" in r.path]


def whole_file_puts(proxy: FaultProxy) -> list[RecordedRequest]:
    return [r for r in s3_puts(proxy) if "partNumber=" not in r.path]


def pending(pc: WatcherDriver) -> list[tuple[str, str, int]]:
    """The watcher's ``pending_uploads`` rows as ``(relative path, run, attempts)``."""
    rows = pc.state_query(
        "SELECT relative_path, run_id, attempts FROM pending_uploads ORDER BY rowid"
    )
    return [(str(path), str(run), int(attempts)) for path, run, attempts in rows]


def recorded_uploads(pc: WatcherDriver) -> list[str]:
    """The relative paths the watcher has recorded as uploaded in its state database."""
    rows = pc.state_query("SELECT relative_path FROM uploaded_files ORDER BY relative_path")
    return [str(row[0]) for row in rows]


def heartbeat_total(server: ServerView, watcher_id: str, counter: str) -> int:
    """The sum of one heartbeat counter (``errors_since_last``, ...) over all heartbeats."""
    return sum(getattr(beat, counter) or 0 for beat in server.heartbeats(watcher_id))


def start_watching(pc: WatcherDriver, server: ServerView) -> None:
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")


def multipart_upload_id(server: ServerView, file_id: int) -> str | None:
    """The id of the multipart upload the server has open for the file, if any."""
    rows = server.query("SELECT multipart_upload_id FROM files WHERE id = %s", (file_id,))
    return None if rows[0][0] is None else str(rows[0][0])


def wait_for_request(proxy: FaultProxy, method: str, suffix: str) -> RecordedRequest:
    """Wait until the watcher has sent a request, and return it."""
    return proxy.wait_for_request(
        lambda r: r.method == method and _route(r).endswith(suffix), timeout=30
    )


def wait_for_pending(pc: WatcherDriver, expected: list[tuple[str, str, int]]) -> None:
    wait_until(
        lambda: pending(pc) == expected,
        20,
        lambda: f"pending_uploads: {pending(pc)}",
        what=f"pending_uploads to be {expected}",
    )


# ---------------------------------------------------------------------------
# One PUT, or parts
# ---------------------------------------------------------------------------


@pytest.mark.covers("upload.stable->single_put_uploaded", "event.file_uploaded->emitted")
def test_small_file_is_uploaded_with_one_put(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher()
    start_watching(pc, server)

    content = write_run(watch_dir, RUN, {"small.csv": SMALL})["small.csv"]
    row = server.wait_for_uploaded(instrument_id, RUN, SMALL_PATH, content=content)

    assert row.s3_key == f"{instrument_id}/{RUN}/small.csv"
    assert row.size_bytes == SMALL
    assert server.run_status(instrument_id, RUN) == "uploaded"

    # One PUT of the whole file, no multipart upload, and one request that marks it uploaded.
    assert len(whole_file_puts(proxy)) == 1
    assert part_puts(proxy) == []
    assert calls(proxy, "POST", "/multipart-upload/part-urls") == []
    assert len(calls(proxy, "PATCH", f"/api/v1/files/{row.id}")) == 1

    uploaded = server.wait_for_event(pc.watcher_id, event_type="file_uploaded")
    assert uploaded.details["s3_key"] == row.s3_key
    assert uploaded.details["sha256"] == hashlib.sha256(content).hexdigest()
    assert uploaded.details["size_bytes"] == SMALL
    assert uploaded.details["part_count"] == 1

    # The watcher remembers the upload, has nothing left to retry, and counted it.
    assert recorded_uploads(pc) == [SMALL_PATH]
    assert pending(pc) == []
    wait_until(
        lambda: heartbeat_total(server, pc.watcher_id, "files_uploaded_since_last") == 1,
        20,
        lambda: server.dump(pc.watcher_id),
        what="a heartbeat to report the uploaded file",
    )


@pytest.mark.covers("upload.stable->multipart_uploaded", "event.file_uploaded->emitted")
def test_large_file_is_uploaded_in_parts_and_completed(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher()
    start_watching(pc, server)

    content = write_run(watch_dir, RUN, {"large.csv": LARGE})["large.csv"]
    row = server.wait_for_uploaded(instrument_id, RUN, LARGE_PATH, content=content)

    # Five parts of 1 KB, each PUT once, then a completing request, and no single PUT.
    part_numbers = sorted(int(r.path.rsplit("partNumber=", 1)[1]) for r in part_puts(proxy))
    assert part_numbers == [1, 2, 3, 4, 5]
    assert whole_file_puts(proxy) == []
    assert len(calls(proxy, "POST", "/multipart-upload/complete")) == 1
    assert all(r.upstream_status == 200 for r in part_puts(proxy))

    # The server closed the upload: the file is marked uploaded by completing it, with no
    # upload left open.
    assert multipart_upload_id(server, row.id) is None
    assert calls(proxy, "PATCH", f"/api/v1/files/{row.id}") == []

    uploaded = server.wait_for_event(pc.watcher_id, event_type="file_uploaded")
    assert uploaded.details["part_count"] == 5
    assert uploaded.details["size_bytes"] == LARGE
    assert uploaded.details["sha256"] == hashlib.sha256(content).hexdigest()
    assert recorded_uploads(pc) == [LARGE_PATH]
    assert pending(pc) == []


@pytest.mark.covers("upload.batch->parallel_within_budget")
def test_files_of_a_run_upload_in_parallel_but_never_more_than_the_budget(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    budget = 2
    hold = 1.0
    pc = watcher(upload_parallelism=budget)
    # Every PUT takes at least `hold` seconds, so PUTs that start closer together than that
    # overlap, and a PUT can't start while `budget` others still run.
    proxy.add_fault("delay", path=LOCAL_S3, method="PUT", delay_seconds=hold)
    start_watching(pc, server)

    # A file is uploaded as soon as it is stable, one at a time, unless the watcher has several
    # waiting. So the run is reported first, then its updates are refused while four files
    # arrive: two that upload in parts and two that don't.
    first = write_file(watch_dir / RUN / "first.csv", SMALL)
    server.wait_for_uploaded(instrument_id, RUN, f"{RUN}/first.csv", content=first)
    refusal = proxy.add_fault("status", path=r"/runs/[^/]+$", method="PATCH", status=503)
    backlog: dict[str, bytes | int] = {
        "large0.csv": LARGE,
        "large1.csv": payload(LARGE - 500, seed=1),
        "small0.csv": SMALL,
        "small1.csv": payload(SMALL, seed=2),
    }
    written = write_run(watch_dir, RUN, backlog)
    for name in backlog:
        pc.wait_for_log(rf"File stable: .*{re.escape(name)}$")

    # The next update goes through, and everything that waited is uploaded as one batch. Each
    # of the two workers that take files may be sending the parts of a large file, so without
    # a budget shared by files and parts there would be up to four PUTs at once.
    proxy.remove_fault(refusal)
    written["go.csv"] = write_file(watch_dir / RUN / "go.csv", SMALL)
    for name, content in written.items():
        server.wait_for_uploaded(instrument_id, RUN, f"{RUN}/{name}", content=content, timeout=90)

    puts = s3_puts(proxy)
    # The first file, the parts of the two large ones, the two small ones, and the last one.
    assert len(puts) == 1 + 5 + 5 + 1 + 1 + 1
    starts = sorted(r.timestamp for r in puts)
    slack = 0.1
    # The budget holds for whole files and parts together: no PUT starts less than `hold`
    # after the one `budget` places before it, because that one is still running.
    for earlier, later in zip(starts, starts[budget:], strict=False):
        assert later - earlier >= hold - slack, starts
    # And the uploads really do overlap: some PUT starts while the one before it still runs.
    assert any(b - a < hold - slack for a, b in zip(starts, starts[1:], strict=False)), starts
    assert server.run_status(instrument_id, RUN) == "uploaded"


@pytest.mark.covers("upload.pending->recorded_then_cleared")
def test_pending_row_exists_while_the_put_runs_and_is_cleared_after(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher()
    proxy.add_fault("delay", path=LOCAL_S3, method="PUT", delay_seconds=4, count=1)
    start_watching(pc, server)

    content = write_run(watch_dir, RUN, {"small.csv": SMALL})["small.csv"]
    # The PUT has reached the proxy and is held there: the file is mid-upload.
    wait_for_request(proxy, "PUT", f"/{RUN}/small.csv")
    assert pending(pc) == [(SMALL_PATH, RUN, 0)]
    mid_upload = server.file(instrument_id, RUN, SMALL_PATH)
    assert mid_upload is not None and mid_upload.status == "detected"
    assert recorded_uploads(pc) == []

    server.wait_for_uploaded(instrument_id, RUN, SMALL_PATH, content=content)
    wait_for_pending(pc, [])
    assert recorded_uploads(pc) == [SMALL_PATH]


# ---------------------------------------------------------------------------
# A single PUT that fails
# ---------------------------------------------------------------------------


@pytest.mark.covers("upload.put->retried_then_succeeds")
def test_single_put_is_retried_after_a_5xx_and_succeeds(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher()
    proxy.add_fault("status", path=LOCAL_S3, method="PUT", status=503, count=2)
    start_watching(pc, server)

    content = write_run(watch_dir, RUN, {"small.csv": SMALL})["small.csv"]
    server.wait_for_uploaded(instrument_id, RUN, SMALL_PATH, content=content)

    # Three PUTs: two refused, then one that worked, after a 1 s and then a 2 s backoff.
    puts = whole_file_puts(proxy)
    assert [r.fault_mode for r in puts] == ["status", "status", None]
    first, second, third = (r.timestamp for r in puts)
    assert second - first >= 0.9
    assert third - second >= 1.9

    # The retries are invisible on the server: the upload succeeded, so nothing failed.
    server.wait_for_event(pc.watcher_id, event_type="file_uploaded")
    assert server.events(pc.watcher_id, event_type="upload_failed") == []


@pytest.mark.covers("upload.put->failed_after_retries", "event.upload_failed->emitted")
def test_single_put_that_fails_three_times_leaves_the_file_pending(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher()
    proxy.add_fault("status", path=LOCAL_S3, method="PUT", status=503)
    start_watching(pc, server)

    write_run(watch_dir, RUN, {"small.csv": SMALL})
    failed = server.wait_for_event(pc.watcher_id, event_type="upload_failed", timeout=40)

    assert failed.message == "Upload failed: small.csv"
    assert failed.details["s3_key"] == f"{instrument_id}/{RUN}/small.csv"
    assert "503" in failed.details["error"]
    assert len(whole_file_puts(proxy)) == 3

    # The file is still known to the server but never arrived, and the watcher will try it
    # again at the next start.
    row = server.file(instrument_id, RUN, SMALL_PATH)
    assert row is not None and row.status == "detected" and row.s3_key is None
    assert not server.object_exists(instrument_id, RUN, "small.csv")
    assert server.run_status(instrument_id, RUN) == "pending"
    assert pending(pc) == [(SMALL_PATH, RUN, 0)]
    assert recorded_uploads(pc) == []
    wait_until(
        lambda: heartbeat_total(server, pc.watcher_id, "errors_since_last") >= 1,
        20,
        lambda: server.dump(pc.watcher_id),
        what="a heartbeat to count the failed upload as an error",
    )


@pytest.mark.covers("upload.presign->failed", "event.upload_failed->emitted")
def test_failed_upload_url_request_leaves_the_file_detected(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher()
    proxy.add_fault("status", path=PRESIGN, method="POST", status=503)
    start_watching(pc, server)

    write_run(watch_dir, RUN, {"small.csv": SMALL})
    failed = server.wait_for_event(pc.watcher_id, event_type="upload_failed")

    assert failed.message == "Presigned URL request failed: small.csv"
    assert "error" in failed.details
    row = server.file(instrument_id, RUN, SMALL_PATH)
    assert row is not None and row.status == "detected"
    assert s3_puts(proxy) == []
    assert pending(pc) == [(SMALL_PATH, RUN, 0)]


# ---------------------------------------------------------------------------
# The request that marks a single-PUT file uploaded
# ---------------------------------------------------------------------------


@pytest.mark.covers("upload.notify->failed", "event.upload_failed->emitted")
def test_failed_notification_leaves_the_file_pending_and_the_next_start_uploads_it(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher()
    proxy.add_fault("status", path=MARK_UPLOADED, method="PATCH", status=503, count=1)
    start_watching(pc, server)

    content = write_run(watch_dir, RUN, {"small.csv": SMALL})["small.csv"]
    failed = server.wait_for_event(
        pc.watcher_id, event_type="upload_failed", message_contains="Upload notification failed"
    )

    # The bytes are in the stand-in, but the server was never told, so the row is still
    # `detected`, and the watcher didn't record the file as done.
    assert failed.details["s3_key"] == f"{instrument_id}/{RUN}/small.csv"
    assert server.read_object(instrument_id, RUN, "small.csv") == content
    row = server.file(instrument_id, RUN, SMALL_PATH)
    assert row is not None and row.status == "detected"
    assert recorded_uploads(pc) == []
    assert pending(pc) == [(SMALL_PATH, RUN, 0)]

    # The next start tries the file again from the start: a new PUT, and this time the
    # server is told.
    pc.restart()
    server.wait_for_uploaded(instrument_id, RUN, SMALL_PATH, content=content)
    wait_for_pending(pc, [])
    assert recorded_uploads(pc) == [SMALL_PATH]
    assert len(whole_file_puts(proxy)) == 2


@pytest.mark.covers("upload.server->already_uploaded", "upload.notify->failed")
def test_file_the_server_already_holds_is_recorded_without_another_put(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher()
    # The server marks the file uploaded, but the watcher never sees the answer.
    proxy.add_fault("drop_response", path=MARK_UPLOADED, method="PATCH", count=1)
    start_watching(pc, server)

    content = write_run(watch_dir, RUN, {"small.csv": SMALL})["small.csv"]
    server.wait_for_event(
        pc.watcher_id, event_type="upload_failed", message_contains="Upload notification failed"
    )
    row = server.wait_for_uploaded(instrument_id, RUN, SMALL_PATH, content=content)
    assert recorded_uploads(pc) == []
    assert pending(pc) == [(SMALL_PATH, RUN, 0)]
    assert len(whole_file_puts(proxy)) == 1

    # At the next start the upload-URL request answers "already uploaded", and the watcher
    # records the file and sends nothing to the stand-in.
    pc.restart()
    wait_for_pending(pc, [])
    assert recorded_uploads(pc) == [SMALL_PATH]
    assert len(whole_file_puts(proxy)) == 1
    assert len(calls(proxy, "POST", "/request-upload-url")) == 2
    assert all(r.upstream_status == 200 for r in calls(proxy, "POST", "/request-upload-url"))
    again = server.file(instrument_id, RUN, SMALL_PATH)
    assert again is not None and again.id == row.id and again.status == "uploaded"


# ---------------------------------------------------------------------------
# Multipart uploads that fail
# ---------------------------------------------------------------------------


@pytest.mark.covers("upload.part->retried_then_succeeds")
def test_a_failed_part_is_retried_on_its_own_and_the_upload_completes(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher()
    proxy.add_fault("status", path=LOCAL_S3 + r".*partNumber=3$", method="PUT", status=503, count=1)
    start_watching(pc, server)

    content = write_run(watch_dir, RUN, {"large.csv": LARGE})["large.csv"]
    server.wait_for_uploaded(instrument_id, RUN, LARGE_PATH, content=content)

    # Part 3 was sent twice, a second apart, and every other part once.
    third = [r for r in part_puts(proxy) if r.path.endswith("partNumber=3")]
    assert [r.fault_mode for r in third] == ["status", None]
    assert third[1].timestamp - third[0].timestamp >= 0.9
    assert len(part_puts(proxy)) == 6
    # The retry asked for a fresh URL for that part, and the upload was never aborted.
    assert len(calls(proxy, "POST", "/multipart-upload/part-urls")) == 2
    assert calls(proxy, "DELETE", "/multipart-upload") == []
    assert len(calls(proxy, "POST", "/multipart-upload/complete")) == 1

    server.wait_for_event(pc.watcher_id, event_type="file_uploaded")
    assert server.events(pc.watcher_id, event_type="upload_failed") == []


@pytest.mark.covers("upload.multipart->aborted_on_failure", "event.upload_failed->emitted")
def test_a_part_that_fails_for_good_aborts_the_upload_on_the_server(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher()
    # Ten parts, so the URLs of parts 9 and 10 come from a second request, after the first
    # parts are already in the stand-in. Each PUT is held for 1.5 s to leave time to switch
    # that second request to a 403, which the watcher doesn't retry.
    proxy.add_fault("delay", path=LOCAL_S3, method="PUT", delay_seconds=1.5)
    start_watching(pc, server)

    write_file(watch_dir / RUN / "large.csv", 10 * 1024)
    wait_for_request(proxy, "POST", "/multipart-upload/part-urls")
    proxy.add_fault("status", path=PART_URLS, method="POST", status=403)
    row = server.wait_for_file(instrument_id, RUN, LARGE_PATH)
    upload_id = multipart_upload_id(server, row.id)
    assert upload_id is not None
    staged = server.env.s3_mirror_root / ".multipart" / upload_id
    assert staged.is_dir()

    failed = server.wait_for_event(pc.watcher_id, event_type="upload_failed", timeout=60)
    assert failed.details["s3_key"] == f"{instrument_id}/{RUN}/large.csv"

    # The first eight parts had already been sent when the watcher gave up. It aborted the
    # upload, so the server has no upload open and the stand-in dropped the staged parts. The
    # file isn't uploaded.
    assert len(part_puts(proxy)) >= 8
    [abort] = calls(proxy, "DELETE", "/multipart-upload")
    assert abort.upstream_status == 200
    assert multipart_upload_id(server, row.id) is None
    assert not staged.exists()
    assert not server.object_exists(instrument_id, RUN, "large.csv")
    assert calls(proxy, "POST", "/multipart-upload/complete") == []
    again = server.file(instrument_id, RUN, LARGE_PATH)
    assert again is not None and again.status == "detected"
    assert pending(pc) == [(LARGE_PATH, RUN, 0)]


def change_file_during(
    proxy: FaultProxy, path_on_disk: Path, replacement: bytes, *, restore: bytes | None = None
) -> None:
    """Rewrite a file the watcher has hashed but not yet read for its parts."""
    wait_for_request(proxy, "POST", "/multipart-upload/part-urls")
    write_file(path_on_disk, replacement)
    if restore is not None:
        # The abort that follows the first rejected checksum is held by the proxy. Put the
        # original bytes back while it waits, so the second upload reads them.
        wait_for_request(proxy, "DELETE", "/multipart-upload")
        write_file(path_on_disk, restore)


@pytest.mark.covers("upload.multipart->bad_digest_restarted")
def test_file_that_changed_after_hashing_restarts_the_upload_once(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher()
    # The part URL request is held so the file can change after it was hashed. The abort after
    # the checksum is rejected is held so the file can change back before the second upload.
    proxy.add_fault("delay", path=PART_URLS, method="POST", delay_seconds=4, count=1)
    proxy.add_fault("delay", path=ABORT, method="DELETE", delay_seconds=4, count=1)
    start_watching(pc, server)

    original = write_file(watch_dir / RUN / "large.csv", LARGE)
    change_file_during(
        proxy, watch_dir / RUN / "large.csv", payload(LARGE, seed=99), restore=original
    )

    # The second upload read the original bytes, the ones that were hashed, and succeeded.
    row = server.wait_for_uploaded(instrument_id, RUN, LARGE_PATH, content=original)
    completes = calls(proxy, "POST", "/multipart-upload/complete")
    assert [r.upstream_status for r in completes] == [400, 200]
    assert len(calls(proxy, "POST", "/request-upload-url")) == 2
    assert len(calls(proxy, "DELETE", "/multipart-upload")) == 1
    assert multipart_upload_id(server, row.id) is None

    uploaded = server.wait_for_event(pc.watcher_id, event_type="file_uploaded")
    assert uploaded.details["sha256"] == hashlib.sha256(original).hexdigest()
    assert server.events(pc.watcher_id, event_type="upload_failed") == []
    wait_for_pending(pc, [])


@pytest.mark.covers("upload.multipart->bad_digest_twice_failed", "event.upload_failed->emitted")
def test_second_checksum_rejection_aborts_the_upload_and_reports_the_failure(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher()
    proxy.add_fault("delay", path=PART_URLS, method="POST", delay_seconds=4, count=1)
    start_watching(pc, server)

    write_file(watch_dir / RUN / "large.csv", LARGE)
    # The file stays changed, so the restart reads bytes that don't match the hash either.
    change_file_during(proxy, watch_dir / RUN / "large.csv", payload(LARGE, seed=99))

    failed = server.wait_for_event(pc.watcher_id, event_type="upload_failed", timeout=60)
    assert failed.details["s3_key"] == f"{instrument_id}/{RUN}/large.csv"
    assert "match" in failed.details["error"]

    # Two attempts, each rejected, each aborted. Nothing reached the stand-in.
    completes = calls(proxy, "POST", "/multipart-upload/complete")
    assert [r.upstream_status for r in completes] == [400, 400]
    assert len(calls(proxy, "POST", "/request-upload-url")) == 2
    assert len(calls(proxy, "DELETE", "/multipart-upload")) == 2
    row = server.file(instrument_id, RUN, LARGE_PATH)
    assert row is not None and row.status == "detected"
    assert multipart_upload_id(server, row.id) is None
    assert not server.object_exists(instrument_id, RUN, "large.csv")
    assert pending(pc) == [(LARGE_PATH, RUN, 0)]
    assert recorded_uploads(pc) == []


# ---------------------------------------------------------------------------
# After a kill, and at the next start
# ---------------------------------------------------------------------------


@pytest.mark.covers("upload.killed->pending_kept", "upload.pending->retried_on_start")
def test_killed_mid_upload_keeps_the_pending_row_and_the_next_start_finishes_the_upload(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher()
    # The first four parts are held in the proxy, so the watcher is in the middle of the file.
    proxy.add_fault("delay", path=LOCAL_S3, method="PUT", delay_seconds=30, count=4)
    start_watching(pc, server)

    content = write_run(watch_dir, RUN, {"large.csv": LARGE})["large.csv"]
    wait_until(
        lambda: len(part_puts(proxy)) >= 4,
        30,
        lambda: "\n".join(f"{r.method} {r.path}" for r in proxy.requests),
        what="four part PUTs to be in flight",
    )
    row = server.wait_for_file(instrument_id, RUN, LARGE_PATH)
    first_upload = multipart_upload_id(server, row.id)
    assert first_upload is not None
    pc.kill()

    # Nothing reached the stand-in, the server still has a detected file, and the watcher's
    # state database still lists the file as an upload to retry.
    assert all(r.upstream_status is None for r in part_puts(proxy))
    assert not server.object_exists(instrument_id, RUN, "large.csv")
    killed = server.file(instrument_id, RUN, LARGE_PATH)
    assert killed is not None and killed.status == "detected"
    assert pending(pc) == [(LARGE_PATH, RUN, 0)]
    assert recorded_uploads(pc) == []

    # The next start retries it once, from scratch: the server drops the abandoned multipart
    # upload and opens a new one, and the file arrives intact.
    pc.start()
    server.wait_for_uploaded(instrument_id, RUN, LARGE_PATH, content=content)
    wait_for_pending(pc, [])
    assert recorded_uploads(pc) == [LARGE_PATH]
    assert multipart_upload_id(server, row.id) is None
    assert not (server.env.s3_mirror_root / ".multipart" / first_upload).exists()
    assert len(calls(proxy, "POST", "/request-upload-url")) == 2
    assert len(calls(proxy, "POST", "/multipart-upload/complete")) == 1


@pytest.mark.covers(
    "upload.pending->attempts_exhausted",
    "event.upload_retries_exhausted->emitted",
    "event.upload_failed->emitted",
)
def test_pending_upload_is_dropped_after_three_failed_starts_and_can_still_be_requested(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    admin: Admin,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher()
    # An upload that fails every time. A refused upload-URL request fails at once, where a
    # failing PUT would take the watcher seven seconds of backoff for every start.
    fault = proxy.add_fault("status", path=PRESIGN, method="POST", status=503)
    start_watching(pc, server)

    content = write_run(watch_dir, RUN, {"small.csv": SMALL})["small.csv"]
    server.wait_for_event(pc.watcher_id, event_type="upload_failed")
    assert pending(pc) == [(SMALL_PATH, RUN, 0)]

    # Every later start retries the file once and counts one attempt.
    for attempts in (1, 2):
        pc.restart()
        wait_for_pending(pc, [(SMALL_PATH, RUN, attempts)])
    pc.restart()
    exhausted = server.wait_for_event(
        pc.watcher_id, event_type="error", kind="upload_retries_exhausted"
    )

    assert exhausted.details["attempts"] == 3
    assert exhausted.details["relative_path"] == SMALL_PATH
    assert exhausted.details["run_id"] == RUN
    assert "request it from the run page" in exhausted.message
    wait_for_pending(pc, [])
    row = server.file(instrument_id, RUN, SMALL_PATH)
    assert row is not None and row.status == "detected"
    # Four starts, four refused requests: the three retries stopped there, none was a fifth.
    assert fault.hits == 4

    # The file is not lost: it can still be requested from the run page.
    proxy.remove_fault(fault)
    server.wait_for_watcher_status(pc.watcher_id, "watching")
    admin.request_upload(instrument_id, RUN, [row.id]).raise_for_status()
    server.wait_for_uploaded(instrument_id, RUN, SMALL_PATH, content=content)


@pytest.mark.covers(
    "upload.pending->file_missing",
    "event.pending_upload_missing->emitted",
    "event.stable_callback_failed->emitted",
)
def test_pending_upload_for_a_file_that_vanished_is_dropped_at_the_next_start(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher()
    # The run report is held in the proxy, and the file is deleted while it waits: the file is
    # gone between its run report and its upload.
    proxy.add_fault("delay", path=POST_RUN, method="POST", delay_seconds=3, count=1)
    start_watching(pc, server)

    write_run(watch_dir, RUN, {"small.csv": SMALL})
    wait_for_request(proxy, "POST", f"/instruments/{instrument_id}/runs")
    (watch_dir / RUN / "small.csv").unlink()

    # The report went through, the upload could not even start, and that was reported.
    callback = server.wait_for_event(
        pc.watcher_id, event_type="error", kind="stable_callback_failed"
    )
    assert callback.details["path"].endswith("small.csv")
    row = server.file(instrument_id, RUN, SMALL_PATH)
    assert row is not None and row.status == "detected"
    assert pending(pc) == [(SMALL_PATH, RUN, 0)]
    assert s3_puts(proxy) == []

    # At the next start the watcher finds nothing to retry and says so.
    pc.restart()
    missing = server.wait_for_event(
        pc.watcher_id, event_type="error", kind="pending_upload_missing"
    )
    assert missing.details["relative_path"] == SMALL_PATH
    assert missing.details["run_id"] == RUN
    wait_for_pending(pc, [])
    # It's only a dropped retry: the server keeps the file as detected.
    still = server.file(instrument_id, RUN, SMALL_PATH)
    assert still is not None and still.status == "detected"
    assert s3_puts(proxy) == []


@contextlib.contextmanager
def _state_db(pc: WatcherDriver) -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(pc.state_db_path(), timeout=30, isolation_level=None)
    try:
        yield conn
    finally:
        conn.close()


def stall_pending_records(pc: WatcherDriver) -> None:
    """Make the watcher's next write of a ``pending_uploads`` row take minutes.

    It adds a trigger to the watcher's state database that joins ``sqlite_master`` with itself
    nine times (about 2e10 rows) before the insert goes through. Every write before it, the
    run's ``runs`` and ``detected_files`` rows, commits as usual, so the watcher sits exactly
    between "the run was reported" and "the files were recorded as pending".
    """
    cross_join = ", ".join(f"sqlite_master t{n}" for n in range(9))
    with _state_db(pc) as conn:
        conn.execute(
            "CREATE TRIGGER stall_pending BEFORE INSERT ON pending_uploads "
            f"BEGIN SELECT count(*) FROM {cross_join}; END"
        )


def release_pending_records(pc: WatcherDriver) -> None:
    with _state_db(pc) as conn:
        conn.execute("DROP TRIGGER IF EXISTS stall_pending")


@pytest.mark.xfail(
    strict=True,
    reason="bug-02-crash-before-pending-record: a watcher killed after the run report and "
    "before the pending record never uploads those files",
)
@pytest.mark.covers("upload.crash_after_report->retried_after_restart")
def test_watcher_killed_after_the_run_report_uploads_the_files_after_a_restart(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher()
    start_watching(pc, server)
    stall_pending_records(pc)

    content = write_run(watch_dir, RUN, {"small.csv": SMALL})["small.csv"]
    # The run is reported and the watcher remembers it, but the pending record is stuck.
    wait_until(
        lambda: (
            pc.state_query("SELECT count(*) FROM detected_files WHERE run_id = ?", (RUN,))[0][0]
            == 1
        ),
        30,
        lambda: server.dump(pc.watcher_id, instrument_id),
        what="the watcher to record the reported run",
    )
    reported = server.file(instrument_id, RUN, SMALL_PATH)
    assert reported is not None and reported.status == "detected"
    pc.kill()
    release_pending_records(pc)
    # The crash left nothing to retry, and the upload had not started.
    assert pending(pc) == []
    assert calls(proxy, "POST", "/request-upload-url") == []

    # Intended: the files of a run the watcher reported are not forgotten, so an auto-mode
    # watcher that starts again uploads them. Today nothing does.
    pc.start()
    server.wait_for_uploaded(instrument_id, RUN, SMALL_PATH, content=content, timeout=12)
