"""From a file appearing in the watch folder to a run reported to the server.

Each test starts the real watcher, puts files into its watch folder the way an instrument does,
and checks what the server ends up with: the runs, the file rows, the events. Most use manual
upload mode, so a file is done when the server lists it as ``detected``. Where a test has to
show that something did *not* happen (an ignored file, a deleted file, a changed file), it first
waits for something that must happen after it (a file written later, in the same folder), then
watches the server for a short while with ``stays_true``.

The tests assert outcomes, such as what the server holds, and never which filesystem events the
watcher got, because the same assertions run on FSEvents (macOS) and on inotify (Linux CI).
"""

from __future__ import annotations
import hashlib
from pathlib import Path
from typing import Literal

import pytest

from data_hub_shared.testing_proxy import FaultProxy, RecordedRequest
from data_hub_watcher.constants import RUN_REPORT_RETRY_BASE_DELAY_SECONDS
from e2e_support.admin import Admin
from e2e_support.drivers import WatcherDriver
from e2e_support.factory import WatcherFactory
from e2e_support.files import LARGE, SMALL, GrowingFile, payload, write_file, write_run
from e2e_support.proxy_helpers import wait_for_answer
from e2e_support.server import EventRow, ServerView
from e2e_support.waiting import KnownBugStillPresent, known_bug, stays_true, wait_until

pytestmark = pytest.mark.e2e

# The wait before the first retry of a failed run report. It doubles with every failure.
RETRY_BASE_DELAY_SECONDS = RUN_REPORT_RETRY_BASE_DELAY_SECONDS


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def run_reports(proxy: FaultProxy, instrument_id: str) -> list[RecordedRequest]:
    """The watcher's run POSTs and PATCHes, oldest first, from the proxy's log."""
    runs_path = f"/api/v1/instruments/{instrument_id}/runs"
    found: list[RecordedRequest] = []
    for request in proxy.requests:
        path = request.path.split("?", 1)[0]
        if (request.method == "POST" and path == runs_path) or (
            request.method == "PATCH" and path.startswith(runs_path + "/")
        ):
            found.append(request)
    return found


def data_requests(proxy: FaultProxy) -> list[tuple[str, str]]:
    """Everything the watcher sent about runs, files and uploads, as ``(method, path)``.

    Heartbeats, events, config and queue polls all live under ``/watchers/`` and are left out,
    so this list only grows when the watcher reports or uploads something.
    """
    return [
        (r.method, r.path.split("?", 1)[0])
        for r in proxy.requests
        if r.method != "GET" and "/watchers/" not in r.path
    ]


def error_events(server: ServerView, watcher_id: str, kind: str | None = None) -> list[EventRow]:
    return server.events(watcher_id, event_type="error", kind=kind)


def relative_paths(server: ServerView, instrument_id: str, run_id: str) -> list[str]:
    """The relative paths of the run's active files, sorted."""
    return sorted(f.relative_path or f.filename for f in server.files(instrument_id, run_id))


def run_names(server: ServerView, instrument_id: str) -> list[str]:
    return sorted(r.run_id for r in server.runs(instrument_id))


def wait_for_run_file(
    server: ServerView,
    instrument_id: str,
    run_id: str,
    name: str,
    upload_mode: str,
    content: bytes,
) -> None:
    """Wait for ``<run_id>/<name>`` to be done: uploaded in auto mode, or reported as
    ``detected`` in manual mode (which leaves the file on the PC)."""
    if upload_mode == "auto":
        server.wait_for_uploaded(instrument_id, run_id, f"{run_id}/{name}", content=content)
    else:
        server.wait_for_file(instrument_id, run_id, f"{run_id}/{name}", status="detected")


def has_recorded_files(pc: WatcherDriver, upload_mode: str, count: int) -> bool:
    """Whether the watcher's state database holds its record of ``count`` files: uploaded, with
    nothing left to retry, in auto mode, and reported (``detected_files``) in manual mode."""
    if upload_mode == "auto":
        return pc.state_query("SELECT count(*) FROM pending_uploads") == [(0,)] and (
            pc.state_query("SELECT count(*) FROM uploaded_files") == [(count,)]
        )
    return pc.state_query("SELECT count(*) FROM detected_files") == [(count,)]


def forget(pc: WatcherDriver, prefix: str) -> None:
    """``data-hub-watcher state forget``: make the PC report the folder's files again.

    The watcher must be stopped. This is what an operator does to get files reported again.
    """
    result = pc.run_cli("state", "forget", "--prefix", prefix, "--yes")
    assert result.returncode == 0, result.output


# ---------------------------------------------------------------------------
# A file in the watch folder
# ---------------------------------------------------------------------------


@pytest.mark.covers(
    "file.new->pending",
    "file.pending->stable",
    "run.first_file->reported",
    "event.run_reported->emitted",
)
def test_a_new_file_is_reported_as_a_run_once_it_is_stable(
    watcher: WatcherFactory, server: ServerView, instrument_id: str, watch_dir: Path
) -> None:
    # A long stability period, so the file is visibly pending before it is reported.
    pc = watcher(upload_mode="manual", stability_period_seconds=4)
    pc.start()

    content = write_file(watch_dir / "RUN001" / "plate.csv", SMALL)
    stays_true(
        lambda: not server.runs(instrument_id),
        2.5,
        lambda: server.dump(pc.watcher_id, instrument_id),
        what="no run while the file is still pending",
    )

    run = server.wait_for_run(instrument_id, "RUN001")
    assert run.source == "watcher"
    assert run.watcher_id == pc.watcher_id

    row = server.wait_for_file(instrument_id, "RUN001", "RUN001/plate.csv", status="detected")
    assert row.filename == "plate.csv"
    assert row.size_bytes == len(content)
    # Manual mode reports the file and leaves it on the PC.
    assert not server.object_exists(instrument_id, "RUN001", "plate.csv")
    assert server.run_status(instrument_id, "RUN001") == "pending"

    reported = server.wait_for_event(pc.watcher_id, event_type="run_reported")
    assert reported.message == "Run RUN001 reported"
    assert reported.details == {"run_id": "RUN001"}


