"""Unit tests for the presigned-URL upload flow in Uploader."""

from __future__ import annotations
import threading
import time
from collections.abc import Generator
from pathlib import Path
from typing import cast
from unittest.mock import MagicMock, patch

import pytest
from requests.adapters import HTTPAdapter

from data_hub_watcher.api_client import ApiError
from data_hub_watcher.constants import MAX_QUEUE_FILE_ATTEMPTS
from data_hub_watcher.events import EventReporter
from data_hub_watcher.heartbeat import WatcherCounters
from data_hub_watcher.models import (
    PresignedUploadResponse,
    UploadQueueFile,
    UploadQueueResponse,
)
from data_hub_watcher.state import StateDB
from data_hub_watcher.uploader import Uploader, UploadQueueWorker


@pytest.fixture()
def tmp_file(tmp_path: Path) -> Path:
    f = tmp_path / "test_data.csv"
    f.write_text("a,b,c\n1,2,3\n")
    return f


@pytest.fixture()
def mock_client() -> MagicMock:
    return MagicMock()


@pytest.fixture()
def state_db(tmp_path: Path) -> Generator[StateDB, None, None]:
    db = StateDB(tmp_path / "test.db")
    yield db
    db.close()


@pytest.fixture()
def uploader(mock_client: MagicMock, state_db: StateDB, tmp_path: Path) -> Uploader:
    return Uploader(
        client=mock_client,
        state_db=state_db,
        event_reporter=MagicMock(spec=EventReporter),
        counters=WatcherCounters(),
        instrument_id="test-instrument",
        watcher_id="watcher-123",
        watch_directory=tmp_path,
    )


class TestUploadSingle:
    def test_successful_upload(
        self,
        uploader: Uploader,
        mock_client: MagicMock,
        tmp_file: Path,
        state_db: StateDB,
    ) -> None:
        mock_client.request_upload_url.return_value = PresignedUploadResponse(
            upload_url="https://s3.example.com/presigned",
            s3_bucket="test-bucket",
            s3_key="test-instrument/RUN-001/test_data.csv",
            file_id=42,
            expires_in=3600,
            already_uploaded=False,
        )
        mock_client.mark_file_uploaded.return_value = MagicMock()

        with patch.object(Uploader, "_put_to_presigned_url") as mock_put:
            result = uploader._upload_single(tmp_file, "RUN-001")

        assert result is True
        mock_put.assert_called_once()
        mock_client.mark_file_uploaded.assert_called_once_with(
            42,
            {
                "s3_bucket": "test-bucket",
                "s3_key": "test-instrument/RUN-001/test_data.csv",
                "content_type": "text/csv",
                "status": "uploaded",
            },
        )
        assert uploader._counters.files_uploaded == 1

        # Stat columns must be populated (keyed on the watch-dir-relative
        # path) so subsequent initial scans can skip this file without
        # re-hashing its contents.
        st = tmp_file.stat()
        rel_path = tmp_file.relative_to(uploader._watch_dir).as_posix()
        assert state_db.has_stat_match(rel_path, st.st_size, st.st_mtime) is True

        # request_upload_url is invoked with the on-disk creation time so
        # the API can persist files.file_created_at.
        kwargs = mock_client.request_upload_url.call_args.kwargs
        assert "file_created_at_ts" in kwargs
        assert kwargs["file_created_at_ts"] > 0

    def test_already_uploaded_skips(
        self,
        uploader: Uploader,
        mock_client: MagicMock,
        tmp_file: Path,
    ) -> None:
        mock_client.request_upload_url.return_value = PresignedUploadResponse(
            upload_url="",
            s3_bucket="test-bucket",
            s3_key="test-instrument/RUN-001/test_data.csv",
            file_id=42,
            expires_in=3600,
            already_uploaded=True,
        )

        with patch.object(Uploader, "_put_to_presigned_url") as mock_put:
            result = uploader._upload_single(tmp_file, "RUN-001")

        assert result is True
        mock_put.assert_not_called()
        mock_client.mark_file_uploaded.assert_not_called()

    def test_presigned_url_request_failure(
        self,
        uploader: Uploader,
        mock_client: MagicMock,
        tmp_file: Path,
    ) -> None:
        mock_client.request_upload_url.side_effect = ApiError("Server error", status_code=500)

        result = uploader._upload_single(tmp_file, "RUN-001")

        assert result is False
        assert uploader._counters.errors == 1

    def test_put_failure_retries_then_fails(
        self,
        uploader: Uploader,
        mock_client: MagicMock,
        tmp_file: Path,
    ) -> None:
        mock_client.request_upload_url.return_value = PresignedUploadResponse(
            upload_url="https://s3.example.com/presigned",
            s3_bucket="test-bucket",
            s3_key="test-instrument/RUN-001/test_data.csv",
            file_id=42,
            expires_in=3600,
            already_uploaded=False,
        )

        with (
            patch.object(
                Uploader, "_put_to_presigned_url", side_effect=ConnectionError("network down")
            ),
            patch("data_hub_watcher.uploader.time.sleep"),
        ):
            result = uploader._upload_single(tmp_file, "RUN-001")

        assert result is False
        assert uploader._counters.errors == 1
        mock_client.mark_file_uploaded.assert_not_called()

    def test_mark_uploaded_failure(
        self,
        uploader: Uploader,
        mock_client: MagicMock,
        tmp_file: Path,
    ) -> None:
        mock_client.request_upload_url.return_value = PresignedUploadResponse(
            upload_url="https://s3.example.com/presigned",
            s3_bucket="test-bucket",
            s3_key="test-instrument/RUN-001/test_data.csv",
            file_id=42,
            expires_in=3600,
            already_uploaded=False,
        )
        mock_client.mark_file_uploaded.side_effect = ApiError("Server error", status_code=500)

        with patch.object(Uploader, "_put_to_presigned_url"):
            result = uploader._upload_single(tmp_file, "RUN-001")

        assert result is False
        assert uploader._counters.errors == 1


