"""A run deleted on Data Hub is reported once and then left alone until the watcher restarts.

The server refuses a report, an update or an upload-URL request for a deleted run with a 409 whose
`error.details.reason` is `run_deleted`. A watcher that has forgotten such a run (after
`state forget`, or after switching from `watch` to the Windows service) used to report it again for
every stable file in the folder, and each refusal cost an error and a `run_report_failed` event.
The refusal is now remembered for the life of the process: one event and one error for the run, no
request for its later files, no retry, no upload attempt, and a new process tries once more.
"""

from __future__ import annotations
import threading
from collections.abc import Callable, Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import cast
from unittest.mock import MagicMock

import pytest

from data_hub_watcher import run_detector
from data_hub_watcher.api_client import ApiError, is_run_deleted
from data_hub_watcher.constants import (
    MAX_PENDING_UPLOAD_ATTEMPTS,
    MAX_QUEUE_FILE_ATTEMPTS,
    RUN_REPORT_RETRY_BASE_DELAY_SECONDS,
)
from data_hub_watcher.deleted_runs import DeletedRuns
from data_hub_watcher.events import EventReporter, EventType
from data_hub_watcher.heartbeat import WatcherCounters
from data_hub_watcher.models import ApiErrorDetail, UploadQueueFile, UploadQueueResponse
from data_hub_watcher.run_detector import FileInfo, RunDetector
from data_hub_watcher.state import StateDB
from data_hub_watcher.uploader import Uploader

RUN = "R1"


def _refusal(reason: str | None = "run_deleted") -> ApiError:
    """The 409 the server sends for a request about a deleted run."""
    details = None if reason is None else {"reason": reason}
    return ApiError(
        "This run was deleted on Data Hub. Restore it to add files.",
        status_code=409,
        detail=ApiErrorDetail(code="CONFLICT", message="deleted", details=details),
    )


class TestIsRunDeleted:
    def test_a_409_with_the_reason_is_it(self) -> None:
        assert is_run_deleted(_refusal())

    @pytest.mark.parametrize(
        "exc",
        [
            _refusal(None),
            _refusal("something_else"),
            ApiError("no detail", status_code=409),
            ApiError("wrong status", status_code=400, detail=_refusal().detail),
            ApiError("no response", status_code=0),
            RuntimeError("not an ApiError"),
        ],
        ids=["no-reason", "other-reason", "no-detail", "other-status", "no-status", "other-error"],
    )
    def test_nothing_else_is(self, exc: BaseException) -> None:
        assert not is_run_deleted(exc)