@pytest.mark.covers("file.new->ignored_pattern")
def test_files_that_match_no_pattern_are_ignored(
    watcher: WatcherFactory, server: ServerView, instrument_id: str, watch_dir: Path
) -> None:
    pc = watcher(upload_mode="manual", file_patterns=("*.csv", "*.tsv"))
    # One ignored file is there when the watcher starts, so the initial scan sees it too.
    write_file(watch_dir / "BEFORE" / "notes.txt")
    pc.start()

    write_file(watch_dir / "RUN001" / "readme.txt")
    write_file(watch_dir / "RUN001" / "photo.png")
    # Both patterns work, and these files, written last, are the barrier.
    write_file(watch_dir / "RUN002" / "a.tsv")
    write_file(watch_dir / "RUN002" / "b.csv")
    server.wait_for_file(instrument_id, "RUN002", "RUN002/a.tsv", status="detected")
    server.wait_for_file(instrument_id, "RUN002", "RUN002/b.csv", status="detected")

    def only_the_matching_files() -> bool:
        return run_names(server, instrument_id) == ["RUN002"] and not error_events(
            server, pc.watcher_id
        )

    stays_true(
        only_the_matching_files,
        2.5,
        lambda: server.dump(pc.watcher_id, instrument_id),
        what="no run, file row or error event for a file that matches no pattern",
    )
    assert relative_paths(server, instrument_id, "RUN002") == ["RUN002/a.tsv", "RUN002/b.csv"]


@pytest.mark.covers("file.pending->pending_growing", "file.pending->stable")
def test_a_growing_file_is_not_reported_until_it_stops_growing(
    watcher: WatcherFactory, server: ServerView, instrument_id: str, watch_dir: Path
) -> None:
    # A write every second (the default of `GrowingFile`) never leaves the file quiet for the
    # 3-second stability period: 2 s of margin.
    pc = watcher(upload_mode="manual", stability_period_seconds=3)
    pc.start()

    live = watch_dir / "RUN001" / "live.csv"
    with GrowingFile(live) as growing:
        # Longer than the stability period: a file that was not tracked would be reported by now.
        stays_true(
            lambda: not server.runs(instrument_id),
            5,
            lambda: server.dump(pc.watcher_id, instrument_id),
            what="no run while the file keeps growing",
        )
        assert growing.size > 20  # It really was growing during that window.
    final = live.read_bytes()

    # Once it stops, it is reported at its final size.
    row = server.wait_for_file(instrument_id, "RUN001", "RUN001/live.csv", status="detected")
    assert row.size_bytes == len(final)


@pytest.mark.covers("file.pending->abandoned_timeout", "event.stability_timeout->emitted")
def test_a_file_that_never_settles_is_abandoned_with_an_error_event(
    watcher: WatcherFactory, server: ServerView, instrument_id: str, watch_dir: Path
) -> None:
    pc = watcher(upload_mode="manual", stability_period_seconds=3, max_stability_wait_seconds=6)
    pc.start()

    live = watch_dir / "RUN001" / "live.csv"
    # A write every second (the default of `GrowingFile`, which says why not faster): inside the
    # 3-second stability period, so the file is never quiet long enough to be stable, and only
    # the 6-second timeout ends its wait.
    with GrowingFile(live):
        event = server.wait_for_event(
            pc.watcher_id, event_type="error", kind="stability_timeout", timeout=40
        )
        # It is still changing, and nothing was reported for it.
        assert not server.runs(instrument_id)
    assert Path(event.details["path"]) == live
    assert event.details["max_wait_seconds"] == 6
    assert event.message == "File live.csv did not stabilise within 6s"

    # Being abandoned is not forever: the last write put the file back on the list, and once
    # the file stops changing it is reported at its final size.
    final = live.read_bytes()
    row = server.wait_for_file(instrument_id, "RUN001", "RUN001/live.csv", status="detected")
    assert row.size_bytes == len(final)


@pytest.mark.covers("file.pending->vanished")
def test_a_file_deleted_while_pending_is_dropped_without_an_event(
    watcher: WatcherFactory, server: ServerView, instrument_id: str, watch_dir: Path
) -> None:
    pc = watcher(upload_mode="manual", stability_period_seconds=4)
    pc.start()

    gone = watch_dir / "GONE" / "temp.csv"
    write_file(gone)
    # Let the watcher see it and start its stability clock, then take it away.
    stays_true(
        lambda: not server.runs(instrument_id),
        1.5,
        what="the file waits out its stability period",
    )
    gone.unlink()

    write_file(watch_dir / "KEPT" / "ok.csv")
    server.wait_for_file(instrument_id, "KEPT", "KEPT/ok.csv", status="detected")
    stays_true(
        lambda: (
            run_names(server, instrument_id) == ["KEPT"] and not error_events(server, pc.watcher_id)
        ),
        2.5,
        lambda: server.dump(pc.watcher_id, instrument_id),
        what="no run and no error event for a file that vanished",
    )