class TestUploadQueuePollFailures:
    """Manual-mode upload-queue poll failures must be visible in the dashboard.

    Today the failure only bumps an opaque counter, so a sustained
    ACL/network outage looks identical to a healthy queue. The fix
    surfaces a ``kind=upload_queue_poll_failed`` event on the 1st
    failure and every 10th repeat. Throttling matters because the
    poll fires every heartbeat (~60 s) — without it a half-day outage
    would emit 720 events.
    """

    def test_emits_on_first_and_every_tenth_failure(
        self, uploader: Uploader, mock_client: MagicMock
    ) -> None:
        mock_client.get_upload_queue.side_effect = ApiError("ACL", status_code=403)

        # 25 failures: events emitted at attempts 1, 10, 20.
        for _ in range(25):
            uploader.poll_upload_queue()

        reporter_mock = cast(MagicMock, uploader._reporter)
        kinds = [c.args[0] for c in reporter_mock.report_error.call_args_list]
        assert kinds.count("upload_queue_poll_failed") == 3
        # And the consecutive-failure count is reported correctly.
        consec = [
            c.kwargs["consecutive_failures"]
            for c in reporter_mock.report_error.call_args_list
            if c.args[0] == "upload_queue_poll_failed"
        ]
        assert consec == [1, 10, 20]

    def test_recovery_resets_counter(self, uploader: Uploader, mock_client: MagicMock) -> None:
        from data_hub_watcher.models import UploadQueueResponse

        mock_client.get_upload_queue.side_effect = [
            ApiError("ACL", status_code=403),
            UploadQueueResponse(files=[]),
            ApiError("ACL", status_code=403),
        ]

        uploader.poll_upload_queue()  # fail 1 -> emits
        uploader.poll_upload_queue()  # success -> resets counter
        uploader.poll_upload_queue()  # fail again, treated as 1st of new outage -> emits

        reporter_mock = cast(MagicMock, uploader._reporter)
        consec = [
            c.kwargs["consecutive_failures"]
            for c in reporter_mock.report_error.call_args_list
            if c.args[0] == "upload_queue_poll_failed"
        ]
        assert consec == [1, 1]


class TestPutToPresignedUrl:
    def test_successful_put(self, uploader: Uploader, tmp_file: Path) -> None:
        # ``_put_to_presigned_url`` is now an instance method so the
        # shared ``self._s3_session`` (kept alive across batched
        # parallel uploads) is reused on every PUT. We patch the
        # session's ``put`` rather than ``http_requests.put`` to
        # observe the real outgoing call.
        mock_session_put = MagicMock(return_value=MagicMock(status_code=200))
        mock_session_put.return_value.raise_for_status = MagicMock()
        with patch.object(uploader._s3_session, "put", mock_session_put):
            uploader._put_to_presigned_url("https://s3.example.com/presigned", tmp_file, "text/csv")

        mock_session_put.assert_called_once()
        call_kwargs = mock_session_put.call_args
        assert call_kwargs.kwargs["headers"]["Content-Type"] == "text/csv"
        assert call_kwargs.kwargs["timeout"] == 300


