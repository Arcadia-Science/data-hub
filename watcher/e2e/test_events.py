"""Event reporting, and every event type and error kind the watcher can send.

The watcher queues events in memory and sends them in a batch on each heartbeat tick. The
first group of tests is about that reporter: batching and order, a flush that fails and the
``events_dropped`` event that says so, and events that are lost when the watcher is killed.
The second group causes each event type and each ``error`` kind once, with the smallest
scenario that does it, and checks what the server stored. The kinds are listed at the top
of ``data_hub_watcher/events.py``. Most are also covered, with more context, by the scenario
files of the machine they belong to; the point here is that none is left out.
"""

from __future__ import annotations
from pathlib import Path

import pytest

from data_hub_shared.testing_index import LocalPackageIndex
from data_hub_shared.testing_proxy import FaultProxy, RecordedRequest
from data_hub_watcher import testing_overrides
from e2e_support.admin import Admin
from e2e_support.factory import WatcherFactory
from e2e_support.files import SMALL, GrowingFile, write_file, write_run
from e2e_support.server import ServerView
from e2e_support.waiting import KnownBugStillPresent, known_bug, wait_until

pytestmark = pytest.mark.e2e


def event_posts(proxy: FaultProxy) -> list[RecordedRequest]:
    """Every request that sent events, faulted ones included."""
    return [r for r in proxy.requests if r.method == "POST" and r.path.endswith("/events")]


# ---------------------------------------------------------------------------
# The reporter
# ---------------------------------------------------------------------------