@pytest.mark.covers(
    "file.stable->pattern_mismatch",
    "file.pattern_mismatch->throttled_per_folder",
    "event.pattern_mismatch->emitted",
)
def test_a_pattern_mismatch_is_reported_once_per_folder(
    watcher: WatcherFactory, server: ServerView, instrument_id: str, watch_dir: Path
) -> None:
    # A run is the first folder, and only files below its `data` folder belong to it.
    pc = watcher(upload_mode="manual", run_pattern=r"^([^/]+)/data/")
    pc.start()

    write_file(watch_dir / "RUN_A" / "other" / "first.csv")
    first = server.wait_for_event(pc.watcher_id, event_type="error", kind="pattern_mismatch")
    assert first.details["relative_path"] == "RUN_A/other/first.csv"
    assert first.message == "File RUN_A/other/first.csv did not match run_detection.pattern"

    # The same folder again (throttled), another folder (reported), and a file that matches.
    write_file(watch_dir / "RUN_A" / "other" / "second.csv")
    write_file(watch_dir / "RUN_B" / "other" / "third.csv")
    write_file(watch_dir / "RUN_C" / "data" / "ok.csv")
    server.wait_for_file(instrument_id, "RUN_C", "RUN_C/data/ok.csv", status="detected")
    server.wait_for_events(pc.watcher_id, event_type="error", kind="pattern_mismatch", count=2)

    def one_event_per_folder() -> bool:
        mismatches = error_events(server, pc.watcher_id, "pattern_mismatch")
        folders = [Path(e.details["relative_path"]).parent.as_posix() for e in mismatches]
        return sorted(folders) == ["RUN_A/other", "RUN_B/other"]

    stays_true(
        one_event_per_folder,
        2.5,
        lambda: server.dump(pc.watcher_id, instrument_id),
        what="one pattern_mismatch event per folder",
    )
    # The mismatching files started no run.
    assert run_names(server, instrument_id) == ["RUN_C"]


# ---------------------------------------------------------------------------
# Recursive and non-recursive watching
# ---------------------------------------------------------------------------


@pytest.mark.covers("monitor.recursive->subfolders_watched")
def test_recursive_mode_detects_files_in_subfolders(
    watcher: WatcherFactory, server: ServerView, instrument_id: str, watch_dir: Path
) -> None:
    pc = watcher(upload_mode="manual", recursive=True)
    # One nested file is there at the start (the scan finds it), the others arrive in folders
    # that don't exist yet.
    write_file(watch_dir / "RUN001" / "day1" / "early.csv")
    pc.start()
    write_file(watch_dir / "RUN001" / "day2" / "well" / "deep.csv")
    write_file(watch_dir / "RUN001" / "top.csv")

    for path in ("day1/early.csv", "day2/well/deep.csv", "top.csv"):
        server.wait_for_file(instrument_id, "RUN001", f"RUN001/{path}", status="detected")
    assert run_names(server, instrument_id) == ["RUN001"]


@pytest.mark.covers("monitor.non_recursive->subfolders_ignored")
def test_non_recursive_mode_ignores_subfolders(
    watcher: WatcherFactory, server: ServerView, instrument_id: str, watch_dir: Path
) -> None:
    # The run is the part of the file name before the first underscore, in whichever folder the
    # file is, so a file in a subfolder would start a run if the watcher looked there.
    pc = watcher(upload_mode="manual", recursive=False, run_pattern=r"^(?:.*/)?([^_/]+)_[^/]*$")
    write_file(watch_dir / "nested" / "BEFORE_data.csv")
    write_file(watch_dir / "RUNA_data.csv")
    pc.start()

    write_file(watch_dir / "nested" / "AFTER_data.csv")
    write_file(watch_dir / "RUNB_data.csv")  # The barrier, written last.
    server.wait_for_file(instrument_id, "RUNA", "RUNA_data.csv", status="detected")
    server.wait_for_file(instrument_id, "RUNB", "RUNB_data.csv", status="detected")

    stays_true(
        lambda: run_names(server, instrument_id) == ["RUNA", "RUNB"],
        2.5,
        lambda: server.dump(pc.watcher_id, instrument_id),
        what="no run for the files in the subfolder",
    )


# ---------------------------------------------------------------------------
# What happens to a file after its run was reported
# ---------------------------------------------------------------------------