class TestUploadFilesParallelism:
    """Tests that ``upload_files`` actually parallelises per-file uploads.

    The optimisation moves ``Uploader.upload_files`` from a serial
    ``for info in files`` loop onto a small ``ThreadPoolExecutor``
    sized by ``InstrumentConfig.upload_parallelism``. These tests
    verify both correctness (every file still records as uploaded
    and the run is marked uploaded only when all succeed) and that
    work actually overlaps in time -- a regression to the serial
    loop would still pass the correctness assertions but fail the
    timing one.
    """

    def _make_uploader(
        self,
        mock_client: MagicMock,
        state_db: StateDB,
        watch_dir: Path,
        *,
        parallelism: int,
    ) -> Uploader:
        return Uploader(
            client=mock_client,
            state_db=state_db,
            event_reporter=MagicMock(spec=EventReporter),
            counters=WatcherCounters(),
            instrument_id="test-instrument",
            watcher_id="watcher-123",
            watch_directory=watch_dir,
            upload_parallelism=parallelism,
        )

    def test_serial_path_used_when_parallelism_is_one(
        self,
        mock_client: MagicMock,
        state_db: StateDB,
        tmp_path: Path,
    ) -> None:
        """parallelism=1 must take the no-pool fast path.

        We can't directly observe pool creation, but we can confirm
        the function still completes and records the run.
        """
        from data_hub_watcher.run_detector import FileInfo

        files = []
        for i in range(3):
            f = tmp_path / f"file-{i}.csv"
            f.write_text("a,b\n1,2\n")
            files.append(FileInfo(path=f, filename=f.name, size_bytes=8))

        mock_client.request_upload_url.side_effect = [
            PresignedUploadResponse(
                upload_url=f"https://s3.example.com/presigned/{i}",
                s3_bucket="b",
                s3_key=f"k/{i}",
                file_id=i,
                already_uploaded=False,
            )
            for i in range(3)
        ]
        mock_client.mark_file_uploaded.return_value = MagicMock()

        uploader = self._make_uploader(mock_client, state_db, tmp_path, parallelism=1)

        with patch.object(Uploader, "_put_to_presigned_url"):
            succeeded = uploader.upload_files("RUN-001", files)

        assert succeeded == 3

    def test_parallel_path_runs_concurrently(
        self,
        mock_client: MagicMock,
        state_db: StateDB,
        tmp_path: Path,
    ) -> None:
        """A 6-file batch with parallelism=3 must overlap PUTs in time.

        We use a ``threading.Barrier(3)`` inside the stubbed PUT to
        prove three workers were inside ``_put_to_presigned_url`` at
        the same instant. A serial implementation would deadlock the
        barrier (and the test fails fast on its 5 s timeout), which is
        the regression guard we want.
        """
        from data_hub_watcher.run_detector import FileInfo

        files = []
        for i in range(6):
            f = tmp_path / f"file-{i}.csv"
            f.write_text("a,b\n1,2\n")
            files.append(FileInfo(path=f, filename=f.name, size_bytes=8))

        mock_client.request_upload_url.side_effect = [
            PresignedUploadResponse(
                upload_url=f"https://s3.example.com/presigned/{i}",
                s3_bucket="b",
                s3_key=f"k/{i}",
                file_id=i,
                already_uploaded=False,
            )
            for i in range(6)
        ]
        mock_client.mark_file_uploaded.return_value = MagicMock()

        # Three workers must reach the barrier together; if upload_files
        # serialises them the barrier will time out and BrokenBarrierError
        # is raised inside the worker, which we re-surface as the future's
        # exception (and the test fails).
        barrier = threading.Barrier(parties=3, timeout=5.0)
        max_in_flight = 0
        in_flight = 0
        in_flight_lock = threading.Lock()

        def fake_put(self_: Uploader, url: str, path: Path, content_type: str | None) -> None:
            nonlocal max_in_flight, in_flight
            with in_flight_lock:
                in_flight += 1
                max_in_flight = max(max_in_flight, in_flight)
            try:
                barrier.wait()
            finally:
                with in_flight_lock:
                    in_flight -= 1
            time.sleep(0.01)  # extend the overlap window for max_in_flight

        uploader = self._make_uploader(mock_client, state_db, tmp_path, parallelism=3)

        with patch.object(Uploader, "_put_to_presigned_url", new=fake_put):
            succeeded = uploader.upload_files("RUN-001", files)

        assert succeeded == 6
        # If the pool actually runs three at a time the observed
        # in-flight peak is exactly the parallelism setting.
        assert max_in_flight == 3

    def test_run_marked_uploaded_only_when_all_succeed(
        self,
        mock_client: MagicMock,
        state_db: StateDB,
        tmp_path: Path,
    ) -> None:
        from data_hub_watcher.run_detector import FileInfo

        files = []
        for i in range(3):
            f = tmp_path / f"file-{i}.csv"
            f.write_text("a,b\n1,2\n")
            files.append(FileInfo(path=f, filename=f.name, size_bytes=8))

        # The middle file fails its presign; the others succeed.
        mock_client.request_upload_url.side_effect = [
            PresignedUploadResponse(
                upload_url="https://s3.example.com/presigned/0",
                s3_bucket="b",
                s3_key="k/0",
                file_id=0,
                already_uploaded=False,
            ),
            ApiError("transient", status_code=500),
            PresignedUploadResponse(
                upload_url="https://s3.example.com/presigned/2",
                s3_bucket="b",
                s3_key="k/2",
                file_id=2,
                already_uploaded=False,
            ),
        ]
        mock_client.mark_file_uploaded.return_value = MagicMock()

        uploader = self._make_uploader(mock_client, state_db, tmp_path, parallelism=2)

        with patch.object(Uploader, "_put_to_presigned_url"):
            succeeded = uploader.upload_files("RUN-002", files)

        assert succeeded == 2
        # A partial failure must NOT mark the run uploaded -- otherwise
        # the next restart would skip a file we never finished.
        run = state_db.get_run("RUN-002")
        assert run is None or run.uploaded_at is None

    def test_empty_file_list_marks_run_uploaded(
        self,
        mock_client: MagicMock,
        state_db: StateDB,
        tmp_path: Path,
    ) -> None:
        """Preserve the pre-parallelism behaviour for empty manifests."""
        uploader = self._make_uploader(mock_client, state_db, tmp_path, parallelism=4)
        # We have to seed the ``runs`` row first so the UPDATE inside
        # ``record_run_uploaded`` actually flips a column we can read
        # back. This mirrors how the run-detector orders calls in real
        # life (POST run → record_run_reported → upload_files → empty).
        state_db.record_run_reported("RUN-EMPTY")

        succeeded = uploader.upload_files("RUN-EMPTY", [])

        assert succeeded == 0
        run = state_db.get_run("RUN-EMPTY")
        assert run is not None
        assert run.uploaded_at is not None

    def test_invalid_parallelism_rejected(
        self,
        mock_client: MagicMock,
        state_db: StateDB,
        tmp_path: Path,
    ) -> None:
        with pytest.raises(ValueError, match="upload_parallelism must be >= 1"):
            self._make_uploader(mock_client, state_db, tmp_path, parallelism=0)