@pytest.mark.covers(
    "reporter.queue->flushed_on_heartbeat",
    "event.watcher_started->emitted",
    "event.watcher_stopped->emitted",
    "event.config_synced->emitted",
    "event.run_reported->emitted",
    "event.file_uploaded->emitted",
)
def test_events_queued_between_ticks_are_sent_together_on_the_next_one_in_order(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    # A 15-second tick leaves time to see events wait in the queue. The startup beat is
    # sent at once, and flushes what start-up queued.
    pc = watcher(overrides={testing_overrides.HEARTBEAT_INTERVAL_ENV_VAR: "15"})
    pc.start()
    started = server.wait_for_event(pc.watcher_id, event_type="watcher_started")
    assert started.message.startswith(pc.started_prefix)
    synced = server.wait_for_event(pc.watcher_id, event_type="config_synced")
    assert synced.details == {"trigger": "startup"}
    assert synced.message == "Config synced (trigger=startup)"
    seen = server.last_event_id(pc.watcher_id)
    posts = len(event_posts(proxy))

    files = write_run(watch_dir, "RUN001")
    for name, content in files.items():
        server.wait_for_uploaded(instrument_id, "RUN001", f"RUN001/{name}", content=content)

    # The run is reported and both files are uploaded, but the events about it are still in
    # the watcher's queue: nothing is sent between ticks.
    assert server.events(pc.watcher_id, after_id=seen) == []
    assert len(event_posts(proxy)) == posts

    # The next tick sends all three in one request, which the server stores in one go and
    # in the order they happened.
    batch = server.wait_for_events(pc.watcher_id, count=3, after_id=seen, timeout=45)
    assert [e.event_type for e in batch] == ["run_reported", "file_uploaded", "file_uploaded"]
    assert len({e.created_at for e in batch}) == 1
    ids = [e.id for e in batch]
    assert ids == list(range(ids[0], ids[0] + 3))
    assert len(event_posts(proxy)) == posts + 1

    reported = batch[0]
    assert reported.message == "Run RUN001 reported"
    assert reported.details == {"run_id": "RUN001"}
    by_key = {e.details["s3_key"]: e.details for e in batch[1:]}
    assert set(by_key) == {f"{instrument_id}/RUN001/{name}" for name in files}
    for name, content in files.items():
        details = by_key[f"{instrument_id}/RUN001/{name}"]
        assert details["size_bytes"] == len(content)
        assert {"sha256", "prep_seconds", "upload_seconds", "part_count"} <= set(details)

    # A stop flushes at once and says who stopped the watcher. (The watcher's own
    # `watcher_stopped` and the server's revert event share the event type, so the message
    # says which one is meant.)
    assert pc.stop() == 0
    stopped = server.wait_for_event(
        pc.watcher_id, event_type="watcher_stopped", message_contains=pc.operator_stop_message
    )
    assert stopped.message == pc.operator_stop_message


@pytest.mark.covers(
    "reporter.flush->failed_batch_dropped",
    "reporter.dropped->reported_after_recovery",
    "event.events_dropped->emitted",
)
def test_a_batch_that_cannot_be_sent_is_dropped_and_the_next_flush_reports_the_gap(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher()
    # The startup flush makes three attempts and every one is refused.
    with proxy.fault("status", method="POST", path=r"/events$", status=503, count=3) as refused:
        pc.start()
        assert refused.hits == 3
    # The watcher keeps running ...
    assert pc.is_running()
    server.wait_for_watcher_status(pc.watcher_id, "watching")
    # ... and the next tick says that events were lost, and since when.
    dropped = server.wait_for_event(pc.watcher_id, event_type="error", kind="events_dropped")
    assert dropped.details["dropped_count"] == 2  # `config_synced` and `watcher_started`
    assert dropped.details["since"]
    assert dropped.message == "Dropped 2 watcher event(s) due to API errors"
    assert server.events(pc.watcher_id, event_type="watcher_started") == []

    # Events that come after it are stored normally, after the report of the gap.
    write_run(watch_dir, "RUN001", {"small.csv": SMALL})
    reported = server.wait_for_event(pc.watcher_id, event_type="run_reported")
    assert reported.id > dropped.id
    assert len(server.events(pc.watcher_id, kind="events_dropped")) == 1


@pytest.mark.covers("reporter.queued->persisted_across_kill")
@pytest.mark.xfail(
    strict=True,
    raises=KnownBugStillPresent,
    reason=(
        "bug-11-events-lost-on-kill: the queue lives in memory only, so events queued but "
        "not yet sent when the watcher is killed are never delivered"
    ),
)
def test_events_queued_before_a_kill_are_sent_after_the_restart(
    watcher: WatcherFactory, server: ServerView, instrument_id: str, watch_dir: Path
) -> None:
    # A one-minute tick, so the events about the upload are still queued when it is killed.
    pc = watcher(overrides={testing_overrides.HEARTBEAT_INTERVAL_ENV_VAR: "60"})
    pc.start()
    server.wait_for_event(pc.watcher_id, event_type="watcher_started")
    content = write_run(watch_dir, "RUN001", {"small.csv": SMALL})["small.csv"]
    server.wait_for_uploaded(instrument_id, "RUN001", "RUN001/small.csv", content=content)
    assert server.events(pc.watcher_id, event_type="run_reported") == []
    pc.kill()

    pc.write_env(overrides={testing_overrides.HEARTBEAT_INTERVAL_ENV_VAR: "2"})
    pc.start()
    # Intended: the `run_reported` and `file_uploaded` events of the first process are kept
    # in the state database and sent by the second. Nothing else reports them: the run and
    # the file are known to the new process and are not reported again.
    with known_bug():
        server.wait_for_event(pc.watcher_id, event_type="run_reported", timeout=10)
        server.wait_for_event(pc.watcher_id, event_type="file_uploaded", timeout=10)


# ---------------------------------------------------------------------------
# Event types and kinds, one scenario each
# ---------------------------------------------------------------------------


@pytest.mark.covers("event.run_report_failed->emitted")
def test_a_failed_run_report_is_reported_once_and_retried(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher()
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")

    with proxy.fault(
        "status", method="POST", path=r"/instruments/[^/]+/runs$", status=503, count=1
    ):
        content = write_run(watch_dir, "RUN001", {"small.csv": SMALL})["small.csv"]
        failed = server.wait_for_event(pc.watcher_id, event_type="error", kind="run_report_failed")
    assert failed.message.startswith("Failed to report run RUN001: ")
    assert failed.details["run_id"] == "RUN001"
    assert failed.details["operation"] == "create"
    assert failed.details["status_code"] == 503
    assert failed.details["file_count"] == 1
    assert "error" in failed.details

    # A server error is retried, after 5 seconds, without anything else happening.
    server.wait_for_run(instrument_id, "RUN001", timeout=30)
    server.wait_for_uploaded(instrument_id, "RUN001", "RUN001/small.csv", content=content)
    server.wait_for_event(pc.watcher_id, event_type="run_reported")
    assert len(server.events(pc.watcher_id, kind="run_report_failed")) == 1


@pytest.mark.covers("event.config_sync_failed->emitted")
def test_a_failed_config_check_or_push_at_startup_is_reported_and_the_watcher_starts_anyway(
    watcher: WatcherFactory, server: ServerView, proxy: FaultProxy
) -> None:
    pc = watcher()

    # The checksum check fails.
    with proxy.fault("status", path=r"/config-checksum$", status=503, count=1):
        pc.start()
    check_failed = server.wait_for_event(
        pc.watcher_id, event_type="error", kind="config_sync_failed"
    )
    assert check_failed.message.startswith("Could not check remote config checksum")
    assert "error" in check_failed.details
    server.wait_for_watcher_status(pc.watcher_id, "watching")
    assert server.events(pc.watcher_id, event_type="config_synced") == []
    assert pc.stop() == 0

    # The check works and the push fails.
    with proxy.fault("status", method="PUT", path=r"/config$", status=503, count=1):
        pc.start()
    failures = server.wait_for_events(
        pc.watcher_id, event_type="error", kind="config_sync_failed", count=2
    )
    push_failed = failures[1]
    assert push_failed.message.startswith("Could not push config to API")
    assert push_failed.details["checksum"]
    assert "error" in push_failed.details
    assert server.events(pc.watcher_id, event_type="config_synced") == []
    assert pc.is_running()


@pytest.mark.covers("event.stability_timeout->emitted")
def test_a_file_that_never_stops_changing_is_given_up_on(
    watcher: WatcherFactory, server: ServerView, instrument_id: str, watch_dir: Path
) -> None:
    pc = watcher(stability_period_seconds=2, max_stability_wait_seconds=3)
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")

    live = watch_dir / "RUN001" / "live.csv"
    with GrowingFile(live):
        timeout = server.wait_for_event(
            pc.watcher_id, event_type="error", kind="stability_timeout", timeout=30
        )
    assert timeout.message == "File live.csv did not stabilise within 3s"
    assert Path(timeout.details["path"]) == live
    assert timeout.details["max_wait_seconds"] == 3
    # It was never reported.
    assert server.runs(instrument_id) == []


@pytest.mark.covers("event.stable_callback_failed->emitted")
def test_a_file_that_vanishes_between_its_run_report_and_its_upload_is_reported(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher()
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")

    gone = watch_dir / "RUN001" / "gone.csv"
    # Hold the run report, so the file can be removed after the watcher found it stable and
    # before it gets to upload it.
    with proxy.fault(
        "delay", method="POST", path=r"/instruments/[^/]+/runs$", delay_seconds=3, count=1
    ):
        write_file(gone, SMALL)
        proxy.wait_for_request(lambda r: r.fault_mode == "delay" and r.path.endswith("/runs"), 30)
        gone.unlink()
        failed = server.wait_for_event(
            pc.watcher_id, event_type="error", kind="stable_callback_failed", timeout=30
        )
    assert failed.message.startswith("Stable-file callback failed for gone.csv: ")
    assert Path(failed.details["path"]) == gone
    assert "gone.csv" in failed.details["error"]
    # The run was reported before the upload failed.
    server.wait_for_run(instrument_id, "RUN001")


@pytest.mark.covers("event.pattern_mismatch->emitted")
def test_files_the_run_pattern_does_not_match_are_reported_once_per_folder(
    watcher: WatcherFactory, server: ServerView, instrument_id: str, watch_dir: Path
) -> None:
    # Only folders called `run_<name>` are runs.
    pc = watcher(run_pattern=r"^run_([^/]+)/")
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")

    write_file(watch_dir / "other" / "a.csv", SMALL)
    write_file(watch_dir / "other" / "b.csv", SMALL)
    write_file(watch_dir / "misc" / "c.csv", SMALL)
    mismatches = server.wait_for_events(
        pc.watcher_id, event_type="error", kind="pattern_mismatch", count=2
    )
    by_folder = {Path(e.details["relative_path"]).parent.as_posix(): e for e in mismatches}
    assert set(by_folder) == {"other", "misc"}
    assert by_folder["misc"].details == {
        "kind": "pattern_mismatch",
        "relative_path": "misc/c.csv",
    }
    assert by_folder["other"].message.startswith("File other/")
    assert by_folder["other"].message.endswith(" did not match run_detection.pattern")

    # A file that does match is reported as usual, and nothing more was said about the
    # second file of `other`.
    write_file(watch_dir / "run_1" / "ok.csv", SMALL)
    server.wait_for_run(instrument_id, "1")
    server.wait_for_event(pc.watcher_id, event_type="run_reported")
    assert len(server.events(pc.watcher_id, kind="pattern_mismatch")) == 2


@pytest.mark.covers("event.upload_failed->emitted")
def test_a_failed_upload_to_storage_is_reported_with_its_error_and_key(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher()
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")

    with proxy.fault("status", method="PUT", path=r"/api/local-s3/", status=503):
        write_run(watch_dir, "RUN001", {"small.csv": SMALL})
        # Three attempts, with 1, 2 and 4 seconds between them.
        failed = server.wait_for_event(
            pc.watcher_id, event_type="upload_failed", timeout=45, message_contains="small.csv"
        )
    assert failed.message == "Upload failed: small.csv"
    assert failed.details["s3_key"] == f"{instrument_id}/RUN001/small.csv"
    assert "503" in failed.details["error"]
    assert not server.object_exists(instrument_id, "RUN001", "small.csv")
    row = server.file(instrument_id, "RUN001", "RUN001/small.csv")
    assert row is not None and row.status != "uploaded"
    assert server.events(pc.watcher_id, event_type="file_uploaded") == []


@pytest.mark.covers("event.pending_upload_missing->emitted")
def test_an_upload_that_failed_is_dropped_at_the_next_start_when_its_file_is_gone(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher()
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")

    # The upload link can't be had, so the upload fails and is left to be retried.
    with proxy.fault("status", method="POST", path=r"/request-upload-url$", status=503):
        write_run(watch_dir, "RUN001", {"small.csv": SMALL})
        failed = server.wait_for_event(
            pc.watcher_id, event_type="upload_failed", message_contains="small.csv"
        )
    assert failed.message == "Presigned URL request failed: small.csv"
    assert pc.stop() == 0

    (watch_dir / "RUN001" / "small.csv").unlink()
    pc.start()
    missing = server.wait_for_event(
        pc.watcher_id, event_type="error", kind="pending_upload_missing"
    )
    assert missing.details == {
        "kind": "pending_upload_missing",
        "relative_path": "RUN001/small.csv",
        "run_id": "RUN001",
    }
    assert missing.message == "Stopped retrying small.csv: the file is no longer on disk"
    # It was dropped, so the next start has nothing to retry.
    assert pc.state_query("SELECT count(*) FROM pending_uploads") == [(0,)]


@pytest.mark.covers("event.upload_retries_exhausted->emitted")
def test_an_upload_that_keeps_failing_is_given_up_after_three_retries(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher()
    with proxy.fault("status", method="POST", path=r"/request-upload-url$", status=503):
        pc.start()
        server.wait_for_watcher_status(pc.watcher_id, "watching")
        write_run(watch_dir, "RUN001", {"small.csv": SMALL})
        server.wait_for_event(pc.watcher_id, event_type="upload_failed")

        # Every start retries it once, and each retry fails the same way. The third failed
        # retry is the last.
        for retry in (1, 2):
            pc.restart()
            server.wait_for_events(pc.watcher_id, event_type="upload_failed", count=retry + 1)
            assert server.events(pc.watcher_id, kind="upload_retries_exhausted") == []
        pc.restart()
        exhausted = server.wait_for_event(
            pc.watcher_id, event_type="error", kind="upload_retries_exhausted"
        )

    assert exhausted.details == {
        "kind": "upload_retries_exhausted",
        "relative_path": "RUN001/small.csv",
        "run_id": "RUN001",
        "attempts": 3,
    }
    assert exhausted.message.startswith("Gave up uploading small.csv after 3 watcher starts")
    assert pc.state_query("SELECT count(*) FROM pending_uploads") == [(0,)]
    row = server.file(instrument_id, "RUN001", "RUN001/small.csv")
    assert row is not None and row.status != "uploaded"


@pytest.mark.covers(
    "event.upload_queue_poll_failed->emitted",
    "event.upload_requests_cancelled->recorded",
)
def test_an_unreadable_upload_queue_is_reported_once_and_a_stop_reverts_the_request(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    admin: Admin,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher(upload_mode="manual")
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")
    write_run(watch_dir, "RUN001", {"small.csv": SMALL})
    detected = server.wait_for_file(instrument_id, "RUN001", "RUN001/small.csv", status="detected")

    def refused_polls() -> int:
        return sum(
            1
            for r in proxy.requests
            if r.method == "GET" and r.path.endswith("/upload-queue") and r.fault_mode == "status"
        )

    with proxy.fault("status", method="GET", path=r"/upload-queue$", status=503):
        first = server.wait_for_event(
            pc.watcher_id, event_type="error", kind="upload_queue_poll_failed"
        )
        assert first.details["consecutive_failures"] == 1
        assert first.message.startswith("Failed to fetch upload queue: ")
        assert "error" in first.details

        # An admin asks for the file, and the watcher can't read the request.
        admin.request_upload(instrument_id, "RUN001", [detected.id]).raise_for_status()
        refused = refused_polls()
        wait_until(
            lambda: refused_polls() >= refused + 3,
            30,
            lambda: server.dump(pc.watcher_id),
            what="three more refused queue polls",
        )
        row = server.file(instrument_id, "RUN001", "RUN001/small.csv")
        assert row is not None and row.status == "upload_requested"
        # Only the first failure of a row is reported, then every tenth.
        assert len(server.events(pc.watcher_id, kind="upload_queue_poll_failed")) == 1

        # A graceful stop tells the server the watcher can't upload what was asked for.
        assert pc.stop() == 0

    reverted = server.wait_for_event(
        pc.watcher_id, event_type="watcher_stopped", kind="upload_requests_cancelled"
    )
    assert reverted.details["reason"] == "watcher_stopped"
    assert reverted.details["cancelled_count"] == 1
    assert "Reverted 1 pending upload request(s)" in reverted.message
    row = server.file(instrument_id, "RUN001", "RUN001/small.csv")
    assert row is not None and row.status == "detected"


@pytest.mark.covers(
    "event.queued_file_missing->emitted",
    "event.upload_request_cancelled->emitted",
)
def test_a_requested_file_that_is_not_on_disk_is_reported_and_the_request_cancelled(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher(upload_mode="manual")
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")
    write_run(watch_dir, "RUN001", {"gone.csv": SMALL})
    detected = server.wait_for_file(instrument_id, "RUN001", "RUN001/gone.csv", status="detected")

    (watch_dir / "RUN001" / "gone.csv").unlink()
    admin.request_upload(instrument_id, "RUN001", [detected.id]).raise_for_status()

    missing = server.wait_for_event(pc.watcher_id, event_type="error", kind="queued_file_missing")
    assert missing.details["file_id"] == detected.id
    assert Path(missing.details["expected_path"]) == watch_dir / "RUN001" / "gone.csv"
    assert missing.message == "Queued file missing: gone.csv"

    # After three polls the watcher gives up and puts the file back to `detected`.
    cancelled = server.wait_for_event(
        pc.watcher_id, event_type="error", kind="upload_request_cancelled", timeout=30
    )
    assert cancelled.details == {
        "kind": "upload_request_cancelled",
        "file_id": detected.id,
        "attempts": 3,
        "reason": "missing",
    }
    row = server.wait_for_file(instrument_id, "RUN001", "RUN001/gone.csv", status="detected")
    assert row.id == detected.id
    # The missing file was reported on the first poll only.
    assert len(server.events(pc.watcher_id, kind="queued_file_missing")) == 1


@pytest.mark.covers("event.unsafe_upload_path->emitted")
def test_a_queued_path_outside_the_watch_folder_is_refused_and_reported(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher(upload_mode="manual")
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")
    write_run(watch_dir, "RUN001", {"a.csv": SMALL})
    detected = server.wait_for_file(instrument_id, "RUN001", "RUN001/a.csv", status="detected")
    # The routes refuse such a path, so put one in the way a bad row would get there.
    server.execute(
        "UPDATE files SET relative_path = %s WHERE id = %s", ("../outside.csv", detected.id)
    )
    admin.request_upload(instrument_id, "RUN001", [detected.id]).raise_for_status()

    unsafe = server.wait_for_event(pc.watcher_id, event_type="error", kind="unsafe_upload_path")
    assert unsafe.details == {
        "kind": "unsafe_upload_path",
        "file_id": detected.id,
        "relative_path": "../outside.csv",
    }
    assert unsafe.message.startswith("Rejected unsafe upload path")
    # The request is cancelled, not retried, and nothing was uploaded.
    server.wait_until(
        lambda: [f.status for f in server.files(instrument_id, "RUN001")] == ["detected"],
        30,
        what="the unsafe request to be cancelled",
        watcher_id=pc.watcher_id,
        instrument_id=instrument_id,
    )
    assert server.events(pc.watcher_id, event_type="file_uploaded") == []


@pytest.mark.covers(
    "event.watch_directory_unavailable->emitted",
    "event.watcher_started->emitted",
)
def test_a_missing_watch_folder_is_reported_and_resuming_says_so(
    watcher: WatcherFactory, server: ServerView, tmp_path: Path
) -> None:
    pc = watcher(watch_dir=tmp_path / "instrument-share", create_watch_dir=False)
    pc.start()

    unavailable = server.wait_for_event(
        pc.watcher_id, event_type="error", kind="watch_directory_unavailable"
    )
    reason = f"watch_directory not found: {pc.watch_dir}"
    assert unavailable.details == {
        "kind": "watch_directory_unavailable",
        "watch_directory": str(pc.watch_dir),
        "reason": reason,
    }
    assert unavailable.message == f"Waiting: {reason}"
    started = server.wait_for_event(pc.watcher_id, event_type="watcher_started")
    assert started.message.startswith(pc.started_prefix)

    # The reason changes when a file sits where the folder should be: it is reported again,
    # with the new reason. The same reason is not reported twice.
    pc.watch_dir.write_text("not a folder")
    changed = server.wait_for_events(
        pc.watcher_id, event_type="error", kind="watch_directory_unavailable", count=2
    )[1]
    assert changed.details["reason"] == f"watch_directory is not a folder: {pc.watch_dir}"

    # The folder appears. The watcher starts watching and says it resumed.
    pc.watch_dir.unlink()
    pc.watch_dir.mkdir()
    resumed = server.wait_for_events(pc.watcher_id, event_type="watcher_started", count=2)[1]
    assert resumed.message.startswith(pc.resumed_prefix)
    assert len(server.events(pc.watcher_id, kind="watch_directory_unavailable")) == 2


@pytest.mark.covers("event.update_check_failed->emitted")
def test_three_failed_update_checks_in_a_row_are_reported_once(
    watcher: WatcherFactory, server: ServerView, proxy: FaultProxy
) -> None:
    # Check on every tick, so three failures take three ticks.
    pc = watcher(overrides={testing_overrides.UPDATE_CHECK_INTERVAL_TICKS_ENV_VAR: "1"})
    with proxy.fault("status", method="GET", path=r"/update-check$", status=503):
        pc.start()
        failed = server.wait_for_event(
            pc.watcher_id, event_type="error", kind="update_check_failed", timeout=30
        )
        # Two more failed checks go by: it is said once, on the third.
        after = server.last_heartbeat_id(pc.watcher_id)
        server.wait_for_heartbeats(pc.watcher_id, count=2, after_id=after)
    assert failed.details["consecutive_failures"] == 3
    assert "error" in failed.details
    assert failed.message.startswith("Update check failed for 3 consecutive attempts: ")
    assert len(server.events(pc.watcher_id, kind="update_check_failed")) == 1


@pytest.mark.covers(
    "event.config_revision_applied->recorded",
    "event.config_revision_rejected->recorded",
)
def test_the_server_records_a_config_revision_the_watcher_applied_and_one_it_rejected(
    watcher: WatcherFactory, server: ServerView, admin: Admin, tmp_path: Path
) -> None:
    pc = watcher()
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")

    # A change the watcher can follow: it rebuilds, reports the revision as applied, and
    # pushes the config it now has.
    saved = admin.save_config_revision(
        pc.watcher_id, pc.revision_settings(upload_mode="manual")
    ).raise_for_status()
    revision = int(saved.body["revision"])
    applied = server.wait_for_event(
        pc.watcher_id, event_type="config_synced", kind="config_revision_applied", timeout=30
    )
    assert applied.details == {"kind": "config_revision_applied", "revision": revision}
    assert applied.message == f"Applied config revision {revision}"
    pushed = [
        e
        for e in server.wait_for_events(
            pc.watcher_id, event_type="config_synced", message_contains="trigger=", count=2
        )
        if e.details.get("trigger") == "config_revision"
    ]
    assert len(pushed) == 1

    # A change the watcher can't follow, because the folder isn't there.
    nowhere = tmp_path / "nowhere"
    saved = admin.save_config_revision(
        pc.watcher_id, pc.revision_settings(watch_directory=str(nowhere))
    ).raise_for_status()
    rejected_revision = int(saved.body["revision"])
    rejected = server.wait_for_event(
        pc.watcher_id, event_type="error", kind="config_revision_rejected", timeout=30
    )
    assert rejected.details["revision"] == rejected_revision
    assert str(nowhere) in rejected.details["reason"]
    assert rejected.message.startswith(f"Rejected config revision {rejected_revision}: ")
    # It keeps what it has.
    assert pc.is_running()
    assert server.watcher(pc.watcher_id).status == "watching"


@pytest.mark.covers(
    "event.update_failed->emitted",
    "event.update_started->emitted",
    "event.update_succeeded->emitted",
)
def test_a_failed_update_and_then_a_successful_one_are_reported(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    package_index: LocalPackageIndex,
    bumped_wheel: Path,
    bumped_version: str,
    current_version: str,
) -> None:
    pc = watcher(
        own_install=True,
        index_url=package_index.url,
        overrides={testing_overrides.UPDATE_CHECK_INTERVAL_TICKS_ENV_VAR: "1"},
    )

    # The release is mandatory and the index is down: the install fails.
    package_index.set_project_unavailable("data-hub-watcher")
    admin.set_release(bumped_version, mandatory=True).raise_for_status()
    pc.start()
    failed = server.wait_for_event(pc.watcher_id, event_type="update_failed", timeout=120)
    assert failed.details["current_version"] == current_version
    assert failed.details["target_version"] == bumped_version
    assert failed.message.startswith(f"Watcher upgrade to {bumped_version} failed")
    started = server.wait_for_event(pc.watcher_id, event_type="update_started")
    assert started.details["target_version"] == bumped_version
    assert started.details["current_version"] == current_version
    assert started.details["mandatory"] is True
    # It keeps running on the old version.
    assert pc.is_running()
    assert server.watcher(pc.watcher_id).watcher_version == current_version

    # The index is back: the next check installs the release and the watcher is started
    # again (by the driver on the CLI, by the upgrade worker for the service).
    package_index.clear_unavailable()
    pc.await_upgrade_restart(180)
    stopped = server.wait_for_event(
        pc.watcher_id, event_type="watcher_stopped", message_contains=pc.update_stop_message
    )
    assert stopped.message == pc.update_stop_message

    # The restarted process reports that it runs the new version.
    succeeded = server.wait_for_event(pc.watcher_id, event_type="update_succeeded")
    assert succeeded.details["previous_version"] == current_version
    assert succeeded.details["target_version"] == bumped_version
    assert bumped_version in succeeded.message
    row = server.wait_for_watcher_status(pc.watcher_id, "watching")
    assert row.watcher_version == bumped_version