@pytest.mark.covers("file.reported->delete_ignored")
def test_deleting_a_reported_file_changes_nothing(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher()
    pc.start()
    data = write_run(watch_dir, "RUN001", {"a.csv": SMALL, "b.csv": SMALL})
    uploaded = server.wait_for_uploaded(
        instrument_id, "RUN001", "RUN001/a.csv", content=data["a.csv"]
    )
    server.wait_for_uploaded(instrument_id, "RUN001", "RUN001/b.csv", content=data["b.csv"])
    sent_before = data_requests(proxy)

    (watch_dir / "RUN001" / "a.csv").unlink()

    def nothing_changed() -> bool:
        row = server.file(instrument_id, "RUN001", "RUN001/a.csv")
        return (
            row is not None
            and row.status == "uploaded"
            and row.deleted_at is None
            and row.uploaded_at == uploaded.uploaded_at
            and server.read_object(instrument_id, "RUN001", "a.csv") == data["a.csv"]
            and not server.runs(instrument_id)[0].deleted_at
            and data_requests(proxy) == sent_before
        )

    stays_true(
        nothing_changed,
        4,
        lambda: server.dump(pc.watcher_id, instrument_id),
        what="the server keeps the deleted file's row and bytes, and the watcher sends nothing",
    )
    assert not error_events(server, pc.watcher_id)

    # The watcher carries on: a new file in the same run is uploaded.
    later = write_file(watch_dir / "RUN001" / "c.csv", SMALL)
    server.wait_for_uploaded(instrument_id, "RUN001", "RUN001/c.csv", content=later)


@pytest.mark.covers("file.reported->rename_ignored")
def test_renaming_a_reported_file_is_not_noticed(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher(upload_mode="manual")
    pc.start()
    write_file(watch_dir / "RUN001" / "a.csv")
    server.wait_for_file(instrument_id, "RUN001", "RUN001/a.csv", status="detected")
    reports_before = len(run_reports(proxy, instrument_id))

    (watch_dir / "RUN001" / "a.csv").rename(watch_dir / "RUN001" / "renamed.csv")
    write_file(watch_dir / "RUN001" / "after.csv")  # The barrier, written last.
    server.wait_for_file(instrument_id, "RUN001", "RUN001/after.csv", status="detected")

    stays_true(
        lambda: (
            relative_paths(server, instrument_id, "RUN001") == ["RUN001/a.csv", "RUN001/after.csv"]
        ),
        3,
        lambda: server.dump(pc.watcher_id, instrument_id),
        what="the renamed file is not reported under its new name",
    )
    # The only update the watcher sent was for the barrier file.
    assert len(run_reports(proxy, instrument_id)) == reports_before + 1
    assert not error_events(server, pc.watcher_id)


@pytest.mark.covers("file.reported->change_not_reuploaded")
def test_a_changed_file_is_not_reported_or_uploaded_again(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher()
    pc.start()
    path = watch_dir / "RUN001" / "a.csv"
    original = write_file(path, SMALL)
    row = server.wait_for_uploaded(instrument_id, "RUN001", "RUN001/a.csv", content=original)
    stored_at = server.object_path(instrument_id, "RUN001", "a.csv").stat().st_mtime_ns
    sent_before = data_requests(proxy)

    def untouched() -> bool:
        now = server.file(instrument_id, "RUN001", "RUN001/a.csv")
        return (
            now is not None
            and now.status == "uploaded"
            and now.uploaded_at == row.uploaded_at
            and now.size_bytes == row.size_bytes
            and server.read_object(instrument_id, "RUN001", "a.csv") == original
            and server.object_path(instrument_id, "RUN001", "a.csv").stat().st_mtime_ns == stored_at
        )

    # The file changes while the watcher runs: instrument output is write-once.
    write_file(path, payload(SMALL + 100, seed=7))
    stays_true(
        lambda: untouched() and data_requests(proxy) == sent_before,
        4,
        lambda: server.dump(pc.watcher_id, instrument_id),
        what="a changed file is neither reported nor uploaded again",
    )

    # And after a restart, whose scan finds the file with a size the state database doesn't know.
    pc.restart()
    later = write_file(watch_dir / "RUN002" / "b.csv", SMALL)  # The barrier.
    server.wait_for_uploaded(instrument_id, "RUN002", "RUN002/b.csv", content=later)
    assert untouched()
    assert len(server.runs(instrument_id)) == 2
    assert len(server.wait_for_events(pc.watcher_id, event_type="run_reported", count=2)) == 2
    assert len(server.wait_for_events(pc.watcher_id, event_type="file_uploaded", count=2)) == 2


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------


@pytest.mark.covers("run.multi_file->grouped")
def test_files_with_the_same_run_id_reach_the_server_as_one_run(
    watcher: WatcherFactory, server: ServerView, instrument_id: str, watch_dir: Path
) -> None:
    pc = watcher(upload_mode="manual")
    pc.start()
    write_run(watch_dir, "RUN001", {"a.csv": SMALL, "b.csv": SMALL, "c.csv": LARGE})
    write_run(watch_dir, "RUN002", {"d.csv": SMALL})

    for run_id, name in (("RUN001", "a"), ("RUN001", "b"), ("RUN001", "c"), ("RUN002", "d")):
        server.wait_for_file(instrument_id, run_id, f"{run_id}/{name}.csv", status="detected")

    assert run_names(server, instrument_id) == ["RUN001", "RUN002"]
    assert relative_paths(server, instrument_id, "RUN001") == [
        "RUN001/a.csv",
        "RUN001/b.csv",
        "RUN001/c.csv",
    ]
    assert relative_paths(server, instrument_id, "RUN002") == ["RUN002/d.csv"]
    # One run_reported event per run, however many files it has.
    reported = server.wait_for_events(pc.watcher_id, event_type="run_reported", count=2)
    assert sorted(e.details["run_id"] for e in reported) == ["RUN001", "RUN002"]


@pytest.mark.covers("file.same_name_in_two_folders->stored_apart")
@pytest.mark.parametrize("upload_mode", ["manual", "auto"])
def test_files_with_the_same_name_in_two_folders_of_a_run_are_both_kept(
    upload_mode: Literal["auto", "manual"],
    watcher: WatcherFactory,
    server: ServerView,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher(upload_mode=upload_mode)
    pc.start()
    # One run, two folders, one file name. The sizes differ so that a single PUT and a multipart
    # upload both have to keep the two apart.
    first = write_file(watch_dir / "RUN001" / "day1" / "data.csv", payload(SMALL, seed=1))
    second = write_file(watch_dir / "RUN001" / "day2" / "data.csv", payload(LARGE, seed=2))
    contents = {"RUN001/day1/data.csv": first, "RUN001/day2/data.csv": second}

    for relative_path, data in contents.items():
        if upload_mode == "auto":
            server.wait_for_uploaded(instrument_id, "RUN001", relative_path, content=data)
        else:
            server.wait_for_file(instrument_id, "RUN001", relative_path, status="detected")

    # The server keeps both, as rows of their own with their folders, and one of them is stored
    # under a name tagged with a hash of its folder, because the run has one row per name.
    rows = {f.relative_path or f.filename: f for f in server.files(instrument_id, "RUN001")}
    assert sorted(rows) == sorted(contents)
    plain = [r for r in rows.values() if r.filename == "data.csv"]
    tagged = [r for r in rows.values() if r.filename != "data.csv"]
    assert len(plain) == 1 and len(tagged) == 1, [r.filename for r in rows.values()]
    folder = (tagged[0].relative_path or "").rsplit("/", 1)[0]
    tag = hashlib.sha256(folder.encode()).hexdigest()[:8]
    assert tagged[0].filename == f"data~{tag}.csv"
    assert run_names(server, instrument_id) == ["RUN001"]

    if upload_mode == "auto":
        # Each file's bytes are under its own name: the two did not overwrite each other.
        for relative_path, data in contents.items():
            row = rows[relative_path]
            assert server.read_object(instrument_id, "RUN001", row.filename) == data
        uploaded = server.wait_for_events(pc.watcher_id, event_type="file_uploaded", count=2)
        assert len({e.details["s3_key"] for e in uploaded}) == 2


@pytest.mark.covers("run.known->file_added")
def test_a_later_file_of_a_reported_run_goes_out_as_an_update(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher(upload_mode="manual")
    pc.start()
    write_file(watch_dir / "RUN001" / "first.csv")
    server.wait_for_file(instrument_id, "RUN001", "RUN001/first.csv", status="detected")
    assert [r.method for r in run_reports(proxy, instrument_id)] == ["POST"]

    write_file(watch_dir / "RUN001" / "second.csv")
    server.wait_for_file(instrument_id, "RUN001", "RUN001/second.csv", status="detected")

    reports = run_reports(proxy, instrument_id)
    assert [r.method for r in reports] == ["POST", "PATCH"]
    assert reports[1].path == f"/api/v1/instruments/{instrument_id}/runs/RUN001"
    # The update carried the one new file, not the whole manifest (only the log says so).
    pc.wait_for_log(r"Updated run RUN001 \(sent 1 new file\(s\), 2 total\)")
    assert len(run_names(server, instrument_id)) == 1
    assert len(server.events(pc.watcher_id, event_type="run_reported")) == 1


@pytest.mark.covers(
    "run.report->retried_after_server_error",
    "event.run_report_failed->emitted",
    "event.run_reported->emitted",
)
def test_a_failed_run_report_is_retried_with_a_growing_delay(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher(upload_mode="manual")
    pc.start()

    # The first report gets a 503. The second reaches the server, which stores the run, but its
    # reply never arrives. The third goes through (the server answers 200: the run exists).
    with (
        proxy.fault("status", path=r"/runs$", method="POST", status=503, count=1),
        proxy.fault("drop_response", path=r"/runs$", method="POST", count=1),
    ):
        write_file(watch_dir / "RUN001" / "a.csv")
        server.wait_for_event(pc.watcher_id, event_type="run_reported", timeout=90)

    attempts = run_reports(proxy, instrument_id)
    assert [(r.method, r.fault_mode, r.upstream_status) for r in attempts] == [
        ("POST", "status", None),
        ("POST", "drop_response", 201),
        ("POST", None, 200),
    ]
    first_gap = attempts[1].timestamp - attempts[0].timestamp
    second_gap = attempts[2].timestamp - attempts[1].timestamp
    assert first_gap >= RETRY_BASE_DELAY_SECONDS - 0.5, first_gap
    assert second_gap >= 2 * RETRY_BASE_DELAY_SECONDS - 0.5, second_gap

    # Two failures in a row would be noise: the run has one event, for the first.
    failed = error_events(server, pc.watcher_id, "run_report_failed")
    assert len(failed) == 1
    assert failed[0].details["run_id"] == "RUN001"
    assert failed[0].details["operation"] == "create"
    assert failed[0].details["status_code"] == 503
    assert failed[0].details["file_count"] == 1
    assert len(server.events(pc.watcher_id, event_type="run_reported")) == 1
    assert run_names(server, instrument_id) == ["RUN001"]
    server.wait_for_file(instrument_id, "RUN001", "RUN001/a.csv", status="detected")


@pytest.mark.covers("run.update->retried_after_server_error", "event.run_report_failed->emitted")
def test_a_failed_run_update_is_retried_and_carries_the_file(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher(upload_mode="manual")
    pc.start()
    write_file(watch_dir / "RUN001" / "a.csv")
    server.wait_for_file(instrument_id, "RUN001", "RUN001/a.csv", status="detected")

    # The run is reported, and the update for its next file gets a 503.
    with proxy.fault("status", path=r"/runs/RUN001$", method="PATCH", status=503, count=1):
        write_file(watch_dir / "RUN001" / "b.csv")
        server.wait_for_file(instrument_id, "RUN001", "RUN001/b.csv", status="detected", timeout=30)

    # The retry came after the base delay, and sent the file the failed update had not. The
    # server stores the file before it answers, so first wait until the proxy has the answer.
    def patches() -> list[RecordedRequest]:
        return [r for r in run_reports(proxy, instrument_id) if r.method == "PATCH"]

    updates = wait_for_answer(proxy, patches, what="the server's answer to the retried update")
    assert [(r.fault_mode, r.upstream_status) for r in updates] == [("status", None), (None, 200)]
    assert updates[1].timestamp - updates[0].timestamp >= RETRY_BASE_DELAY_SECONDS - 0.5
    pc.wait_for_log(r"Updated run RUN001 \(sent 1 new file\(s\), 2 total\)")
    assert relative_paths(server, instrument_id, "RUN001") == ["RUN001/a.csv", "RUN001/b.csv"]

    # The failure was reported once, as an update of a run that already had a file.
    [failed] = error_events(server, pc.watcher_id, "run_report_failed")
    assert failed.details["operation"] == "update"
    assert failed.details["status_code"] == 503
    assert failed.details["run_id"] == "RUN001"
    assert len(server.events(pc.watcher_id, event_type="run_reported")) == 1


@pytest.mark.covers(
    "run.update->rejected_not_retried",
    "run.restored->updates_accepted",
    "event.run_report_failed->emitted",
)
def test_a_deleted_run_refuses_updates_and_catches_up_after_it_is_restored(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher(upload_mode="manual")
    pc.start()
    write_file(watch_dir / "RUN001" / "a.csv")
    server.wait_for_file(instrument_id, "RUN001", "RUN001/a.csv", status="detected")

    # An admin deletes the run, then the instrument writes another file to it.
    admin.delete_run(instrument_id, "RUN001").raise_for_status()
    write_file(watch_dir / "RUN001" / "b.csv")
    failed = server.wait_for_event(pc.watcher_id, event_type="error", kind="run_report_failed")
    assert failed.details["run_id"] == "RUN001"
    assert failed.details["operation"] == "update"
    assert failed.details["status_code"] == 409
    assert failed.message.startswith("Failed to update run RUN001")

    # A 4xx is not retried. A 5xx would be, after the base delay, which this window outlasts.
    def patches() -> list[RecordedRequest]:
        return [r for r in run_reports(proxy, instrument_id) if r.method == "PATCH"]

    stays_true(
        lambda: len(patches()) == 1,
        RETRY_BASE_DELAY_SECONDS + 1.5,
        lambda: server.dump(pc.watcher_id, instrument_id),
        what="one refused update, and no retry",
    )
    assert patches()[0].upstream_status == 409
    assert relative_paths(server, instrument_id, "RUN001") == ["RUN001/a.csv"]

    # Restored, the run takes the next file's update, which also carries the refused file.
    admin.restore_run(instrument_id, "RUN001").raise_for_status()
    write_file(watch_dir / "RUN001" / "c.csv")
    server.wait_for_file(instrument_id, "RUN001", "RUN001/c.csv", status="detected")
    assert relative_paths(server, instrument_id, "RUN001") == [
        "RUN001/a.csv",
        "RUN001/b.csv",
        "RUN001/c.csv",
    ]
    # The server stores the file before it answers, so wait until the proxy has the answer.
    answered = wait_for_answer(proxy, patches, what="the server's answer to the update of c.csv")
    assert [r.upstream_status for r in answered] == [409, 200]
    assert len(error_events(server, pc.watcher_id, "run_report_failed")) == 1


@pytest.mark.xfail(
    strict=True,
    raises=KnownBugStillPresent,
    reason="ENG-2114: the POST of a deleted run returns 200 "
    "and attaches the files instead of a 409",
)
@pytest.mark.covers("run.deleted->rereport_conflict")
def test_reporting_a_deleted_run_again_is_refused_and_attaches_no_files(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher(upload_mode="manual")
    pc.start()
    write_file(watch_dir / "RUN001" / "first.csv")
    server.wait_for_file(instrument_id, "RUN001", "RUN001/first.csv", status="detected")
    assert pc.stop() == 0

    # While the watcher is stopped an admin deletes the run, and the instrument writes another
    # file to the run's folder. The PC then forgets the folder, so it reports it from scratch.
    admin.delete_run(instrument_id, "RUN001").raise_for_status()
    (watch_dir / "RUN001" / "first.csv").unlink()
    write_file(watch_dir / "RUN001" / "second.csv")
    forget(pc, "RUN001")
    proxy.clear_log()
    pc.start()

    def answer() -> int | None:
        return next(
            (
                r.upstream_status
                for r in run_reports(proxy, instrument_id)
                if r.method == "POST" and r.upstream_status is not None
            ),
            None,
        )

    status = wait_until(
        answer,
        30,
        lambda: server.dump(pc.watcher_id, instrument_id),
        what="the server's answer to the run report",
    )
    with known_bug():
        assert status == 409, "the server accepted a report of a deleted run"
        assert server.file(instrument_id, "RUN001", "RUN001/second.csv") is None


# The test server is `next start`, which decodes a route parameter once. On Vercel, Next.js decodes
# it a second time (ENG-2166), so this test can't show that. The server reads the run ID from the
# path as sent instead (`readRunIdParam` in the web app), and its own tests cover that.
@pytest.mark.covers("run.url_characters_in_id->update_reaches_run")
@pytest.mark.parametrize("upload_mode", ["manual", "auto"])
def test_a_run_with_url_characters_in_its_id_gets_its_files(
    upload_mode: Literal["auto", "manual"],
    watcher: WatcherFactory,
    server: ServerView,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher(upload_mode=upload_mode)
    pc.start()
    # "Q%41" reads as "QA" once the URL is decoded, so a call that isn't encoded lands in that
    # run, which holds a file of its own.
    own = write_file(watch_dir / "QA" / "own.csv", SMALL)
    wait_for_run_file(server, instrument_id, "QA", "own.csv", upload_mode, own)
    contents = {
        run_id: write_run(watch_dir, run_id, {"first.csv": SMALL, "second.csv": SMALL})
        for run_id in ("Plate#3", "Q%41", "PLAIN")
    }
    # A run with a plain ID, written last, shows the watcher has got through the others.
    wait_for_run_file(
        server, instrument_id, "PLAIN", "second.csv", upload_mode, contents["PLAIN"]["second.csv"]
    )

    for run_id in ("Plate#3", "Q%41"):
        for name, data in contents[run_id].items():
            if upload_mode == "auto":
                # Done means the row says so and the stand-in holds the bytes under the
                # run's own folder, `<instrument>/<run>/<name>`.
                server.wait_for_uploaded(
                    instrument_id, run_id, f"{run_id}/{name}", content=data, timeout=10
                )
            else:
                server.wait_for_file(
                    instrument_id, run_id, f"{run_id}/{name}", status="detected", timeout=5
                )
    # Nothing of these runs landed in `QA`, the run that `Q%41` reads as without the encoding.
    assert relative_paths(server, instrument_id, "QA") == ["QA/own.csv"]
    assert not server.object_exists(instrument_id, "QA", "first.csv")
    assert not server.object_exists(instrument_id, "QA", "second.csv")


# The run is the part of the file name before the first underscore, so `RUN1 _a.csv` is in the run
# `RUN1 ` with a space at the end. The server saves that run as `RUN1`, and has to find it again
# when the watcher names it with the space.
@pytest.mark.covers("run.id_with_outer_spaces->update_reaches_run")
@pytest.mark.parametrize("upload_mode", ["manual", "auto"])
def test_a_run_with_a_space_at_the_end_of_its_id_gets_its_files(
    upload_mode: Literal["auto", "manual"],
    watcher: WatcherFactory,
    server: ServerView,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher(upload_mode=upload_mode, recursive=False, run_pattern=r"^([^_/]+)_[^/]*$")
    pc.start()

    def wait_until_done(name: str, content: bytes) -> None:
        if upload_mode == "auto":
            # Done means the row says so and the stand-in holds the bytes under the saved run ID.
            server.wait_for_uploaded(instrument_id, "RUN1", name, content=content, timeout=20)
        else:
            server.wait_for_file(instrument_id, "RUN1", name, status="detected")

    contents = {
        "RUN1 _a.csv": write_file(watch_dir / "RUN1 _a.csv", SMALL),
        "RUN1 _b.csv": write_file(watch_dir / "RUN1 _b.csv", LARGE),
    }
    for name, content in contents.items():
        wait_until_done(name, content)

    # A file that arrives after the run exists is reported with a run update, which also names
    # the run with the space.
    later = write_file(watch_dir / "RUN1 _c.csv", SMALL)
    wait_until_done("RUN1 _c.csv", later)

    assert run_names(server, instrument_id) == ["RUN1"]
    assert relative_paths(server, instrument_id, "RUN1") == [
        "RUN1 _a.csv",
        "RUN1 _b.csv",
        "RUN1 _c.csv",
    ]
    assert error_events(server, pc.watcher_id) == []


@pytest.mark.covers("file.dismissed_path->redetected")
def test_a_new_file_at_a_dismissed_path_is_detected(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher(upload_mode="manual")
    pc.start()
    path = watch_dir / "RUN001" / "a.csv"
    write_file(path, payload(700, seed=1))
    bad = server.wait_for_file(instrument_id, "RUN001", "RUN001/a.csv", status="detected")
    admin.dismiss_file(bad.id).raise_for_status()
    assert pc.stop() == 0

    # The instrument is run again and writes a different file to the same path. The PC forgets
    # the folder, so the file is reported.
    write_file(path, payload(900, seed=2))
    forget(pc, "RUN001")
    pc.start()
    # The report went through (the run is known, so the server answers 200).
    server.wait_for_events(pc.watcher_id, event_type="run_reported", count=2)

    row = server.file(instrument_id, "RUN001", "RUN001/a.csv", include_deleted=False)
    assert row is not None, "the new file at the dismissed path is not on the server"
    assert row.status == "detected"
    assert row.size_bytes == 900
    assert row.id != bad.id


# ---------------------------------------------------------------------------
# The initial scan and restarts
# ---------------------------------------------------------------------------


@pytest.mark.covers(
    "scan.full->existing_files_reported",
    "file.new->pending",
    "event.file_uploaded->emitted",
)
def test_a_full_initial_scan_reports_and_uploads_the_files_already_there(
    watcher: WatcherFactory, server: ServerView, instrument_id: str, watch_dir: Path
) -> None:
    pc = watcher(initial_scan="full")
    data = write_run(watch_dir, "RUN001")  # One small file and one large one.
    pc.start()

    for name, content in data.items():
        server.wait_for_uploaded(instrument_id, "RUN001", f"RUN001/{name}", content=content)
    assert server.run_status(instrument_id, "RUN001") == "uploaded"
    reported = server.wait_for_event(pc.watcher_id, event_type="run_reported")
    assert reported.details["run_id"] == "RUN001"
    uploaded = server.wait_for_events(pc.watcher_id, event_type="file_uploaded", count=2)
    assert sorted(e.details["s3_key"] for e in uploaded) == [
        f"{instrument_id}/RUN001/large.csv",
        f"{instrument_id}/RUN001/small.csv",
    ]


@pytest.mark.covers("scan.new_only->baseline_seeded", "scan.new_only->baseline_not_repeated")
def test_a_new_only_watcher_skips_the_backlog_but_reports_later_files(
    watcher: WatcherFactory, server: ServerView, instrument_id: str, watch_dir: Path
) -> None:
    pc = watcher(upload_mode="manual", initial_scan="new-only")
    write_file(watch_dir / "OLD" / "backlog.csv")
    pc.start()

    # The first start baselines what is there, and reports what comes after.
    write_file(watch_dir / "NEW" / "live.csv")
    server.wait_for_file(instrument_id, "NEW", "NEW/live.csv", status="detected")
    stays_true(
        lambda: run_names(server, instrument_id) == ["NEW"],
        2,
        lambda: server.dump(pc.watcher_id, instrument_id),
        what="the backlog is never reported",
    )
    assert pc.state_query("SELECT relative_path FROM baseline_files") == [("OLD/backlog.csv",)]

    # A later start doesn't baseline again, so a file that arrived while stopped is reported.
    assert pc.stop() == 0
    write_file(watch_dir / "AWAY" / "offline.csv")
    pc.start()
    server.wait_for_file(instrument_id, "AWAY", "AWAY/offline.csv", status="detected")
    stays_true(
        lambda: run_names(server, instrument_id) == ["AWAY", "NEW"],
        2,
        lambda: server.dump(pc.watcher_id, instrument_id),
        what="the backlog is still never reported",
    )
    assert pc.state_query("SELECT relative_path FROM baseline_files") == [("OLD/backlog.csv",)]


@pytest.mark.covers("scan.restart->reported_files_skipped")
@pytest.mark.parametrize("upload_mode", ["auto", "manual"])
def test_a_restart_does_not_report_or_upload_known_files_again(
    upload_mode: Literal["auto", "manual"],
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher(upload_mode=upload_mode)
    pc.start()
    data = write_run(watch_dir, "RUN001")
    for name, content in data.items():
        if upload_mode == "auto":
            server.wait_for_uploaded(instrument_id, "RUN001", f"RUN001/{name}", content=content)
        else:
            server.wait_for_file(instrument_id, "RUN001", f"RUN001/{name}", status="detected")
    # The watcher writes its own record after the server has the row, and it is the record that
    # the next start goes by, so wait for it before the stop.
    wait_until(
        lambda: has_recorded_files(pc, upload_mode, len(data)),
        30,
        lambda: server.dump(pc.watcher_id, instrument_id),
        what="the watcher to record the files in its state database",
    )
    rows_before = server.files(instrument_id, "RUN001")
    assert pc.stop() == 0

    proxy.clear_log()
    pc.start()
    # Something that must be reported after the scan, so the scan has had its turn.
    write_run(watch_dir, "RUN002", {"c.csv": SMALL})
    server.wait_for_file(
        instrument_id,
        "RUN002",
        "RUN002/c.csv",
        status="uploaded" if upload_mode == "auto" else "detected",
    )

    # The only run report since the restart is the new run's, and nothing of RUN001 was sent.
    assert [r.method for r in run_reports(proxy, instrument_id)] == ["POST"]
    assert all("RUN001" not in path for _, path in data_requests(proxy))
    assert server.files(instrument_id, "RUN001") == rows_before
    assert len(server.wait_for_events(pc.watcher_id, event_type="run_reported", count=2)) == 2


@pytest.mark.covers("scan.restart->offline_files_reported")
def test_files_written_while_stopped_or_refused_are_reported_at_the_next_start(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher(upload_mode="manual")
    pc.start()

    # The server refuses the run report, and the watcher is stopped before a retry.
    with proxy.fault("status", status=503, path=r"/runs$", method="POST"):
        write_file(watch_dir / "REFUSED" / "a.csv")
        proxy.wait_for_request(
            lambda r: r.method == "POST" and r.fault_mode == "status", timeout=30
        )
        assert pc.stop() == 0
    # A file also arrives while the watcher is stopped.
    write_file(watch_dir / "OFFLINE" / "b.csv")
    assert not server.runs(instrument_id)

    pc.start()
    server.wait_for_file(instrument_id, "REFUSED", "REFUSED/a.csv", status="detected")
    server.wait_for_file(instrument_id, "OFFLINE", "OFFLINE/b.csv", status="detected")
    assert run_names(server, instrument_id) == ["OFFLINE", "REFUSED"]


@pytest.mark.covers("scan.restart->runs_hydrated")
def test_after_a_restart_a_new_file_of_a_known_run_goes_out_as_an_update(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher(upload_mode="manual")
    pc.start()
    write_file(watch_dir / "RUN001" / "a.csv")
    server.wait_for_file(instrument_id, "RUN001", "RUN001/a.csv", status="detected")
    assert pc.stop() == 0

    # A file of the same run arrives while the watcher is stopped, and the scan finds it.
    write_file(watch_dir / "RUN001" / "b.csv")
    proxy.clear_log()
    pc.start()
    server.wait_for_file(instrument_id, "RUN001", "RUN001/b.csv", status="detected")

    reports = run_reports(proxy, instrument_id)
    assert [r.method for r in reports] == ["PATCH"]
    assert reports[0].path == f"/api/v1/instruments/{instrument_id}/runs/RUN001"
    assert run_names(server, instrument_id) == ["RUN001"]
    # The run was reported once, in the first session.
    assert len(server.events(pc.watcher_id, event_type="run_reported")) == 1