class TestS3SessionPoolSizing:
    """The shared S3 session's urllib3 pool must scale with parallelism.

    Default ``HTTPAdapter`` pool size is 10. With ``upload_parallelism``
    above that, urllib3 starts discarding connections after each PUT --
    every excess request opens a fresh TLS connection, defeating the
    whole point of keeping a long-lived session. The fix mounts an
    explicit adapter sized to the configured parallelism.
    """

    def _make_uploader_for_session_check(
        self,
        mock_client: MagicMock,
        state_db: StateDB,
        watch_dir: Path,
        *,
        parallelism: int,
    ) -> Uploader:
        return Uploader(
            client=mock_client,
            state_db=state_db,
            event_reporter=MagicMock(spec=EventReporter),
            counters=WatcherCounters(),
            instrument_id="test-instrument",
            watcher_id="watcher-123",
            watch_directory=watch_dir,
            upload_parallelism=parallelism,
        )

    @pytest.mark.parametrize("parallelism", [1, 4, 16, 32])
    def test_pool_maxsize_matches_parallelism(
        self,
        mock_client: MagicMock,
        state_db: StateDB,
        tmp_path: Path,
        parallelism: int,
    ) -> None:
        uploader = self._make_uploader_for_session_check(
            mock_client, state_db, tmp_path, parallelism=parallelism
        )
        # ``Session.get_adapter`` returns the abstract ``_BaseAdapter``
        # supertype; we mounted concrete ``HTTPAdapter`` instances so
        # casting is safe and unblocks the ``.poolmanager`` access.
        # Probe both schemes so the test catches a regression that
        # only mounts one.
        for scheme in ("https://", "http://"):
            adapter = cast(HTTPAdapter, uploader._s3_session.get_adapter(f"{scheme}example.com"))
            # urllib3 stores the per-pool kwargs (including
            # ``maxsize``) on ``connection_pool_kw``; ``HTTPAdapter``
            # populates it from its constructor args.
            pool_kwargs = adapter.poolmanager.connection_pool_kw
            assert pool_kwargs.get("maxsize") == parallelism, (
                f"{scheme}: expected pool maxsize={parallelism}, got {pool_kwargs.get('maxsize')}"
            )

    def test_default_session_adapter_is_replaced(
        self,
        mock_client: MagicMock,
        state_db: StateDB,
        tmp_path: Path,
    ) -> None:
        """A high-parallelism uploader must not be using requests' stock 10-conn adapter."""
        uploader = self._make_uploader_for_session_check(
            mock_client, state_db, tmp_path, parallelism=24
        )
        adapter = cast(HTTPAdapter, uploader._s3_session.get_adapter("https://s3.example.com"))
        assert adapter.poolmanager.connection_pool_kw["maxsize"] == 24