class TestDeletedRuns:
    def test_only_the_first_add_is_new(self) -> None:
        deleted = DeletedRuns()
        assert RUN not in deleted
        assert deleted.add(RUN) is True
        assert deleted.add(RUN) is False
        assert RUN in deleted
        assert "R2" not in deleted

    def test_one_of_many_threads_adding_a_run_is_told_so(self) -> None:
        deleted = DeletedRuns()
        start = threading.Barrier(16)
        results: list[bool] = []

        def add() -> None:
            start.wait()
            results.append(deleted.add(RUN))

        threads = [threading.Thread(target=add) for _ in range(16)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert results.count(True) == 1


# ==================================================================
# Reports and updates (the run detector)
# ==================================================================


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture()
def watch_dir(tmp_path: Path) -> Path:
    d = tmp_path / "watch"
    d.mkdir()
    return d


@pytest.fixture()
def state_db(tmp_path: Path) -> Iterator[StateDB]:
    db = StateDB(tmp_path / "state.db")
    yield db
    db.close()


@pytest.fixture()
def clock(monkeypatch: pytest.MonkeyPatch) -> _Clock:
    clock = _Clock()
    monkeypatch.setattr(run_detector, "time", SimpleNamespace(monotonic=clock))
    return clock


class _Process:
    """The run detector of one watcher process, over a state DB that outlives it."""

    def __init__(
        self,
        watch_dir: Path,
        state_db: StateDB,
        *,
        deleted_runs: DeletedRuns | None = None,
        upload: Callable[[str, list[FileInfo]], int] | None = None,
    ) -> None:
        self.client = MagicMock()
        self.reporter = MagicMock(spec=EventReporter)
        self.counters = WatcherCounters()
        self.uploads: list[tuple[str, list[str]]] = []

        def record(run_id: str, files: list[FileInfo]) -> int:
            self.uploads.append((run_id, [f.filename for f in files]))
            return len(files)

        self.detector = RunDetector(
            pattern=r"^(R\d)_",
            instrument_id="inst-1",
            watcher_id="watcher-1",
            client=self.client,
            state_db=state_db,
            event_reporter=self.reporter,
            counters=self.counters,
            upload_callback=upload or record,
            watch_directory=watch_dir,
            deleted_runs=deleted_runs,
        )
        self.watch_dir = watch_dir

    def file(self, name: str) -> Path:
        path = self.watch_dir / name
        path.write_text(name)
        return path

    def arrive(self, *names: str) -> None:
        for name in names:
            self.detector.on_stable_file(self.file(name))

    @property
    def errors(self) -> list[MagicMock]:
        return list(self.reporter.report_error.call_args_list)


def _names(run: str, n: int) -> list[str]:
    return [f"{run}_{i}.csv" for i in range(n)]


class TestForgottenRunRefusedOnReport:
    def test_many_files_cost_one_request_one_event_and_one_error(
        self, watch_dir: Path, state_db: StateDB, clock: _Clock
    ) -> None:
        p = _Process(watch_dir, state_db)
        p.client.report_run.side_effect = _refusal()

        p.arrive(*_names(RUN, 12))

        assert p.client.report_run.call_count == 1
        p.client.update_run.assert_not_called()
        [event] = p.errors
        assert event.args[0] == "run_report_failed"
        assert event.kwargs == {
            "run_id": RUN,
            "operation": "create",
            "status_code": 409,
            "error": _refusal().message,
            "file_count": 1,
            "reason": "run_deleted",
        }
        assert event.args[1].startswith(f"Failed to report run {RUN}")
        assert p.counters.errors == 1
        # Nothing is recorded or uploaded, and no retry is waiting.
        assert state_db.get_run(RUN) is None
        assert state_db.get_detected_files_for_run(RUN) == []
        assert state_db.pending_uploads() == []
        assert p.uploads == []
        assert p.detector._retry_at == {}

    def test_other_runs_are_still_reported(
        self, watch_dir: Path, state_db: StateDB, clock: _Clock
    ) -> None:
        p = _Process(watch_dir, state_db)
        p.client.report_run.side_effect = [_refusal(), SimpleNamespace(id="api-r2")]

        p.arrive("R1_a.csv", "R1_b.csv", "R2_a.csv")

        assert p.client.report_run.call_count == 2
        assert [c.args[1]["run_id"] for c in p.client.report_run.call_args_list] == ["R1", "R2"]
        assert state_db.get_run("R2") is not None

    def test_a_refusal_ends_a_retry_that_was_waiting(
        self, watch_dir: Path, state_db: StateDB, clock: _Clock
    ) -> None:
        p = _Process(watch_dir, state_db)
        p.client.report_run.side_effect = [ApiError("down", 503), _refusal()]

        p.arrive("R1_a.csv")
        assert RUN in p.detector._retry_at
        p.arrive("R1_b.csv")

        assert p.detector._retry_at == {}
        clock.now += 10_000
        p.detector.retry_failed_reports()
        assert p.client.report_run.call_count == 2
        # The 503 was the first failure and the refusal the second: two events, one each.
        assert [c.kwargs["status_code"] for c in p.errors] == [503, 409]
        assert p.counters.errors == 2


class TestKnownRunRefusedOnUpdate:
    def test_many_files_cost_one_request_one_event_and_one_error(
        self, watch_dir: Path, state_db: StateDB, clock: _Clock
    ) -> None:
        p = _Process(watch_dir, state_db)
        p.client.report_run.return_value = SimpleNamespace(id="api-run")
        p.client.update_run.side_effect = _refusal()

        # The first file is accepted. An admin then deletes the run.
        p.arrive("R1_0.csv")
        p.arrive(*_names(RUN, 12)[1:])

        p.client.report_run.assert_called_once()
        assert p.client.update_run.call_count == 1
        [event] = p.errors
        assert event.args[0] == "run_report_failed"
        assert event.kwargs["operation"] == "update"
        assert event.kwargs["status_code"] == 409
        assert event.kwargs["reason"] == "run_deleted"
        assert event.kwargs["file_count"] == 2
        assert p.counters.errors == 1
        # Only the accepted file was recorded and uploaded.
        assert [r.filename for r in state_db.get_detected_files_for_run(RUN)] == ["R1_0.csv"]
        assert p.uploads == [(RUN, ["R1_0.csv"])]
        assert p.detector._retry_at == {}
        assert p.detector._runs[RUN].patched_file_count == 1

    def test_the_monitors_tick_does_not_retry_a_refused_run(
        self, watch_dir: Path, state_db: StateDB, clock: _Clock
    ) -> None:
        p = _Process(watch_dir, state_db)
        p.client.report_run.return_value = SimpleNamespace(id="api-run")
        p.client.update_run.side_effect = _refusal()
        p.arrive("R1_0.csv", "R1_1.csv", "R1_2.csv")

        for _ in range(3):
            clock.now += 10_000
            p.detector.retry_failed_reports()

        assert p.client.update_run.call_count == 1
        assert len(p.errors) == 1

    def test_a_retry_due_when_the_uploader_finds_the_run_deleted_sends_nothing(
        self, watch_dir: Path, state_db: StateDB, clock: _Clock
    ) -> None:
        deleted = DeletedRuns()
        p = _Process(watch_dir, state_db, deleted_runs=deleted)
        p.client.report_run.side_effect = ApiError("down", 503)
        p.arrive("R1_0.csv")
        assert RUN in p.detector._retry_at

        deleted.add(RUN)  # What the uploader does when its upload-URL request is refused.
        clock.now += RUN_REPORT_RETRY_BASE_DELAY_SECONDS
        p.detector.retry_failed_reports()

        assert p.client.report_run.call_count == 1
        assert p.detector._retry_at == {}
        assert p.detector._runs[RUN].retry_attempts == 0

    def test_a_run_the_uploader_found_deleted_is_not_reported_by_the_detector(
        self, watch_dir: Path, state_db: StateDB, clock: _Clock
    ) -> None:
        deleted = DeletedRuns()
        deleted.add(RUN)
        p = _Process(watch_dir, state_db, deleted_runs=deleted)

        p.arrive(*_names(RUN, 3))

        p.client.report_run.assert_not_called()
        p.client.update_run.assert_not_called()
        assert p.errors == []
        assert p.counters.errors == 0


class TestOtherConflictsAreUnchanged:
    @pytest.mark.parametrize(
        "refusal",
        [_refusal(None), _refusal("something_else"), ApiError("conflict", status_code=409)],
        ids=["no-reason", "other-reason", "no-detail"],
    )
    @pytest.mark.parametrize("operation", ["create", "update"])
    def test_every_file_still_sends_a_request_and_reports_an_event(
        self,
        watch_dir: Path,
        state_db: StateDB,
        clock: _Clock,
        refusal: ApiError,
        operation: str,
    ) -> None:
        p = _Process(watch_dir, state_db)
        if operation == "create":
            p.client.report_run.side_effect = refusal
        else:
            p.client.report_run.return_value = SimpleNamespace(id="api-run")
            p.client.update_run.side_effect = refusal
            p.arrive("R1_0.csv")

        p.arrive("R1_1.csv", "R1_2.csv", "R1_3.csv")

        sent = p.client.report_run if operation == "create" else p.client.update_run
        assert sent.call_count == 3
        failures = p.errors
        assert len(failures) == 3
        assert all("reason" not in c.kwargs for c in failures)
        assert p.counters.errors == 3


class TestANewProcessTriesOnceMore:
    def test_each_start_sends_one_request_and_a_restored_run_gets_its_files(
        self, watch_dir: Path, state_db: StateDB, clock: _Clock
    ) -> None:
        names = _names(RUN, 5)

        # Two starts while the run is deleted: one request and one event each.
        for _ in range(2):
            p = _Process(watch_dir, state_db)
            p.client.report_run.side_effect = _refusal()
            p.arrive(*names)
            assert p.client.report_run.call_count == 1
            assert len(p.errors) == 1
            assert state_db.get_run(RUN) is None

        # An admin restores the run. The next start sends everything.
        p = _Process(watch_dir, state_db)
        p.client.report_run.return_value = SimpleNamespace(id="api-run")
        p.arrive(*names)

        assert p.errors == []
        assert p.client.report_run.call_count == 1
        assert p.client.update_run.call_count == len(names) - 1
        assert sorted(r.filename for r in state_db.get_detected_files_for_run(RUN)) == sorted(names)
        assert p.uploads == [(RUN, [n]) for n in names]


# ==================================================================
# Uploads (the uploader)
# ==================================================================


@pytest.fixture()
def uploads_dir(watch_dir: Path) -> Path:
    (watch_dir / RUN).mkdir()
    return watch_dir


def _uploader(
    watch_dir: Path,
    state_db: StateDB,
    *,
    parallelism: int = 1,
    deleted_runs: DeletedRuns | None = None,
) -> Uploader:
    client = MagicMock()
    client.request_upload_url.side_effect = _refusal()
    return Uploader(
        client=client,
        state_db=state_db,
        event_reporter=MagicMock(spec=EventReporter),
        counters=WatcherCounters(),
        instrument_id="inst-1",
        watcher_id="watcher-1",
        watch_directory=watch_dir,
        upload_parallelism=parallelism,
        deleted_runs=deleted_runs,
    )


def _make_files(watch_dir: Path, n: int) -> list[FileInfo]:
    infos = []
    for i in range(n):
        path = watch_dir / RUN / f"f{i}.csv"
        path.write_text(f"file {i}")
        infos.append(FileInfo(path=path, filename=path.name, size_bytes=path.stat().st_size))
    return infos


def _request_url_mock(up: Uploader) -> MagicMock:
    return cast(MagicMock, up._client.request_upload_url)


def _events(up: Uploader) -> list[MagicMock]:
    reporter = cast(MagicMock, up._reporter)
    return [c.args[0] for c in reporter.queue_event.call_args_list]


class TestUploadsOfADeletedRun:
    def test_a_refused_upload_url_request_stops_the_uploads_of_the_run(
        self, uploads_dir: Path, state_db: StateDB
    ) -> None:
        up = _uploader(uploads_dir, state_db)
        files = _make_files(uploads_dir, 6)

        assert up.upload_files(RUN, files) == 0

        # The first file asked and was refused. The others were skipped before any request.
        assert _request_url_mock(up).call_count == 1
        [event] = _events(up)
        assert event.event_type == EventType.UPLOAD_FAILED
        assert event.details["reason"] == "run_deleted"
        assert event.details["run_id"] == RUN
        assert up._counters.errors == 1
        assert RUN in up._deleted_runs
        run = state_db.get_run(RUN)
        assert run is None or run.uploaded_at is None

    def test_files_in_flight_together_are_reported_once(
        self, uploads_dir: Path, state_db: StateDB
    ) -> None:
        up = _uploader(uploads_dir, state_db, parallelism=4)
        files = _make_files(uploads_dir, 4)
        # Every request is out before any of them is answered.
        together = threading.Barrier(4, timeout=10)

        def refuse(*args: object, **kwargs: object) -> None:
            together.wait()
            raise _refusal()

        _request_url_mock(up).side_effect = refuse

        assert up.upload_files(RUN, files) == 0

        assert _request_url_mock(up).call_count == 4
        assert len(_events(up)) == 1
        assert up._counters.errors == 1

    def test_the_detector_stops_reporting_a_run_the_uploader_found_deleted(
        self, uploads_dir: Path, state_db: StateDB, clock: _Clock
    ) -> None:
        deleted = DeletedRuns()
        up = _uploader(uploads_dir, state_db, deleted_runs=deleted)
        p = _Process(uploads_dir, state_db, deleted_runs=deleted)
        p.client.report_run.return_value = SimpleNamespace(id="api-run")
        p.client.update_run.return_value = MagicMock()

        # Reported and accepted, then the upload of its file is refused: the run was
        # deleted between the two.
        p.arrive("R1_0.csv")
        up.upload_files(
            RUN, [FileInfo(path=p.watch_dir / "R1_0.csv", filename="R1_0.csv", size_bytes=1)]
        )
        p.arrive("R1_1.csv", "R1_2.csv")

        p.client.update_run.assert_not_called()
        assert p.errors == []

    def test_pending_uploads_of_a_deleted_run_count_no_attempts(
        self, uploads_dir: Path, state_db: StateDB
    ) -> None:
        files = _make_files(uploads_dir, 4)
        state_db.record_report(
            RUN,
            [(f"{RUN}/{f.filename}", f.filename, f.size_bytes, 0.0, None) for f in files],
            new_run=True,
            pending_relative_paths=[f"{RUN}/{f.filename}" for f in files],
        )

        # More starts than the pending-upload cap, each a new process that asks once.
        for _ in range(MAX_PENDING_UPLOAD_ATTEMPTS + 2):
            up = _uploader(uploads_dir, state_db, parallelism=2)
            up.retry_pending_uploads()
            assert 1 <= _request_url_mock(up).call_count <= 2
            [event] = _events(up)
            assert event.details["reason"] == "run_deleted"
            assert up._counters.errors == 1

        # Nothing was given up on: the rows and their zero attempts are still there.
        rows = state_db.pending_uploads()
        assert len(rows) == len(files)
        assert [r.attempts for r in rows] == [0] * len(files)

    def test_queued_files_of_a_deleted_run_are_not_attempted_cancelled_or_reported(
        self, uploads_dir: Path, state_db: StateDB
    ) -> None:
        files = _make_files(uploads_dir, 3)
        up = _uploader(uploads_dir, state_db)
        queue = [
            UploadQueueFile(
                id=i + 1,
                instrument_id="inst-1",
                run_id=RUN,
                relative_path=f"{RUN}/{f.filename}",
                filename=f.filename,
            )
            for i, f in enumerate(files)
        ]
        # A file that the queue lists but is no longer on disk.
        queue.append(
            UploadQueueFile(
                id=9,
                instrument_id="inst-1",
                run_id=RUN,
                relative_path=f"{RUN}/gone.csv",
                filename="gone.csv",
            )
        )
        client = cast(MagicMock, up._client)
        client.get_upload_queue.return_value = UploadQueueResponse(files=queue)

        for _ in range(MAX_QUEUE_FILE_ATTEMPTS + 2):
            up.poll_upload_queue()

        assert _request_url_mock(up).call_count == 1
        assert len(_events(up)) == 1
        assert up._counters.errors == 1
        assert up._queue_attempts == {}
        client.cancel_upload_request.assert_not_called()

    def test_files_of_other_runs_are_uploaded_normally(
        self, uploads_dir: Path, state_db: StateDB
    ) -> None:
        deleted = DeletedRuns()
        deleted.add("R2")
        up = _uploader(uploads_dir, state_db, deleted_runs=deleted)
        _request_url_mock(up).side_effect = ApiError("down", status_code=503)
        files = _make_files(uploads_dir, 2)

        up.upload_files(RUN, files)

        # Not skipped: each file asked, and each failure was reported as before.
        assert _request_url_mock(up).call_count == 2
        assert [e.message for e in _events(up)] == [
            "Presigned URL request failed: f0.csv",
            "Presigned URL request failed: f1.csv",
        ]
        assert up._counters.errors == 2