class TestPollUploadQueueCounterLocking:
    """Manual-mode poll failures must increment the shared counter under the lock.

    The optimisation introduced a parallel-upload worker pool that
    races the heartbeat thread to read/write ``_counters``. Routing
    ``poll_upload_queue``'s error bumps through ``_bump_errors``
    keeps every mutation point under ``_counters_lock`` and avoids a
    silent torn-write on the integer field.
    """

    def test_api_error_bumps_via_helper(
        self,
        uploader: Uploader,
        mock_client: MagicMock,
    ) -> None:
        mock_client.get_upload_queue.side_effect = ApiError("ACL", status_code=403)

        # Spy on the helper rather than the underlying integer so a
        # future change that swaps the lock for atomics still passes
        # without us re-writing the test.
        with patch.object(uploader, "_bump_errors", wraps=uploader._bump_errors) as spy:
            uploader.poll_upload_queue()

        spy.assert_called_once()
        assert uploader._counters.errors == 1

    def test_missing_file_bumps_via_helper(
        self,
        uploader: Uploader,
        mock_client: MagicMock,
        tmp_path: Path,
    ) -> None:
        from data_hub_watcher.models import UploadQueueFile, UploadQueueResponse

        # Queue references a file that no longer exists on disk -- the
        # manual-mode "Queued file missing" branch must increment the
        # counter via the helper, same as the auto-mode upload path.
        mock_client.get_upload_queue.return_value = UploadQueueResponse(
            files=[
                UploadQueueFile(
                    id=1,
                    instrument_id="test-instrument",
                    run_id="RUN-X",
                    filename="ghost.csv",
                    relative_path="ghost.csv",
                )
            ]
        )

        with patch.object(uploader, "_bump_errors", wraps=uploader._bump_errors) as spy:
            uploader.poll_upload_queue()

        spy.assert_called_once()
        assert uploader._counters.errors == 1


class TestPollUploadQueueAttemptCap:
    """A persistently-failing queued file is bounded, then cancelled.

    Manual-mode polling runs every heartbeat, so a stale queue entry (e.g.
    one left pointing at the old root after the watch directory changed, or
    a file that keeps failing to upload) would otherwise re-error forever.
    The watcher surfaces the visible error once, retries up to
    ``MAX_QUEUE_FILE_ATTEMPTS`` polls, then cancels the request server-side
    so it leaves the queue (ENG-1397).
    """

    @staticmethod
    def _ghost_queue() -> UploadQueueResponse:
        """A one-file queue pointing at a path that doesn't exist on disk."""
        return UploadQueueResponse(
            files=[
                UploadQueueFile(
                    id=1,
                    instrument_id="test-instrument",
                    run_id="RUN-X",
                    filename="ghost.csv",
                    relative_path="ghost.csv",
                )
            ]
        )

    def test_missing_file_errors_once_then_cancels(
        self,
        uploader: Uploader,
        mock_client: MagicMock,
    ) -> None:
        mock_client.get_upload_queue.return_value = self._ghost_queue()

        for _ in range(MAX_QUEUE_FILE_ATTEMPTS):
            uploader.poll_upload_queue()

        reporter_mock = cast(MagicMock, uploader._reporter)

        # Visible "missing" error and the error counter fire exactly once
        # across all polls (throttled), not once per heartbeat.
        assert reporter_mock.queue_event.call_count == 1
        assert uploader._counters.errors == 1

        # On the final poll the watcher gives up and cancels server-side.
        mock_client.cancel_upload_request.assert_called_once_with(1)
        reporter_mock.report_error.assert_called_once()
        assert reporter_mock.report_error.call_args.args[0] == "upload_request_cancelled"
        assert reporter_mock.report_error.call_args.kwargs["reason"] == "missing"

    def test_upload_failure_cancels_after_threshold(
        self,
        uploader: Uploader,
        mock_client: MagicMock,
        tmp_path: Path,
    ) -> None:
        (tmp_path / "data.csv").write_text("x")
        mock_client.get_upload_queue.return_value = UploadQueueResponse(
            files=[
                UploadQueueFile(
                    id=2,
                    instrument_id="test-instrument",
                    run_id="RUN-Y",
                    filename="data.csv",
                    relative_path="data.csv",
                )
            ]
        )

        # The file exists but every upload attempt fails -> cap applies to
        # upload failures too, not just missing files.
        with patch.object(uploader, "_upload_single", return_value=False):
            for _ in range(MAX_QUEUE_FILE_ATTEMPTS):
                uploader.poll_upload_queue()

        reporter_mock = cast(MagicMock, uploader._reporter)
        mock_client.cancel_upload_request.assert_called_once_with(2)
        assert reporter_mock.report_error.call_args.kwargs["reason"] == "upload_failed"

    def test_successful_upload_prunes_without_cancel(
        self,
        uploader: Uploader,
        mock_client: MagicMock,
        tmp_path: Path,
    ) -> None:
        (tmp_path / "data.csv").write_text("x")
        mock_client.get_upload_queue.return_value = UploadQueueResponse(
            files=[
                UploadQueueFile(
                    id=3,
                    instrument_id="test-instrument",
                    run_id="RUN-Z",
                    filename="data.csv",
                    relative_path="data.csv",
                )
            ]
        )

        with patch.object(uploader, "_upload_single", return_value=True):
            uploader.poll_upload_queue()

        assert 3 not in uploader._queue_attempts
        mock_client.cancel_upload_request.assert_not_called()

    def test_requeued_id_rearms_after_leaving_queue(
        self,
        uploader: Uploader,
        mock_client: MagicMock,
    ) -> None:
        mock_client.get_upload_queue.return_value = self._ghost_queue()
        reporter_mock = cast(MagicMock, uploader._reporter)

        # Two misses (stay under the threshold): error fires once, count grows.
        uploader.poll_upload_queue()
        uploader.poll_upload_queue()
        assert uploader._queue_attempts[1].count == 2
        assert reporter_mock.queue_event.call_count == 1

        # File leaves the queue -> its attempt record is pruned.
        mock_client.get_upload_queue.return_value = UploadQueueResponse(files=[])
        uploader.poll_upload_queue()
        assert 1 not in uploader._queue_attempts

        # It comes back (re-requested): the throttle re-arms and fires again.
        mock_client.get_upload_queue.return_value = self._ghost_queue()
        uploader.poll_upload_queue()
        assert reporter_mock.queue_event.call_count == 2

    def test_cancel_failure_is_retried_next_poll(
        self,
        uploader: Uploader,
        mock_client: MagicMock,
    ) -> None:
        mock_client.get_upload_queue.return_value = self._ghost_queue()
        mock_client.cancel_upload_request.side_effect = ApiError("boom", status_code=500)

        for _ in range(MAX_QUEUE_FILE_ATTEMPTS):
            uploader.poll_upload_queue()

        # Cancel attempted once on the threshold poll and it failed, so the
        # attempt record stays put and no give-up event is emitted yet.
        assert mock_client.cancel_upload_request.call_count == 1
        assert uploader._queue_attempts[1].count == MAX_QUEUE_FILE_ATTEMPTS
        cast(MagicMock, uploader._reporter).report_error.assert_not_called()

        # The next poll retries the cancel rather than re-erroring on upload.
        uploader.poll_upload_queue()
        assert mock_client.cancel_upload_request.call_count == 2


class TestUploaderStopEvent:
    """A shutdown must interrupt uploads without recording a spurious failure."""

    def _uploader_with_stop(
        self,
        mock_client: MagicMock,
        state_db: StateDB,
        tmp_path: Path,
        stop_event: threading.Event,
    ) -> Uploader:
        return Uploader(
            client=mock_client,
            state_db=state_db,
            event_reporter=MagicMock(spec=EventReporter),
            counters=WatcherCounters(),
            instrument_id="test-instrument",
            watcher_id="watcher-123",
            watch_directory=tmp_path,
            stop_event=stop_event,
        )

    def test_stop_during_backoff_defers_without_failure(
        self,
        mock_client: MagicMock,
        state_db: StateDB,
        tmp_file: Path,
        tmp_path: Path,
    ) -> None:
        stop = threading.Event()
        stop.set()  # already stopping when the first attempt fails
        up = self._uploader_with_stop(mock_client, state_db, tmp_path, stop)
        mock_client.request_upload_url.return_value = PresignedUploadResponse(
            upload_url="https://s3.example.com/presigned",
            s3_bucket="test-bucket",
            s3_key="k",
            file_id=42,
            expires_in=3600,
            already_uploaded=False,
        )

        with patch.object(
            Uploader, "_put_to_presigned_url", side_effect=ConnectionError("network down")
        ) as mock_put:
            result = up._upload_single(tmp_file, "RUN-001")

        # Deferred, not failed: one attempt, no success PATCH, no error event
        # or counter bump, so the request stays pending for the next start.
        assert result is False
        assert mock_put.call_count == 1
        mock_client.mark_file_uploaded.assert_not_called()
        assert up._counters.errors == 0
        cast(MagicMock, up._reporter).queue_event.assert_not_called()

    def test_poll_bails_between_files_when_stopping(
        self,
        mock_client: MagicMock,
        state_db: StateDB,
        tmp_path: Path,
    ) -> None:
        stop = threading.Event()
        stop.set()
        up = self._uploader_with_stop(mock_client, state_db, tmp_path, stop)
        mock_client.get_upload_queue.return_value = UploadQueueResponse(
            files=[
                UploadQueueFile(
                    id=1,
                    instrument_id="test-instrument",
                    run_id="R1",
                    filename="a.csv",
                    relative_path="a.csv",
                ),
                UploadQueueFile(
                    id=2,
                    instrument_id="test-instrument",
                    run_id="R1",
                    filename="b.csv",
                    relative_path="b.csv",
                ),
            ]
        )

        with patch.object(Uploader, "_process_queued_file") as mock_process:
            up.poll_upload_queue()

        mock_process.assert_not_called()


class TestUploadQueueWorker:
    """The worker owns the poll loop and must stop cleanly for shutdown."""

    def test_poll_once_swallows_exceptions(self) -> None:
        uploader = MagicMock()
        uploader.poll_upload_queue.side_effect = RuntimeError("boom")
        worker = UploadQueueWorker(uploader, stop_event=threading.Event())

        # A poll blowup must not escape and kill the thread.
        worker._poll_once()

        uploader.poll_upload_queue.assert_called_once_with()

    def test_stop_joins_idle_worker(self) -> None:
        uploader = MagicMock()
        worker = UploadQueueWorker(uploader, stop_event=threading.Event(), interval_seconds=60)
        worker.start()

        # The loop waits on the stop event, so setting it returns the join
        # immediately rather than after the 60s interval.
        assert worker.stop(timeout=5) is True

    def test_stop_reports_false_when_upload_in_flight(self) -> None:
        # A poll stuck mid-upload past the join timeout must report unfinished
        # so teardown skips closing the state DB out from under it.
        in_poll = threading.Event()
        release = threading.Event()

        def blocking_poll() -> None:
            in_poll.set()
            release.wait(timeout=5)

        uploader = MagicMock()
        uploader.poll_upload_queue.side_effect = blocking_poll
        # interval=0 so the loop enters the (blocking) poll right away.
        worker = UploadQueueWorker(uploader, stop_event=threading.Event(), interval_seconds=0)
        worker.start()
        assert in_poll.wait(timeout=5)

        try:
            assert worker.stop(timeout=0.1) is False
        finally:
            # Let the blocked poll finish so the daemon thread exits cleanly.
            release.set()
