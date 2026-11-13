"""Unit tests for the presigned-URL upload flow in Uploader."""

from __future__ import annotations
import _thread
import hashlib
import signal
import subprocess
import sys
import textwrap
import threading
import time
from collections.abc import Callable, Generator, Iterator
from contextlib import contextmanager, nullcontext
from pathlib import Path
from typing import cast
from unittest.mock import MagicMock, patch

import pytest
import requests
from requests.adapters import HTTPAdapter

from data_hub_watcher.api_client import ApiError
from data_hub_watcher.constants import MAX_PENDING_UPLOAD_ATTEMPTS, MAX_QUEUE_FILE_ATTEMPTS
from data_hub_watcher.events import EventReporter, EventType
from data_hub_watcher.heartbeat import WatcherCounters
from data_hub_watcher.models import (
    MultipartPartUrl,
    MultipartPartUrlsResponse,
    PresignedUploadResponse,
    UploadQueueFile,
    UploadQueueResponse,
)
from data_hub_watcher.run_detector import FileInfo
from data_hub_watcher.state import StateDB
from data_hub_watcher.uploader import (
    Uploader,
    UploadQueueWorker,
    _DaemonCalls,
    _FileSlice,
    _guess_content_type,
    _PartUrls,
    _run_workers,
    _Transfer,
    _UploadStopped,
    s3_error_details,
)
from data_hub_watcher.util import DigestCancelled, file_digests


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
        # The server derives the S3 location itself, so the watcher only
        # reports the status and content type.
        mock_client.mark_file_uploaded.assert_called_once_with(
            42,
            {
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
        assert kwargs["relative_path"] == rel_path

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
    ``for info in files`` loop onto short-lived daemon threads
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
        # life (POST run → record_report → upload_files → empty).
        state_db.record_report("RUN-EMPTY", [], new_run=True)

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
    so it leaves the queue.
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

    def test_upload_cut_off_by_a_stop_is_not_an_attempt(
        self,
        mock_client: MagicMock,
        state_db: StateDB,
        tmp_path: Path,
    ) -> None:
        (tmp_path / "data.csv").write_text("x")
        stop = threading.Event()
        up = _make_uploader(mock_client, state_db, tmp_path, parallelism=1, stop_event=stop)
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
        with patch.object(up, "_upload_single", return_value=False):
            for _ in range(MAX_QUEUE_FILE_ATTEMPTS - 1):
                up.poll_upload_queue()

        def cut_off(path: Path, run_id: str) -> bool:
            # A config rebuild stops the uploader while this file uploads.
            stop.set()
            return False

        with patch.object(up, "_upload_single", side_effect=cut_off):
            up.poll_upload_queue()

        # The last attempt isn't used up, so the request isn't cancelled and
        # the file stays in the server's queue for the next runtime.
        mock_client.cancel_upload_request.assert_not_called()
        assert up._queue_attempts[2].count == MAX_QUEUE_FILE_ATTEMPTS - 1

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


class TestUploadQueuePathTraversal:
    """A queued file whose path escapes the watch directory is refused.

    Defense-in-depth: even if a malicious or buggy server sends
    a ``relative_path`` with ``..`` segments or an absolute path, the watcher
    must never read (and upload) a file from outside its watch directory. The
    request is cancelled immediately rather than retried, since a re-poll
    would resolve to the same unsafe path.
    """

    @pytest.mark.parametrize(
        "relative_path",
        [
            "../../etc/passwd",
            "../outside.txt",
            "sub/../../escape.txt",
            "/etc/passwd",
        ],
    )
    def test_unsafe_path_is_refused_and_cancelled(
        self,
        uploader: Uploader,
        mock_client: MagicMock,
        tmp_path: Path,
        relative_path: str,
    ) -> None:
        # Create the would-be target outside the watch dir to prove that even
        # an existing file is never read when the path escapes containment.
        outside = tmp_path.parent / "escape.txt"
        outside.write_text("secret")

        mock_client.get_upload_queue.return_value = UploadQueueResponse(
            files=[
                UploadQueueFile(
                    id=99,
                    instrument_id="test-instrument",
                    run_id="RUN-EVIL",
                    filename="passwd",
                    relative_path=relative_path,
                )
            ]
        )

        with patch.object(uploader, "_upload_single") as mock_upload:
            uploader.poll_upload_queue()

        # Never read/uploaded, and the request is cancelled on the first poll.
        mock_upload.assert_not_called()
        mock_client.cancel_upload_request.assert_called_once_with(99)
        assert uploader._counters.errors == 1

        reporter_mock = cast(MagicMock, uploader._reporter)
        event = reporter_mock.queue_event.call_args.args[0]
        assert event.details["kind"] == "unsafe_upload_path"

    def test_safe_nested_relative_path_is_allowed(
        self,
        uploader: Uploader,
        mock_client: MagicMock,
        tmp_path: Path,
    ) -> None:
        nested = tmp_path / "sub" / "dir"
        nested.mkdir(parents=True)
        (nested / "data.csv").write_text("x")

        mock_client.get_upload_queue.return_value = UploadQueueResponse(
            files=[
                UploadQueueFile(
                    id=7,
                    instrument_id="test-instrument",
                    run_id="RUN-OK",
                    filename="data.csv",
                    relative_path="sub/dir/data.csv",
                )
            ]
        )

        with patch.object(uploader, "_upload_single", return_value=True) as mock_upload:
            uploader.poll_upload_queue()

        mock_upload.assert_called_once()
        mock_client.cancel_upload_request.assert_not_called()


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
        up = self._uploader_with_stop(mock_client, state_db, tmp_path, stop)
        mock_client.request_upload_url.return_value = PresignedUploadResponse(
            upload_url="https://s3.example.com/presigned",
            s3_bucket="test-bucket",
            s3_key="k",
            file_id=42,
            expires_in=3600,
            already_uploaded=False,
        )

        def fail_as_the_stop_arrives(*args: object, **kwargs: object) -> None:
            stop.set()
            raise ConnectionError("network down")

        with patch.object(
            Uploader, "_put_to_presigned_url", side_effect=fail_as_the_stop_arrives
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


class TestStopDuringPrep:
    """A stop that arrives while a file is being hashed starts no upload."""

    @staticmethod
    def _stopped_during_prep(
        mock_client: MagicMock,
        state_db: StateDB,
        tmp_path: Path,
        presigned: PresignedUploadResponse,
    ) -> tuple[Uploader, Path]:
        path = tmp_path / "big.bin"
        path.write_bytes(bytes(range(16)))
        stop = threading.Event()
        up = _make_uploader(mock_client, state_db, tmp_path, parallelism=2, stop_event=stop)

        def request_url(*args: object, **kwargs: object) -> PresignedUploadResponse:
            stop.set()
            return presigned

        mock_client.request_upload_url.side_effect = request_url
        mock_client.get_part_urls.side_effect = _part_urls
        return up, path

    @pytest.mark.parametrize("multipart", [False, True])
    def test_no_put_starts_and_nothing_is_reported(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path, multipart: bool
    ) -> None:
        presigned = (
            _multipart_presigned(part_size=4, part_count=4)
            if multipart
            else _single_presigned("big.bin")
        )
        up, path = self._stopped_during_prep(mock_client, state_db, tmp_path, presigned)

        with (
            patch.object(Uploader, "_put_to_presigned_url") as put_file,
            patch.object(up._s3_session, "put") as put_part,
        ):
            assert up._upload_single(path, "RUN-001") is False

        put_file.assert_not_called()
        put_part.assert_not_called()
        mock_client.get_part_urls.assert_not_called()
        mock_client.abort_multipart_upload.assert_not_called()
        mock_client.complete_multipart_upload.assert_not_called()
        mock_client.mark_file_uploaded.assert_not_called()
        # Deferred, not failed: no error count and no event.
        assert up._counters.errors == 0
        cast(MagicMock, up._reporter).queue_event.assert_not_called()
        stat = path.stat()
        assert not state_db.has_stat_match("big.bin", stat.st_size, stat.st_mtime)

    def test_the_file_stays_pending_for_the_next_start(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        up, path = self._stopped_during_prep(
            mock_client, state_db, tmp_path, _single_presigned("big.bin")
        )
        # The run detector records the row with the run report, before the upload starts.
        state_db.record_report("RUN-001", [], new_run=False, pending_relative_paths=["big.bin"])

        with patch.object(Uploader, "_put_to_presigned_url") as put_file:
            assert up.upload_files("RUN-001", [_file_info(path)]) == 0

        put_file.assert_not_called()
        assert [p.relative_path for p in state_db.pending_uploads()] == ["big.bin"]
        run = state_db.get_run("RUN-001")
        assert run is None or run.uploaded_at is None


class TestRequestStop:
    """`request_stop` starts no new part or file, and lets the parts in flight finish.

    A stop calls it first, before it waits for the file monitor: an auto-mode upload runs on
    the monitor's own thread, and it must stop starting parts and files as soon as the stop
    is requested, not when the upload worker is stopped a few seconds later.
    """

    def test_it_sets_the_stop_signal_but_does_not_abort(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        stop = threading.Event()
        up = _make_uploader(mock_client, state_db, tmp_path, parallelism=1, stop_event=stop)

        up.request_stop()

        assert stop.is_set()
        assert up._stop_requested()
        assert not up._abort.is_set()

    def test_without_a_stop_event_it_does_nothing(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        up = _make_uploader(mock_client, state_db, tmp_path, parallelism=1)

        up.request_stop()

        assert not up._stop_requested()

    def test_a_part_in_flight_finishes_and_no_further_part_starts(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        _write_parts_file(tmp_path, "big.bin", part_count=4, part_size=4)
        mock_client.request_upload_url.return_value = _multipart_presigned(
            part_size=4, part_count=4
        )
        mock_client.get_part_urls.side_effect = _part_urls
        up = _make_uploader(
            mock_client, state_db, tmp_path, parallelism=1, stop_event=threading.Event()
        )
        sent: list[tuple[int, int]] = []

        def put(url: str, *, data: _FileSlice, **kwargs: object) -> MagicMock:
            number = _part_number(url)
            up.request_stop()
            # The part is not cut off: its whole body is still read.
            sent.append((number, len(data.read())))
            return _etag_response(number)

        with patch.object(up._s3_session, "put", side_effect=put):
            assert up._upload_single(tmp_path / "big.bin", "RUN-001") is False

        assert sent == [(1, 4)]
        mock_client.complete_multipart_upload.assert_not_called()
        mock_client.abort_multipart_upload.assert_not_called()
        assert up._counters.errors == 0
        cast(MagicMock, up._reporter).queue_event.assert_not_called()

    def test_no_further_file_starts(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        run_dir = tmp_path / "RUN-1"
        run_dir.mkdir()
        up = _make_uploader(
            mock_client, state_db, tmp_path, parallelism=1, stop_event=threading.Event()
        )
        files = []
        for name in ("a.csv", "b.csv"):
            (run_dir / name).write_text("x")
            files.append(_file_info(run_dir / name))
        attempted: list[str] = []

        def upload(path: Path, run_id: str) -> bool:
            attempted.append(path.name)
            up.request_stop()
            return False

        with patch.object(up, "_upload_single", side_effect=upload):
            assert up.upload_files("RUN-1", files) == 0

        assert attempted == ["a.csv"]


class TestAbort:
    """`abort` cuts off PUTs and hashing in progress, and defers the file."""

    @pytest.mark.parametrize("multipart", [False, True])
    def test_a_put_in_flight_is_cut_off_and_the_file_stays_pending(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path, multipart: bool
    ) -> None:
        path = tmp_path / "big.bin"
        path.write_bytes(bytes(range(16)))
        up = _make_uploader(
            mock_client, state_db, tmp_path, parallelism=2, stop_event=threading.Event()
        )
        mock_client.request_upload_url.return_value = (
            _multipart_presigned(part_size=4, part_count=4)
            if multipart
            else _single_presigned("big.bin")
        )
        mock_client.get_part_urls.side_effect = _part_urls
        # The run detector records the row with the run report, before the upload starts.
        state_db.record_report("RUN-001", [], new_run=False, pending_relative_paths=["big.bin"])
        bytes_sent: list[int] = []

        def put(url: str, *, data: _FileSlice, **kwargs: object) -> MagicMock:
            # The owner gives up while this body is being sent.
            bytes_sent.append(len(data.read(1)))
            up.abort()
            data.read(1)
            return _etag_response(1)

        with patch.object(up._s3_session, "put", side_effect=put):
            assert up.upload_files("RUN-001", [_file_info(path)]) == 0

        assert bytes_sent and all(sent == 1 for sent in bytes_sent)
        # Deferred, not failed: nothing finished, aborted, reported or counted.
        mock_client.complete_multipart_upload.assert_not_called()
        mock_client.abort_multipart_upload.assert_not_called()
        mock_client.mark_file_uploaded.assert_not_called()
        assert up._counters.errors == 0
        cast(MagicMock, up._reporter).queue_event.assert_not_called()
        assert [p.relative_path for p in state_db.pending_uploads()] == ["big.bin"]

    def test_hashing_is_cut_off_without_a_failure(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        path = tmp_path / "big.bin"
        path.write_bytes(bytes(range(16)))
        up = _make_uploader(mock_client, state_db, tmp_path, parallelism=1)
        mock_client.request_upload_url.return_value = _single_presigned("big.bin")

        def digests(file_path: Path, cancel: threading.Event) -> tuple[str, str]:
            up.abort()
            return file_digests(file_path, cancel)

        with (
            patch("data_hub_watcher.uploader.file_digests", side_effect=digests),
            patch.object(Uploader, "_put_to_presigned_url") as put_file,
        ):
            assert up._upload_single(path, "RUN-001") is False

        put_file.assert_not_called()
        assert up._counters.errors == 0
        cast(MagicMock, up._reporter).queue_event.assert_not_called()

    def test_file_digests_stops_once_cancelled(self, tmp_path: Path) -> None:
        path = tmp_path / "big.bin"
        path.write_bytes(bytes(range(16)))
        cancel = threading.Event()
        cancel.set()

        with pytest.raises(DigestCancelled):
            file_digests(path, cancel)


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

    def test_retries_pending_uploads_before_the_first_poll(self) -> None:
        uploader = MagicMock()
        stop = threading.Event()
        stop.set()  # exit the poll loop right after the retry
        worker = UploadQueueWorker(uploader, stop_event=stop, retry_pending_on_start=True)

        worker._run()

        uploader.retry_pending_uploads.assert_called_once_with()
        uploader.poll_upload_queue.assert_not_called()

    def test_skips_the_pending_retry_by_default(self) -> None:
        uploader = MagicMock()
        stop = threading.Event()
        stop.set()
        worker = UploadQueueWorker(uploader, stop_event=stop)

        worker._run()

        uploader.retry_pending_uploads.assert_not_called()

    def test_a_failed_pending_retry_does_not_end_the_worker(self) -> None:
        uploader = MagicMock()
        uploader.retry_pending_uploads.side_effect = RuntimeError("boom")
        stop = threading.Event()
        stop.set()
        worker = UploadQueueWorker(uploader, stop_event=stop, retry_pending_on_start=True)

        # Must return normally so the thread goes on to poll the queue.
        worker._run()


class TestSameFileUploadsOneAtATime:
    """The auto path and the queue worker can reach the same file.

    A second multipart start makes the server abort the first upload, so
    only one thread may upload a given file at a time.
    """

    def test_second_upload_waits_for_the_first(self, uploader: Uploader, tmp_file: Path) -> None:
        first_started = threading.Event()
        second_started = threading.Event()
        release_first = threading.Event()
        calls: list[str] = []
        calls_lock = threading.Lock()

        def fake_upload(path: Path, run_id: str) -> bool:
            with calls_lock:
                calls.append(run_id)
                is_first = len(calls) == 1
            if is_first:
                first_started.set()
                release_first.wait(timeout=5)
            else:
                second_started.set()
            return True

        results: list[bool] = []
        with patch.object(uploader, "_upload_single_unlocked", side_effect=fake_upload):
            first = threading.Thread(
                target=lambda: results.append(uploader._upload_single(tmp_file, "RUN-001"))
            )
            first.start()
            assert first_started.wait(timeout=5)
            second = threading.Thread(
                target=lambda: results.append(uploader._upload_single(tmp_file, "RUN-001"))
            )
            second.start()

            assert not second_started.wait(timeout=0.3)

            release_first.set()
            first.join(timeout=5)
            second.join(timeout=5)

        assert second_started.is_set()
        assert results == [True, True]

    def test_waiter_skips_a_file_the_other_upload_recorded(
        self, uploader: Uploader, tmp_file: Path, state_db: StateDB
    ) -> None:
        st = tmp_file.stat()
        state_db.record_upload(
            tmp_file.name,
            "sha",
            "test-instrument/RUN-001/test_data.csv",
            relative_path=tmp_file.relative_to(uploader._watch_dir).as_posix(),
            size_bytes=st.st_size,
            mtime=st.st_mtime,
        )

        with (
            patch.object(Uploader, "_exclusive", lambda self, path: nullcontext(True)),
            patch.object(uploader, "_upload_single_unlocked") as unlocked,
        ):
            assert uploader._upload_single(tmp_file, "RUN-001") is True

        unlocked.assert_not_called()

    def test_waiter_uploads_when_the_other_upload_failed(
        self, uploader: Uploader, tmp_file: Path
    ) -> None:
        with (
            patch.object(Uploader, "_exclusive", lambda self, path: nullcontext(True)),
            patch.object(uploader, "_upload_single_unlocked", return_value=True) as unlocked,
        ):
            assert uploader._upload_single(tmp_file, "RUN-001") is True

        unlocked.assert_called_once_with(tmp_file, "RUN-001")


def _file_info(path: Path) -> FileInfo:
    st = path.stat()
    return FileInfo(path=path, filename=path.name, size_bytes=st.st_size, mtime=st.st_mtime)


class TestPendingUploads:
    """Auto-mode uploads that fail or are interrupted are retried on the next start."""

    @pytest.fixture()
    def run_dir(self, tmp_path: Path) -> Path:
        run_dir = tmp_path / "RUN-1"
        run_dir.mkdir()
        return run_dir

    def test_upload_files_keeps_only_failed_files_pending(
        self, uploader: Uploader, state_db: StateDB, run_dir: Path
    ) -> None:
        ok = run_dir / "ok.csv"
        ok.write_text("ok")
        bad = run_dir / "bad.csv"
        bad.write_text("bad")
        # The run detector records the rows with the run report, before the upload starts.
        state_db.record_report(
            "RUN-1", [], new_run=False, pending_relative_paths=["RUN-1/ok.csv", "RUN-1/bad.csv"]
        )

        with patch.object(uploader, "_upload_single", side_effect=lambda path, run_id: path == ok):
            assert uploader.upload_files("RUN-1", [_file_info(ok), _file_info(bad)]) == 1

        assert [p.relative_path for p in state_db.pending_uploads()] == ["RUN-1/bad.csv"]

    def test_a_stop_leaves_the_files_that_did_not_start_pending(
        self, mock_client: MagicMock, state_db: StateDB, run_dir: Path
    ) -> None:
        stop = threading.Event()
        up = _make_uploader(mock_client, state_db, run_dir.parent, parallelism=1, stop_event=stop)
        files = []
        for name in ("a.csv", "b.csv", "c.csv"):
            (run_dir / name).write_text("x")
            files.append(_file_info(run_dir / name))
        # The run detector records the rows with the run report, before the upload starts.
        state_db.record_report(
            "RUN-1",
            [],
            new_run=False,
            pending_relative_paths=[f"RUN-1/{f.filename}" for f in files],
        )
        attempted: list[str] = []

        def upload(path: Path, run_id: str) -> bool:
            attempted.append(path.name)
            stop.set()
            return False

        with patch.object(up, "_upload_single", side_effect=upload):
            assert up.upload_files("RUN-1", files) == 0

        # The first file was cut off, and the others never started. All three
        # keep their rows, which the next start's retry picks up.
        assert attempted == ["a.csv"]
        assert [p.relative_path for p in state_db.pending_uploads()] == [
            "RUN-1/a.csv",
            "RUN-1/b.csv",
            "RUN-1/c.csv",
        ]

    def test_retry_uploads_a_pending_file_and_clears_it(
        self, uploader: Uploader, state_db: StateDB, run_dir: Path
    ) -> None:
        (run_dir / "data.csv").write_text("x")
        state_db.record_report(
            "RUN-1", [], new_run=False, pending_relative_paths=["RUN-1/data.csv"]
        )

        with patch.object(uploader, "_upload_single", return_value=True) as upload:
            uploader.retry_pending_uploads()

        upload.assert_called_once_with(run_dir / "data.csv", "RUN-1")
        assert state_db.pending_uploads() == []

    def test_retry_counts_a_failure_and_keeps_the_file_pending(
        self, uploader: Uploader, state_db: StateDB, run_dir: Path
    ) -> None:
        (run_dir / "data.csv").write_text("x")
        state_db.record_report(
            "RUN-1", [], new_run=False, pending_relative_paths=["RUN-1/data.csv"]
        )

        with patch.object(uploader, "_upload_single", return_value=False):
            uploader.retry_pending_uploads()

        [pending] = state_db.pending_uploads()
        assert pending.attempts == 1
        cast(MagicMock, uploader._reporter).report_error.assert_not_called()

    def test_retry_gives_up_after_the_attempt_cap(
        self, uploader: Uploader, state_db: StateDB, run_dir: Path
    ) -> None:
        (run_dir / "data.csv").write_text("x")
        state_db.record_report(
            "RUN-1", [], new_run=False, pending_relative_paths=["RUN-1/data.csv"]
        )

        with patch.object(uploader, "_upload_single", return_value=False):
            for _ in range(MAX_PENDING_UPLOAD_ATTEMPTS):
                uploader.retry_pending_uploads()

        assert state_db.pending_uploads() == []
        report_error = cast(MagicMock, uploader._reporter).report_error
        report_error.assert_called_once()
        assert report_error.call_args.args[0] == "upload_retries_exhausted"
        assert report_error.call_args.kwargs == {
            "relative_path": "RUN-1/data.csv",
            "run_id": "RUN-1",
            "attempts": MAX_PENDING_UPLOAD_ATTEMPTS,
        }

    def test_retry_counts_an_unexpected_error_and_moves_on(
        self, uploader: Uploader, state_db: StateDB, run_dir: Path
    ) -> None:
        (run_dir / "broken.csv").write_text("x")
        (run_dir / "fine.csv").write_text("x")
        state_db.record_report(
            "RUN-1",
            [],
            new_run=False,
            pending_relative_paths=["RUN-1/broken.csv", "RUN-1/fine.csv"],
        )

        def upload(path: Path, run_id: str) -> bool:
            if path.name == "broken.csv":
                raise ValueError("unexpected response")
            return True

        with patch.object(uploader, "_upload_single", side_effect=upload) as upload_mock:
            uploader.retry_pending_uploads()

        assert [call.args[0].name for call in upload_mock.call_args_list] == [
            "broken.csv",
            "fine.csv",
        ]
        [pending] = state_db.pending_uploads()
        assert (pending.relative_path, pending.attempts) == ("RUN-1/broken.csv", 1)

    def test_retry_drops_a_file_that_is_gone(self, uploader: Uploader, state_db: StateDB) -> None:
        state_db.record_report(
            "RUN-1", [], new_run=False, pending_relative_paths=["RUN-1/deleted.csv"]
        )

        with patch.object(uploader, "_upload_single") as upload:
            uploader.retry_pending_uploads()

        upload.assert_not_called()
        assert state_db.pending_uploads() == []
        report_error = cast(MagicMock, uploader._reporter).report_error
        report_error.assert_called_once()
        assert report_error.call_args.args[0] == "pending_upload_missing"
        assert report_error.call_args.kwargs == {
            "relative_path": "RUN-1/deleted.csv",
            "run_id": "RUN-1",
        }

    def test_retry_interrupted_by_shutdown_is_not_an_attempt(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path, run_dir: Path
    ) -> None:
        stop = threading.Event()
        up = Uploader(
            client=mock_client,
            state_db=state_db,
            event_reporter=MagicMock(spec=EventReporter),
            counters=WatcherCounters(),
            instrument_id="test-instrument",
            watcher_id="watcher-123",
            watch_directory=tmp_path,
            stop_event=stop,
        )
        (run_dir / "data.csv").write_text("x")
        state_db.record_report(
            "RUN-1", [], new_run=False, pending_relative_paths=["RUN-1/data.csv"]
        )

        def interrupted(path: Path, run_id: str) -> bool:
            stop.set()
            return False

        with patch.object(up, "_upload_single", side_effect=interrupted):
            up.retry_pending_uploads()

        [pending] = state_db.pending_uploads()
        assert pending.attempts == 0


class TestSignedUrlRedaction:
    """Signed S3 URLs carry temporary AWS credentials, so events and logs drop the query."""

    def test_http_error_url_loses_its_query_string(self) -> None:
        exc = requests.HTTPError(
            "400 Client Error: Bad Request for url: "
            "https://bucket.s3.us-west-1.amazonaws.com/instrument/run/big.tif"
            "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=ASIAEXAMPLE"
            "&X-Amz-Security-Token=SECRET-TOKEN&X-Amz-Signature=deadbeef&x-id=PutObject"
        )

        assert s3_error_details(exc)["error"] == (
            "400 Client Error: Bad Request for url: "
            "https://bucket.s3.us-west-1.amazonaws.com/instrument/run/big.tif?<redacted>"
        )

    def test_connection_error_url_loses_its_query_string(self) -> None:
        exc = requests.ConnectionError(
            "HTTPSConnectionPool(host='bucket.s3.amazonaws.com', port=443): Max retries "
            "exceeded with url: /instrument/run/big.tif?partNumber=3&uploadId=abc"
            "&X-Amz-Security-Token=SECRET-TOKEN&x-id=UploadPart "
            "(Caused by SSLError('EOF occurred'))"
        )

        error = s3_error_details(exc)["error"]

        assert "SECRET-TOKEN" not in error
        assert "/instrument/run/big.tif?<redacted> (Caused by SSLError('EOF occurred'))" in error

    def test_upload_failed_event_has_no_signed_query(
        self, uploader: Uploader, mock_client: MagicMock, tmp_file: Path
    ) -> None:
        mock_client.request_upload_url.return_value = PresignedUploadResponse(
            upload_url="https://s3.example.com/presigned",
            s3_bucket="test-bucket",
            s3_key="test-instrument/RUN-001/test_data.csv",
            file_id=42,
            expires_in=3600,
            already_uploaded=False,
        )
        failure = requests.HTTPError(
            "400 Client Error: Bad Request for url: "
            "https://s3.example.com/presigned?X-Amz-Security-Token=SECRET-TOKEN"
        )

        with (
            patch.object(Uploader, "_put_to_presigned_url", side_effect=failure),
            patch("data_hub_watcher.uploader.time.sleep"),
        ):
            assert uploader._upload_single(tmp_file, "RUN-001") is False

        event = cast(MagicMock, uploader._reporter).queue_event.call_args.args[0]
        assert "SECRET-TOKEN" not in event.details["error"]


def test_guess_content_type_handles_uppercase_pdf() -> None:
    assert _guess_content_type(Path("Experiment_Report.PDF")) == "application/pdf"


def test_guess_content_type_falls_back_for_unknown_extension() -> None:
    assert _guess_content_type(Path("Experiment_20000101000000.AZE")) == "application/octet-stream"


def _http_error(status: int, xml: str) -> requests.HTTPError:
    response = MagicMock()
    response.status_code = status
    response.text = xml
    return requests.HTTPError(response=response)


class TestMultipartUpload:
    def _presigned(self, *, part_size: int, part_count: int) -> PresignedUploadResponse:
        return PresignedUploadResponse(
            upload_type="multipart",
            upload_id="abc123",
            part_size=part_size,
            part_count=part_count,
            s3_bucket="test-bucket",
            s3_key="test-instrument/RUN-001/test_data.csv",
            file_id=42,
            expires_in=900,
            already_uploaded=False,
        )

    def test_uploads_each_part_and_finishes(
        self,
        uploader: Uploader,
        mock_client: MagicMock,
        tmp_file: Path,
    ) -> None:
        payload = tmp_file.read_bytes()
        mock_client.request_upload_url.return_value = self._presigned(
            part_size=len(payload), part_count=1
        )
        mock_client.get_part_urls.return_value = MultipartPartUrlsResponse(
            expires_in=900,
            parts=[MultipartPartUrl(part_number=1, upload_url="https://s3.example/1")],
        )
        response = MagicMock()
        response.headers = {"ETag": '"etag-1"'}
        with patch.object(uploader._s3_session, "put", return_value=response):
            assert uploader._upload_single(tmp_file, "RUN-001") is True
        mock_client.complete_multipart_upload.assert_called_once()
        mock_client.mark_file_uploaded.assert_not_called()
        assert uploader._counters.files_uploaded == 1

    def test_refreshes_an_expired_part_url(
        self,
        uploader: Uploader,
        mock_client: MagicMock,
        tmp_file: Path,
    ) -> None:
        payload = tmp_file.read_bytes()
        mock_client.request_upload_url.return_value = self._presigned(
            part_size=len(payload), part_count=1
        )
        mock_client.get_part_urls.side_effect = [
            MultipartPartUrlsResponse(
                expires_in=900,
                parts=[MultipartPartUrl(part_number=1, upload_url="https://s3.example/old")],
            ),
            MultipartPartUrlsResponse(
                expires_in=900,
                parts=[MultipartPartUrl(part_number=1, upload_url="https://s3.example/new")],
            ),
        ]
        expired = _http_error(
            403,
            "<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>",
        )
        ok = MagicMock()
        ok.headers = {"ETag": '"etag-1"'}
        with (
            patch.object(uploader._s3_session, "put", side_effect=[expired, ok]),
            patch("data_hub_watcher.uploader.time.sleep"),
        ):
            assert uploader._upload_single(tmp_file, "RUN-001") is True
        assert mock_client.get_part_urls.call_count == 2

    def test_connection_error_fetches_a_fresh_part_url(
        self,
        uploader: Uploader,
        mock_client: MagicMock,
        tmp_file: Path,
    ) -> None:
        payload = tmp_file.read_bytes()
        mock_client.request_upload_url.return_value = self._presigned(
            part_size=len(payload), part_count=1
        )
        mock_client.get_part_urls.side_effect = [
            MultipartPartUrlsResponse(
                expires_in=900,
                parts=[MultipartPartUrl(part_number=1, upload_url="https://s3.example/old")],
            ),
            MultipartPartUrlsResponse(
                expires_in=900,
                parts=[MultipartPartUrl(part_number=1, upload_url="https://s3.example/new")],
            ),
        ]
        ok = MagicMock()
        ok.headers = {"ETag": '"etag-1"'}
        put = MagicMock(side_effect=[requests.ConnectionError("reset"), ok])
        with (
            patch.object(uploader._s3_session, "put", put),
            patch("data_hub_watcher.uploader.time.sleep"),
        ):
            assert uploader._upload_single(tmp_file, "RUN-001") is True
        assert put.call_args_list[0].args[0] == "https://s3.example/old"
        assert put.call_args_list[1].args[0] == "https://s3.example/new"
        assert mock_client.get_part_urls.call_count == 2

    def test_other_403_aborts_and_records_the_s3_error(
        self,
        uploader: Uploader,
        mock_client: MagicMock,
        tmp_file: Path,
    ) -> None:
        payload = tmp_file.read_bytes()
        mock_client.request_upload_url.return_value = self._presigned(
            part_size=len(payload), part_count=1
        )
        mock_client.get_part_urls.return_value = MultipartPartUrlsResponse(
            expires_in=900,
            parts=[MultipartPartUrl(part_number=1, upload_url="https://s3.example/1")],
        )
        denied = _http_error(
            403,
            "<Error><Code>SignatureDoesNotMatch</Code><Message>bad signature</Message></Error>",
        )
        with (
            patch.object(uploader._s3_session, "put", side_effect=denied),
            patch("data_hub_watcher.uploader.time.sleep"),
        ):
            assert uploader._upload_single(tmp_file, "RUN-001") is False
        mock_client.abort_multipart_upload.assert_called_once_with(42, "abc123")
        event = cast(MagicMock, uploader._reporter).queue_event.call_args.args[0]
        assert event.details["s3_code"] == "SignatureDoesNotMatch"
        assert "bad signature" in event.details["error"]

    def test_bad_digest_starts_the_file_over_once(
        self,
        uploader: Uploader,
        mock_client: MagicMock,
        tmp_file: Path,
    ) -> None:
        payload = tmp_file.read_bytes()
        first = self._presigned(part_size=len(payload), part_count=1)
        second = self._presigned(part_size=len(payload), part_count=1)
        second.upload_id = "def456"
        mock_client.request_upload_url.side_effect = [first, second]
        mock_client.get_part_urls.return_value = MultipartPartUrlsResponse(
            expires_in=900,
            parts=[MultipartPartUrl(part_number=1, upload_url="https://s3.example/1")],
        )
        response = MagicMock()
        response.headers = {"ETag": '"etag-1"'}
        mock_client.complete_multipart_upload.side_effect = [
            ApiError(
                "checksum",
                status_code=400,
                detail=MagicMock(code="BadDigest"),
            ),
            MagicMock(),
        ]
        with patch.object(uploader._s3_session, "put", return_value=response):
            assert uploader._upload_single(tmp_file, "RUN-001") is True
        assert mock_client.complete_multipart_upload.call_count == 2
        assert mock_client.request_upload_url.call_count == 2


def test_single_put_records_the_s3_error_body(
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
    too_large = _http_error(
        400,
        "<Error><Code>EntityTooLarge</Code><Message>too big</Message></Error>",
    )
    with (
        patch.object(Uploader, "_put_to_presigned_url", side_effect=too_large),
        patch("data_hub_watcher.uploader.time.sleep"),
    ):
        assert uploader._upload_single(tmp_file, "RUN-001") is False
    event = cast(MagicMock, uploader._reporter).queue_event.call_args.args[0]
    assert event.details["s3_code"] == "EntityTooLarge"


# ---------------------------------------------------------------------------
# Parallel uploads: one budget of simultaneous PUTs for files and parts
# ---------------------------------------------------------------------------


def _make_uploader(
    mock_client: MagicMock,
    state_db: StateDB,
    watch_dir: Path,
    *,
    parallelism: int,
    stop_event: threading.Event | None = None,
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
        stop_event=stop_event,
    )


def _multipart_presigned(*, part_size: int, part_count: int) -> PresignedUploadResponse:
    return PresignedUploadResponse(
        upload_type="multipart",
        upload_id="abc123",
        part_size=part_size,
        part_count=part_count,
        s3_bucket="test-bucket",
        s3_key="test-instrument/RUN-001/test_data.csv",
        file_id=42,
        expires_in=900,
        already_uploaded=False,
    )


def _single_presigned(name: str) -> PresignedUploadResponse:
    return PresignedUploadResponse(
        upload_url=f"https://s3.example.com/single/{name}",
        s3_bucket="test-bucket",
        s3_key=f"test-instrument/RUN-001/{name}",
        file_id=7,
        expires_in=3600,
        already_uploaded=False,
    )


def _part_urls(file_id: int, upload_id: str, numbers: list[int]) -> MultipartPartUrlsResponse:
    return MultipartPartUrlsResponse(
        expires_in=900,
        parts=[
            MultipartPartUrl(part_number=n, upload_url=f"https://s3.example/part/{n}")
            for n in numbers
        ],
    )


def _part_number(url: str) -> int:
    return int(url.rsplit("/", 1)[1])


def _etag_response(part_number: int) -> MagicMock:
    response = MagicMock()
    response.headers = {"ETag": f'"etag-{part_number}"'}
    return response


def _write_parts_file(directory: Path, name: str, *, part_count: int, part_size: int) -> bytes:
    payload = bytes(i % 251 for i in range(part_count * part_size))
    (directory / name).write_bytes(payload)
    return payload


@pytest.fixture()
def ctrl_c_is_delivered() -> Iterator[None]:
    """Make Python turn SIGINT into `KeyboardInterrupt` for the test.

    A shell starts a background job with SIGINT ignored, and `interrupt_main`
    does nothing then. Signal handlers can only be set on the main thread,
    which is where pytest runs a test.
    """
    previous = signal.signal(signal.SIGINT, signal.default_int_handler)
    try:
        yield
    finally:
        signal.signal(signal.SIGINT, previous)


def _press_ctrl_c() -> None:
    """Call from a worker thread to deliver Ctrl-C to the main thread, which waits for the workers.

    Tests that use this need the `ctrl_c_is_delivered` fixture. The pause lets
    the main thread reach its wait first. `interrupt_main` does not wake a
    thread that is blocked with no timeout: the interrupt shows up only when
    that wait ends, so a wait with no timeout fails the tests that use this.
    """
    time.sleep(0.2)
    _thread.interrupt_main()


def _wait_until_no_threads(prefix: str, timeout: float = 5) -> None:
    """Wait for the worker threads whose names start with *prefix* to exit."""
    deadline = time.monotonic() + timeout
    while any(t.name.startswith(prefix) for t in threading.enumerate()):
        assert time.monotonic() < deadline, f"{prefix} threads are still running"
        time.sleep(0.01)


class _Concurrency:
    """Counts how many tracked calls run at the same time."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.running = 0
        self.peak = 0

    @contextmanager
    def track(self) -> Iterator[None]:
        with self._lock:
            self.running += 1
            self.peak = max(self.peak, self.running)
        try:
            yield
        finally:
            with self._lock:
                self.running -= 1


class TestParallelParts:
    """The parts of one large file upload at the same time, up to the budget."""

    def test_parts_overlap_up_to_the_budget(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        payload = _write_parts_file(tmp_path, "big.bin", part_count=8, part_size=4)
        mock_client.request_upload_url.return_value = _multipart_presigned(
            part_size=4, part_count=8
        )
        mock_client.get_part_urls.side_effect = _part_urls
        up = _make_uploader(mock_client, state_db, tmp_path, parallelism=4)
        # Four PUTs must be inside the stub together. Serial parts would break
        # the barrier and the part would fail.
        barrier = threading.Barrier(4, timeout=3)
        tracker = _Concurrency()
        sent: dict[int, bytes] = {}

        def put(url: str, data: _FileSlice, headers: dict[str, str], timeout: int) -> MagicMock:
            number = _part_number(url)
            with tracker.track():
                barrier.wait()
                sent[number] = data.read()
            return _etag_response(number)

        with (
            patch.object(up._s3_session, "put", side_effect=put),
            patch("data_hub_watcher.uploader.time.sleep"),
        ):
            assert up._upload_single(tmp_path / "big.bin", "RUN-001") is True

        assert tracker.peak == 4
        # Every part sent its own byte range.
        assert b"".join(sent[n] for n in sorted(sent)) == payload
        parts = mock_client.complete_multipart_upload.call_args.args[2]
        assert parts == [{"part_number": n, "etag": f'"etag-{n}"'} for n in range(1, 9)]

    def test_parts_that_finish_out_of_order_complete_in_order(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        _write_parts_file(tmp_path, "big.bin", part_count=4, part_size=4)
        mock_client.request_upload_url.return_value = _multipart_presigned(
            part_size=4, part_count=4
        )
        mock_client.get_part_urls.side_effect = _part_urls
        up = _make_uploader(mock_client, state_db, tmp_path, parallelism=4)
        part_four_done = threading.Event()
        finished: list[int] = []

        def put(url: str, **kwargs: object) -> MagicMock:
            number = _part_number(url)
            if number == 1:
                assert part_four_done.wait(timeout=2)
            finished.append(number)
            if number == 4:
                part_four_done.set()
            return _etag_response(number)

        with (
            patch.object(up._s3_session, "put", side_effect=put),
            patch("data_hub_watcher.uploader.time.sleep"),
        ):
            assert up._upload_single(tmp_path / "big.bin", "RUN-001") is True

        assert finished.index(4) < finished.index(1)
        parts = mock_client.complete_multipart_upload.call_args.args[2]
        assert [part["part_number"] for part in parts] == [1, 2, 3, 4]
        assert [part["etag"] for part in parts] == [f'"etag-{n}"' for n in range(1, 5)]

    def test_part_urls_come_in_batches_of_eight(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        _write_parts_file(tmp_path, "big.bin", part_count=21, part_size=4)
        mock_client.request_upload_url.return_value = _multipart_presigned(
            part_size=4, part_count=21
        )
        mock_client.get_part_urls.side_effect = _part_urls
        up = _make_uploader(mock_client, state_db, tmp_path, parallelism=4)

        def put(url: str, **kwargs: object) -> MagicMock:
            return _etag_response(_part_number(url))

        with patch.object(up._s3_session, "put", side_effect=put):
            assert up._upload_single(tmp_path / "big.bin", "RUN-001") is True

        requested = sorted(call.args[2] for call in mock_client.get_part_urls.call_args_list)
        assert requested == [list(range(1, 9)), list(range(9, 17)), list(range(17, 22))]

    def test_a_failed_part_stops_the_parts_that_have_not_started(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        _write_parts_file(tmp_path, "big.bin", part_count=6, part_size=4)
        mock_client.request_upload_url.return_value = _multipart_presigned(
            part_size=4, part_count=6
        )
        up = _make_uploader(mock_client, state_db, tmp_path, parallelism=2)
        started: list[int] = []
        workers_alive_at_abort: list[list[str]] = []

        def fake_put_one_part(
            self_: Uploader,
            path: Path,
            urls: _PartUrls,
            part_number: int,
            part_size: int,
            size_bytes: int,
            cancel: threading.Event,
            transfer: object,
        ) -> str:
            started.append(part_number)
            if part_number == 2:
                raise RuntimeError("part 2 ran out of retries")
            # Part 1 is in flight. It ends only after the failure cancels the
            # file, and it takes a moment to wind down.
            assert cancel.wait(timeout=5)
            time.sleep(0.2)
            raise _UploadStopped

        def record_abort(file_id: int, upload_id: str) -> None:
            workers_alive_at_abort.append(
                [t.name for t in threading.enumerate() if t.name.startswith("upload-part")]
            )

        mock_client.abort_multipart_upload.side_effect = record_abort

        with patch.object(Uploader, "_put_one_part", new=fake_put_one_part):
            assert up._upload_single(tmp_path / "big.bin", "RUN-001") is False

        assert sorted(started) == [1, 2]
        mock_client.abort_multipart_upload.assert_called_once_with(42, "abc123")
        # The abort came after every part worker had exited.
        assert workers_alive_at_abort == [[]]
        mock_client.complete_multipart_upload.assert_not_called()
        reporter = cast(MagicMock, up._reporter)
        reporter.queue_event.assert_called_once()
        assert reporter.queue_event.call_args.args[0].event_type == EventType.UPLOAD_FAILED
        assert up._counters.errors == 1

    def test_a_refused_part_url_request_fails_the_file_once_after_the_parts_in_flight_end(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        _write_parts_file(tmp_path, "big.bin", part_count=3, part_size=4)
        mock_client.request_upload_url.return_value = _multipart_presigned(
            part_size=4, part_count=3
        )
        up = _make_uploader(mock_client, state_db, tmp_path, parallelism=3)
        all_in_flight = threading.Barrier(3, timeout=5)
        refused = threading.Event()
        events: list[str] = []
        events_lock = threading.Lock()
        url_requests: list[list[int]] = []
        part_three_puts = [0]

        def note(what: str) -> None:
            with events_lock:
                events.append(what)

        def get_part_urls(
            file_id: int, upload_id: str, numbers: list[int]
        ) -> MultipartPartUrlsResponse:
            url_requests.append(list(numbers))
            if numbers == [3]:
                # Part 3's retry asks for a URL of its own, and is refused.
                refused.set()
                raise ApiError("not found", status_code=404)
            return _part_urls(file_id, upload_id, numbers)

        def put(url: str, **kwargs: object) -> MagicMock:
            number = _part_number(url)
            all_in_flight.wait()
            if number == 3:
                part_three_puts[0] += 1
                raise requests.ConnectionError("reset")
            # Parts 1 and 2 are still sending when part 3 fails.
            refused.wait(timeout=5)
            time.sleep(0.1)
            note(f"part {number} done")
            return _etag_response(number)

        mock_client.get_part_urls.side_effect = get_part_urls
        mock_client.abort_multipart_upload.side_effect = lambda *args: note("abort")

        with (
            patch.object(up._s3_session, "put", side_effect=put),
            patch.object(Uploader, "_part_backoff"),
        ):
            assert up._upload_single(tmp_path / "big.bin", "RUN-001") is False

        # Part 3 was not retried after the 4xx, and the file failed once.
        assert part_three_puts == [1]
        assert url_requests.count([3]) == 1
        reporter = cast(MagicMock, up._reporter)
        reporter.queue_event.assert_called_once()
        assert reporter.queue_event.call_args.args[0].event_type == EventType.UPLOAD_FAILED
        assert up._counters.errors == 1
        # The abort came once, after the parts in flight had finished.
        assert sorted(events[:2]) == ["part 1 done", "part 2 done"]
        assert events[2:] == ["abort"]
        mock_client.complete_multipart_upload.assert_not_called()

    def test_a_stop_lets_parts_in_flight_finish_and_defers_the_file(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        _write_parts_file(tmp_path, "big.bin", part_count=6, part_size=4)
        mock_client.request_upload_url.return_value = _multipart_presigned(
            part_size=4, part_count=6
        )
        mock_client.get_part_urls.side_effect = _part_urls
        stop = threading.Event()
        up = _make_uploader(mock_client, state_db, tmp_path, parallelism=2, stop_event=stop)
        both_in_flight = threading.Barrier(2, timeout=3)
        sent: list[int] = []
        sent_lock = threading.Lock()

        def put(url: str, **kwargs: object) -> MagicMock:
            number = _part_number(url)
            with sent_lock:
                sent.append(number)
            both_in_flight.wait()
            stop.set()
            return _etag_response(number)

        with patch.object(up._s3_session, "put", side_effect=put):
            assert up._upload_single(tmp_path / "big.bin", "RUN-001") is False

        # Parts 1 and 2 were in flight and finished. No other part started.
        assert sorted(sent) == [1, 2]
        mock_client.abort_multipart_upload.assert_not_called()
        mock_client.complete_multipart_upload.assert_not_called()
        mock_client.mark_file_uploaded.assert_not_called()
        assert up._counters.errors == 0
        cast(MagicMock, up._reporter).queue_event.assert_not_called()

    def test_a_stop_after_the_last_part_still_completes_the_file(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        _write_parts_file(tmp_path, "big.bin", part_count=1, part_size=4)
        mock_client.request_upload_url.return_value = _multipart_presigned(
            part_size=4, part_count=1
        )
        mock_client.get_part_urls.side_effect = _part_urls
        stop = threading.Event()
        up = _make_uploader(mock_client, state_db, tmp_path, parallelism=2, stop_event=stop)

        def put(url: str, **kwargs: object) -> MagicMock:
            stop.set()
            return _etag_response(1)

        with patch.object(up._s3_session, "put", side_effect=put):
            assert up._upload_single(tmp_path / "big.bin", "RUN-001") is True

        mock_client.complete_multipart_upload.assert_called_once()

    @pytest.mark.usefixtures("ctrl_c_is_delivered")
    def test_ctrl_c_while_parts_are_in_flight_stops_new_parts(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        _write_parts_file(tmp_path, "big.bin", part_count=6, part_size=4)
        mock_client.request_upload_url.return_value = _multipart_presigned(
            part_size=4, part_count=6
        )
        up = _make_uploader(mock_client, state_db, tmp_path, parallelism=2)
        started: list[int] = []
        saw_cancel: list[bool] = []

        def fake_put_one_part(
            self_: Uploader,
            path: Path,
            urls: _PartUrls,
            part_number: int,
            part_size: int,
            size_bytes: int,
            cancel: threading.Event,
            transfer: object,
        ) -> str:
            started.append(part_number)
            if part_number == 1:
                _press_ctrl_c()
            saw_cancel.append(cancel.wait(timeout=5))
            return f'"etag-{part_number}"'

        with (
            patch.object(Uploader, "_put_one_part", new=fake_put_one_part),
            pytest.raises(KeyboardInterrupt),
        ):
            up._upload_single(tmp_path / "big.bin", "RUN-001")
        _wait_until_no_threads("upload-part")

        # The wait was interrupted, so the parts were cancelled. A worker that
        # had claimed a part saw the cancel and claimed no more.
        assert len(started) <= 2
        assert saw_cancel
        assert all(saw_cancel)
        mock_client.complete_multipart_upload.assert_not_called()
        # An interrupt is not a failed part, so nothing aborts the upload.
        mock_client.abort_multipart_upload.assert_not_called()


class TestPartStopsWhileWaiting:
    """A part whose sibling failed stops without another PUT, wherever it is waiting."""

    @staticmethod
    def _part(
        mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> tuple[Uploader, Callable[[threading.Event], None], MagicMock]:
        """Return an uploader with one slot, a way to run part 1, and the URL request mock."""
        _write_parts_file(tmp_path, "big.bin", part_count=2, part_size=4)
        up = _make_uploader(mock_client, state_db, tmp_path, parallelism=1)
        fetch = MagicMock(side_effect=lambda numbers: _part_urls(42, "abc123", numbers))
        urls = _PartUrls(fetch, 2)

        def run(cancel: threading.Event) -> None:
            up._put_one_part(tmp_path / "big.bin", urls, 1, 4, 8, cancel, _Transfer())

        return up, run, fetch

    @staticmethod
    def _start_waiting_part(
        up: Uploader, run: Callable[[threading.Event], None], cancel: threading.Event
    ) -> tuple[threading.Thread, list[str]]:
        """Run the part on its own thread and return once it is waiting for a slot."""
        waiting = threading.Event()
        acquire_slot = up._acquire_slot

        def acquire_and_note(cancel: threading.Event | None = None) -> bool:
            waiting.set()
            return acquire_slot(cancel)

        outcome: list[str] = []

        def target() -> None:
            try:
                run(cancel)
            except _UploadStopped:
                outcome.append("stopped")

        with patch.object(up, "_acquire_slot", side_effect=acquire_and_note):
            thread = threading.Thread(target=target)
            thread.start()
            assert waiting.wait(timeout=5)
            time.sleep(0.1)
        return thread, outcome

    def test_cancel_while_waiting_for_a_slot(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        up, run, fetch = self._part(mock_client, state_db, tmp_path)
        cancel = threading.Event()
        # Another file holds the only slot.
        assert up._put_slots.acquire(blocking=False)
        try:
            with (
                patch.object(up._s3_session, "put") as put,
                patch("data_hub_watcher.uploader._WAIT_STEP_SECONDS", 0.02),
            ):
                thread, outcome = self._start_waiting_part(up, run, cancel)
                cancel.set()
                thread.join(timeout=5)
                assert not thread.is_alive()
        finally:
            up._put_slots.release()

        assert outcome == ["stopped"]
        put.assert_not_called()
        fetch.assert_not_called()

    def test_cancel_as_the_slot_frees_up(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        up, run, fetch = self._part(mock_client, state_db, tmp_path)
        cancel = threading.Event()
        assert up._put_slots.acquire(blocking=False)
        with patch.object(up._s3_session, "put") as put:
            thread, outcome = self._start_waiting_part(up, run, cancel)
            # The sibling failed, and the slot it held comes free just after.
            cancel.set()
            up._put_slots.release()
            thread.join(timeout=5)
            assert not thread.is_alive()

        assert outcome == ["stopped"]
        put.assert_not_called()
        fetch.assert_not_called()
        # The part gave the slot back, so another upload can take it.
        assert up._put_slots.acquire(blocking=False)
        up._put_slots.release()

    def test_cancel_during_the_backoff_before_a_retry(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        up, run, fetch = self._part(mock_client, state_db, tmp_path)
        cancel = threading.Event()
        sleeps: list[float] = []

        def sleep_while_a_sibling_fails(delay: float) -> None:
            sleeps.append(delay)
            cancel.set()

        with (
            patch.object(
                up._s3_session, "put", side_effect=requests.ConnectionError("reset")
            ) as put,
            patch("data_hub_watcher.uploader.time.sleep", side_effect=sleep_while_a_sibling_fails),
            pytest.raises(_UploadStopped),
        ):
            run(cancel)

        # One PUT failed. The backoff is 1 s in 0.5 s steps, and the cancel
        # ended it after the first step. No second PUT started.
        assert put.call_count == 1
        assert sleeps == [0.5]
        assert fetch.call_count == 1


class TestPartUrlFetchErrors:
    """A failed part-URL request counts against the part's attempts."""

    def _upload(
        self, uploader: Uploader, mock_client: MagicMock, tmp_file: Path, put: MagicMock
    ) -> bool:
        payload = tmp_file.read_bytes()
        mock_client.request_upload_url.return_value = _multipart_presigned(
            part_size=len(payload), part_count=1
        )
        with (
            patch.object(uploader._s3_session, "put", put),
            patch("data_hub_watcher.uploader.time.sleep"),
        ):
            return uploader._upload_single(tmp_file, "RUN-001")

    def test_a_503_on_the_first_request_is_retried(
        self, uploader: Uploader, mock_client: MagicMock, tmp_file: Path
    ) -> None:
        mock_client.get_part_urls.side_effect = [
            ApiError("unavailable", status_code=503),
            _part_urls(42, "abc123", [1]),
        ]
        put = MagicMock(return_value=_etag_response(1))

        assert self._upload(uploader, mock_client, tmp_file, put) is True

        assert mock_client.get_part_urls.call_count == 2
        put.assert_called_once()
        mock_client.abort_multipart_upload.assert_not_called()

    def test_a_502_on_a_refresh_no_longer_ends_the_file(
        self, uploader: Uploader, mock_client: MagicMock, tmp_file: Path
    ) -> None:
        mock_client.get_part_urls.side_effect = [
            MultipartPartUrlsResponse(
                expires_in=900,
                parts=[MultipartPartUrl(part_number=1, upload_url="https://s3.example/part/old")],
            ),
            ApiError("bad gateway", status_code=502),
            MultipartPartUrlsResponse(
                expires_in=900,
                parts=[MultipartPartUrl(part_number=1, upload_url="https://s3.example/part/new")],
            ),
        ]
        put = MagicMock(side_effect=[requests.ConnectionError("reset"), _etag_response(1)])

        assert self._upload(uploader, mock_client, tmp_file, put) is True

        assert mock_client.get_part_urls.call_count == 3
        # The failed refresh used up an attempt. The next attempt refreshed
        # again, and its URL carried the second PUT.
        assert [call.args[0] for call in put.call_args_list] == [
            "https://s3.example/part/old",
            "https://s3.example/part/new",
        ]

    def test_a_404_fails_the_file_after_one_request(
        self, uploader: Uploader, mock_client: MagicMock, tmp_file: Path
    ) -> None:
        mock_client.get_part_urls.side_effect = ApiError("not found", status_code=404)
        put = MagicMock()

        assert self._upload(uploader, mock_client, tmp_file, put) is False

        mock_client.get_part_urls.assert_called_once()
        put.assert_not_called()
        mock_client.abort_multipart_upload.assert_called_once_with(42, "abc123")
        reporter = cast(MagicMock, uploader._reporter)
        reporter.queue_event.assert_called_once()
        assert reporter.queue_event.call_args.args[0].event_type == EventType.UPLOAD_FAILED

    def test_a_response_without_the_part_counts_as_a_failed_attempt(
        self, uploader: Uploader, mock_client: MagicMock, tmp_file: Path
    ) -> None:
        mock_client.get_part_urls.side_effect = [
            MultipartPartUrlsResponse(expires_in=900, parts=[]),
            _part_urls(42, "abc123", [1]),
        ]
        put = MagicMock(return_value=_etag_response(1))

        assert self._upload(uploader, mock_client, tmp_file, put) is True

        assert mock_client.get_part_urls.call_count == 2


class TestPartUrlCache:
    """`_PartUrls` fetches in batches and refreshes one part at a time."""

    @staticmethod
    def _cache(
        part_count: int, clock: Callable[[], float] = time.monotonic
    ) -> tuple[_PartUrls, list[list[int]]]:
        calls: list[list[int]] = []

        def fetch(numbers: list[int]) -> MultipartPartUrlsResponse:
            calls.append(list(numbers))
            return _part_urls(42, "abc123", numbers)

        return _PartUrls(fetch, part_count, clock=clock), calls

    def test_a_miss_fetches_the_next_batch_and_neighbours_hit(self) -> None:
        cache, calls = self._cache(20)

        assert cache.get(1) == "https://s3.example/part/1"
        assert cache.get(2) == "https://s3.example/part/2"
        assert cache.get(8) == "https://s3.example/part/8"
        assert calls == [list(range(1, 9))]

        cache.get(9)
        assert calls[-1] == list(range(9, 17))

    def test_the_last_batch_stops_at_the_part_count(self) -> None:
        cache, calls = self._cache(10)

        cache.get(9)

        assert calls == [[9, 10]]

    def test_a_batch_does_not_depend_on_which_part_asks_first(self) -> None:
        cache, calls = self._cache(20)

        cache.get(12)

        assert calls == [list(range(9, 17))]

    def test_a_refresh_fetches_only_that_part(self) -> None:
        cache, calls = self._cache(20)
        cache.get(1)

        cache.get(3, refresh=True)

        assert calls == [list(range(1, 9)), [3]]

    def test_a_url_older_than_five_minutes_is_fetched_again_alone(self) -> None:
        now = [1000.0]
        cache, calls = self._cache(20, clock=lambda: now[0])
        cache.get(1)

        now[0] += 299
        cache.get(2)
        assert calls == [list(range(1, 9))]

        now[0] += 2
        cache.get(2)
        assert calls == [list(range(1, 9)), [2]]

    def test_workers_that_miss_together_share_one_request(self) -> None:
        calls: list[list[int]] = []

        def slow_fetch(numbers: list[int]) -> MultipartPartUrlsResponse:
            calls.append(list(numbers))
            time.sleep(0.1)
            return _part_urls(42, "abc123", numbers)

        cache = _PartUrls(slow_fetch, 8)
        start = threading.Barrier(4, timeout=3)
        urls: dict[int, str] = {}

        def worker(number: int) -> None:
            start.wait()
            urls[number] = cache.get(number)

        threads = [threading.Thread(target=worker, args=(n,)) for n in (1, 2, 3, 4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=5)

        assert calls == [list(range(1, 9))]
        # Each worker got its own part's URL from the shared request.
        assert urls == {n: f"https://s3.example/part/{n}" for n in (1, 2, 3, 4)}

    def test_a_hung_refresh_does_not_block_other_parts(self) -> None:
        refresh_started = threading.Event()
        release_refresh = threading.Event()

        def fetch(numbers: list[int]) -> MultipartPartUrlsResponse:
            if numbers == [3]:
                refresh_started.set()
                release_refresh.wait(timeout=5)
            return _part_urls(42, "abc123", numbers)

        cache = _PartUrls(fetch, 20)
        cache.get(1)
        refresher = threading.Thread(target=lambda: cache.get(3, refresh=True))
        refresher.start()
        assert refresh_started.wait(timeout=5)
        urls: list[str] = []

        def read() -> None:
            # A cached URL, and a miss that needs a batch of its own.
            urls.append(cache.get(2))
            urls.append(cache.get(9))

        reader = threading.Thread(target=read)
        reader.start()
        try:
            reader.join(timeout=2)
            assert not reader.is_alive(), "a hung refresh of part 3 blocked other parts"
            assert urls == ["https://s3.example/part/2", "https://s3.example/part/9"]
        finally:
            release_refresh.set()
            refresher.join(timeout=5)
            reader.join(timeout=5)

    def test_a_failed_batch_request_reaches_every_waiter_and_is_asked_again(self) -> None:
        calls: list[list[int]] = []

        def fetch(numbers: list[int]) -> MultipartPartUrlsResponse:
            calls.append(list(numbers))
            if len(calls) == 1:
                # Long enough for the other workers to arrive and wait on it.
                time.sleep(0.2)
                raise ApiError("unavailable", status_code=503)
            return _part_urls(42, "abc123", numbers)

        cache = _PartUrls(fetch, 8)
        start = threading.Barrier(4, timeout=3)
        outcomes: list[object] = []

        def worker(number: int) -> None:
            start.wait()
            try:
                outcomes.append(cache.get(number))
            except ApiError as exc:
                outcomes.append(exc)

        threads = [threading.Thread(target=worker, args=(n,)) for n in (1, 2, 3, 4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=5)

        # One request, and every worker that waited on it saw its failure.
        assert calls == [list(range(1, 9))]
        assert len(outcomes) == 4
        assert all(isinstance(outcome, ApiError) for outcome in outcomes)
        # The failed request is not left in flight, so the next attempt asks again.
        assert cache.get(1) == "https://s3.example/part/1"
        assert calls == [list(range(1, 9)), list(range(1, 9))]

    def test_a_refresh_that_returns_no_url_for_the_part_is_an_error(self) -> None:
        responses = [
            _part_urls(42, "abc123", list(range(1, 9))),
            MultipartPartUrlsResponse(expires_in=900, parts=[]),
        ]
        cache = _PartUrls(lambda numbers: responses.pop(0), 8)
        cache.get(1)

        # The old URL is still cached, but the refresh was asked to replace it.
        with pytest.raises(RuntimeError, match="no URL for part 1"):
            cache.get(1, refresh=True)


class TestSharedUploadBudget:
    """`upload_parallelism` caps simultaneous PUTs across files and parts together."""

    def test_files_and_parts_never_exceed_the_budget(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        names = ["big-a.bin", "big-b.bin", "small-a.csv", "small-b.csv"]
        for name in names:
            if name.startswith("big"):
                _write_parts_file(tmp_path, name, part_count=6, part_size=8)
            else:
                (tmp_path / name).write_text("a,b\n1,2\n")

        def presign(
            instrument_id: str, run_id: str, filename: str, **kwargs: object
        ) -> PresignedUploadResponse:
            if filename.startswith("big"):
                return _multipart_presigned(part_size=8, part_count=6)
            return _single_presigned(filename)

        mock_client.request_upload_url.side_effect = presign
        mock_client.get_part_urls.side_effect = _part_urls
        up = _make_uploader(mock_client, state_db, tmp_path, parallelism=3)

        tracker = _Concurrency()
        first_three = threading.Barrier(3, timeout=5)
        started = [0]
        started_lock = threading.Lock()

        def hold() -> None:
            with tracker.track():
                with started_lock:
                    started[0] += 1
                    index = started[0]
                # The budget must let three PUTs run together, so the first
                # three wait for each other. Later ones only overlap briefly.
                if index <= 3:
                    first_three.wait()
                time.sleep(0.02)

        def put_part(url: str, **kwargs: object) -> MagicMock:
            hold()
            return _etag_response(_part_number(url))

        def put_file(self_: Uploader, url: str, path: Path, content_type: str | None) -> None:
            hold()

        files = [_file_info(tmp_path / name) for name in names]
        with (
            patch.object(up._s3_session, "put", side_effect=put_part),
            patch.object(Uploader, "_put_to_presigned_url", new=put_file),
        ):
            assert up.upload_files("RUN-001", files) == 4

        assert tracker.peak == 3
        assert mock_client.complete_multipart_upload.call_count == 2

    def test_waiting_for_a_slot_ends_when_the_watcher_stops(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        stop = threading.Event()
        up = _make_uploader(mock_client, state_db, tmp_path, parallelism=1, stop_event=stop)
        assert up._put_slots.acquire(blocking=False)
        timer = threading.Timer(0.1, stop.set)
        timer.start()
        try:
            assert up._acquire_slot() is False
        finally:
            timer.cancel()
            up._put_slots.release()

    def test_waiting_for_a_slot_ends_when_the_file_is_cancelled(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        up = _make_uploader(mock_client, state_db, tmp_path, parallelism=1)
        cancel = threading.Event()
        assert up._put_slots.acquire(blocking=False)
        timer = threading.Timer(0.1, cancel.set)
        timer.start()
        try:
            assert up._acquire_slot(cancel) is False
        finally:
            timer.cancel()
            up._put_slots.release()


class TestParallelQueue:
    """Queued files, and pending retries, run through the same budget."""

    @staticmethod
    def _queue(directory: Path, count: int) -> UploadQueueResponse:
        files = []
        for i in range(1, count + 1):
            (directory / f"q-{i}.csv").write_text("x")
            files.append(
                UploadQueueFile(
                    id=i,
                    instrument_id="test-instrument",
                    run_id="RUN-Q",
                    filename=f"q-{i}.csv",
                    relative_path=f"q-{i}.csv",
                )
            )
        return UploadQueueResponse(files=files)

    def test_queued_files_upload_at_the_same_time(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        mock_client.get_upload_queue.return_value = self._queue(tmp_path, 3)
        up = _make_uploader(mock_client, state_db, tmp_path, parallelism=3)
        barrier = threading.Barrier(3, timeout=3)
        uploaded: list[str] = []

        def upload(path: Path, run_id: str) -> bool:
            barrier.wait()
            uploaded.append(path.name)
            return True

        with patch.object(up, "_upload_single", side_effect=upload):
            up.poll_upload_queue()

        assert sorted(uploaded) == ["q-1.csv", "q-2.csv", "q-3.csv"]
        mock_client.cancel_upload_request.assert_not_called()

    def test_the_poll_returns_only_after_every_file_finishes(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        mock_client.get_upload_queue.return_value = self._queue(tmp_path, 3)
        up = _make_uploader(mock_client, state_db, tmp_path, parallelism=3)
        finished: list[str] = []

        def upload(path: Path, run_id: str) -> bool:
            time.sleep(0.1)
            finished.append(path.name)
            return True

        with patch.object(up, "_upload_single", side_effect=upload):
            up.poll_upload_queue()
            assert len(finished) == 3

    def test_the_attempt_cap_cancels_each_file(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        mock_client.get_upload_queue.return_value = UploadQueueResponse(
            files=[
                UploadQueueFile(
                    id=i,
                    instrument_id="test-instrument",
                    run_id="RUN-X",
                    filename=f"ghost-{i}.csv",
                    relative_path=f"ghost-{i}.csv",
                )
                for i in (1, 2, 3)
            ]
        )
        up = _make_uploader(mock_client, state_db, tmp_path, parallelism=3)

        for _ in range(MAX_QUEUE_FILE_ATTEMPTS):
            up.poll_upload_queue()

        cancelled = sorted(c.args[0] for c in mock_client.cancel_upload_request.call_args_list)
        assert cancelled == [1, 2, 3]
        report_error = cast(MagicMock, up._reporter).report_error
        assert [c.args[0] for c in report_error.call_args_list] == ["upload_request_cancelled"] * 3
        # Each file reported its missing file once.
        assert up._counters.errors == 3

    def test_an_unexpected_error_in_one_file_does_not_end_the_others(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        mock_client.get_upload_queue.return_value = self._queue(tmp_path, 3)
        up = _make_uploader(mock_client, state_db, tmp_path, parallelism=3)
        uploaded: list[str] = []

        def upload(path: Path, run_id: str) -> bool:
            if path.name == "q-1.csv":
                raise ValueError("unexpected response")
            uploaded.append(path.name)
            return True

        with patch.object(up, "_upload_single", side_effect=upload):
            up.poll_upload_queue()

        assert sorted(uploaded) == ["q-2.csv", "q-3.csv"]

    @pytest.mark.usefixtures("ctrl_c_is_delivered")
    def test_ctrl_c_during_a_queue_poll_sets_the_stop_event(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        mock_client.get_upload_queue.return_value = self._queue(tmp_path, 3)
        stop = threading.Event()
        up = _make_uploader(mock_client, state_db, tmp_path, parallelism=2, stop_event=stop)
        started: list[str] = []
        saw_stop: list[bool] = []

        def upload(path: Path, run_id: str) -> bool:
            started.append(path.name)
            if path.name == "q-1.csv":
                _press_ctrl_c()
            saw_stop.append(stop.wait(timeout=5))
            return True

        with (
            patch.object(up, "_upload_single", side_effect=upload),
            pytest.raises(KeyboardInterrupt),
        ):
            up.poll_upload_queue()
        _wait_until_no_threads("uploader")

        assert stop.is_set()
        # Both workers saw the stop, and the third file never started.
        assert sorted(started) == ["q-1.csv", "q-2.csv"]
        assert saw_stop == [True, True]

    def test_pending_uploads_retry_at_the_same_time(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        run_dir = tmp_path / "RUN-1"
        run_dir.mkdir()
        paths = []
        for i in range(3):
            (run_dir / f"p-{i}.csv").write_text("x")
            paths.append(f"RUN-1/p-{i}.csv")
        state_db.record_report("RUN-1", [], new_run=False, pending_relative_paths=paths)
        up = _make_uploader(mock_client, state_db, tmp_path, parallelism=3)
        barrier = threading.Barrier(3, timeout=3)

        def upload(path: Path, run_id: str) -> bool:
            barrier.wait()
            return True

        with patch.object(up, "_upload_single", side_effect=upload):
            up.retry_pending_uploads()

        assert state_db.pending_uploads() == []


class TestRunWorkers:
    """The helper behind the file workers and the part workers."""

    @staticmethod
    def _run(
        items: list[int],
        task: Callable[[int], None],
        *,
        workers: int,
        halted: Callable[[], bool] = lambda: False,
        on_interrupt: Callable[[], None] = lambda: None,
        name: str = "test-worker",
    ) -> None:
        _run_workers(
            items,
            task,
            workers=workers,
            name=name,
            halted=halted,
            on_interrupt=on_interrupt,
        )

    def test_every_item_runs_exactly_once(self) -> None:
        seen: list[int] = []
        seen_lock = threading.Lock()

        def task(item: int) -> None:
            time.sleep(0.001)
            with seen_lock:
                seen.append(item)

        self._run(list(range(60)), task, workers=4)

        assert sorted(seen) == list(range(60))

    def test_the_threads_are_named_daemon_threads(self) -> None:
        threads: list[threading.Thread] = []
        all_started = threading.Barrier(4, timeout=5)

        def task(item: int) -> None:
            threads.append(threading.current_thread())
            all_started.wait()

        self._run([1, 2, 3, 4], task, workers=4)

        # A daemon thread does not hold the process open at exit. A pool
        # thread would be joined, so the exit would wait for every send.
        assert len(threads) == 4
        assert all(thread.daemon for thread in threads)
        assert {thread.name for thread in threads} == {f"test-worker-{n}" for n in range(1, 5)}

    @pytest.mark.parametrize(("count", "workers"), [(5, 1), (1, 4)])
    def test_one_worker_or_one_item_runs_on_the_calling_thread(
        self, count: int, workers: int
    ) -> None:
        threads: list[threading.Thread] = []

        self._run(
            list(range(count)),
            lambda item: threads.append(threading.current_thread()),
            workers=workers,
        )

        assert threads == [threading.current_thread()] * count

    def test_the_caller_waits_in_timed_steps(self) -> None:
        caller = threading.current_thread()
        timeouts: list[float | None] = []
        real_join = threading.Thread.join

        def join(self_: threading.Thread, timeout: float | None = None) -> None:
            if threading.current_thread() is caller:
                timeouts.append(timeout)
            real_join(self_, timeout)

        with (
            patch("data_hub_watcher.uploader._WAIT_STEP_SECONDS", 0.02),
            patch.object(threading.Thread, "join", join),
        ):
            self._run([1, 2], lambda item: time.sleep(0.15), workers=2)

        # A wait with no timeout cannot be interrupted by Ctrl-C on Windows.
        assert len(timeouts) >= 3
        assert set(timeouts) == {0.02}

    @pytest.mark.usefixtures("ctrl_c_is_delivered")
    def test_ctrl_c_during_the_wait_calls_on_interrupt_and_raises_again(self) -> None:
        interrupted = threading.Event()
        workers: list[threading.Thread] = []
        saw_interrupt: list[bool] = []

        def task(item: int) -> None:
            workers.append(threading.current_thread())
            if item == 1:
                _press_ctrl_c()
            saw_interrupt.append(interrupted.wait(timeout=5))

        with pytest.raises(KeyboardInterrupt):
            self._run([1, 2], task, workers=2, on_interrupt=interrupted.set)
        for worker in workers:
            worker.join(timeout=5)

        # The workers were told within the timed step, not after their 5 s.
        assert saw_interrupt == [True, True]

    def test_a_halt_starts_no_new_items_and_lets_running_ones_finish(self) -> None:
        halt = threading.Event()
        both_started = threading.Barrier(2, timeout=5)
        started: list[int] = []
        finished: list[int] = []
        lock = threading.Lock()

        def task(item: int) -> None:
            with lock:
                started.append(item)
            both_started.wait()
            halt.set()
            time.sleep(0.05)
            with lock:
                finished.append(item)

        self._run(list(range(1, 7)), task, workers=2, halted=halt.is_set)

        assert sorted(started) == [1, 2]
        assert sorted(finished) == [1, 2]

    def test_a_halt_starts_no_item_on_the_calling_thread_either(self) -> None:
        ran: list[int] = []

        self._run([1, 2, 3], ran.append, workers=1, halted=lambda: bool(ran))

        assert ran == [1]

    def test_with_one_worker_a_task_error_is_raised_at_once(self) -> None:
        ran: list[int] = []

        def task(item: int) -> None:
            ran.append(item)
            raise ValueError("boom")

        with pytest.raises(ValueError, match="boom"):
            self._run([1, 2, 3], task, workers=1)

        assert ran == [1]

    def test_with_threads_the_first_error_is_raised_after_every_item_is_done(self) -> None:
        finished: list[int] = []

        def task(item: int) -> None:
            if item == 1:
                raise ValueError("first")
            if item == 2:
                time.sleep(0.05)
                raise ValueError("second")
            time.sleep(0.05)
            finished.append(item)

        with pytest.raises(ValueError, match="first"):
            self._run([1, 2, 3, 4], task, workers=2, name="test-errors")

        # The error was raised once the work was over, not when it happened.
        assert sorted(finished) == [3, 4]
        assert not any(t.name.startswith("test-errors") for t in threading.enumerate())


class TestDaemonCalls:
    """The hash and the upload-URL request of a file run on daemon threads.

    A `ThreadPoolExecutor` does neither: Python joins its threads at exit, so a URL request
    that is waiting for a server that stopped answering (5 s to connect and 30 s to read)
    would keep a stopping watcher's process alive for up to 35 s. A stop gives up on the
    thread that waits for that request after its limit, so the exit must not wait for it.
    """

    def test_a_call_runs_on_a_named_daemon_thread_and_its_value_comes_back(self) -> None:
        threads: list[threading.Thread] = []

        def add(a: int, b: int, *, extra: int) -> int:
            threads.append(threading.current_thread())
            return a + b + extra

        with _DaemonCalls("test-prep") as calls:
            future = calls.submit(add, 1, 2, extra=3)
            assert future.result() == 6

        (thread,) = threads
        assert thread is not threading.current_thread()
        assert thread.daemon
        assert thread.name == "test-prep-1"

    def test_the_calls_run_at_the_same_time(self) -> None:
        both_started = threading.Barrier(2, timeout=5)

        with _DaemonCalls("test-prep") as calls:
            first = calls.submit(both_started.wait)
            second = calls.submit(both_started.wait)
            # Each waits for the other, so neither would return if they ran one after the other.
            first.result()
            second.result()

    def test_an_error_is_raised_by_result_as_it_was_raised(self) -> None:
        boom = ApiError("boom", status_code=503)

        def fail() -> None:
            raise boom

        with _DaemonCalls("test-prep") as calls:
            future = calls.submit(fail)
            with pytest.raises(ApiError) as raised:
                future.result()

        assert raised.value is boom

    def test_leaving_the_block_waits_for_every_call(self) -> None:
        finished = threading.Event()

        def slow() -> None:
            time.sleep(0.3)
            finished.set()

        with _DaemonCalls("test-prep") as calls:
            calls.submit(slow)

        assert finished.is_set()

    def test_the_caller_waits_in_timed_steps(self) -> None:
        # A wait with no timeout cannot be interrupted by Ctrl-C on Windows.
        timeouts: list[float | None] = []
        watched: list[threading.Event] = []
        real_wait = threading.Event.wait

        def wait(self_: threading.Event, timeout: float | None = None) -> bool:
            if any(self_ is event for event in watched):
                timeouts.append(timeout)
            return real_wait(self_, timeout)

        with (
            patch("data_hub_watcher.uploader._WAIT_STEP_SECONDS", 0.02),
            patch.object(threading.Event, "wait", wait),
            _DaemonCalls("test-prep") as calls,
        ):
            future = calls.submit(time.sleep, 0.15)
            watched.append(future._done)
            future.result()

        assert len(timeouts) >= 3
        assert set(timeouts) == {0.02}

    def test_a_call_that_never_returns_does_not_hold_the_process_open_at_exit(self) -> None:
        # The same thing in a process of its own, because it is about how Python exits: a
        # call is left waiting forever, as a request to a server that never answers is.
        script = textwrap.dedent(
            """
            import threading
            from data_hub_watcher.uploader import _DaemonCalls

            calls = _DaemonCalls("hung-prep")
            started = threading.Event()
            calls.submit(lambda: (started.set(), threading.Event().wait()))
            assert started.wait(10)
            print("leaving")
            """
        )

        try:
            done = subprocess.run(
                [sys.executable, "-I", "-c", script],
                capture_output=True,
                text=True,
                timeout=30,
            )
        except subprocess.TimeoutExpired:
            pytest.fail("the process did not exit while a call was still waiting")

        assert done.returncode == 0, done.stderr
        assert "leaving" in done.stdout


class TestWorkerThreads:
    """Each call site runs its workers on daemon threads that are named for it."""

    @staticmethod
    def _check(threads: list[threading.Thread], prefix: str, count: int) -> None:
        assert len(threads) == count
        assert all(thread.daemon for thread in threads)
        assert all(thread.name.startswith(prefix) for thread in threads)

    def test_part_workers(self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path) -> None:
        _write_parts_file(tmp_path, "big.bin", part_count=4, part_size=4)
        mock_client.request_upload_url.return_value = _multipart_presigned(
            part_size=4, part_count=4
        )
        mock_client.get_part_urls.side_effect = _part_urls
        up = _make_uploader(mock_client, state_db, tmp_path, parallelism=4)
        threads: list[threading.Thread] = []
        all_in_flight = threading.Barrier(4, timeout=5)

        def put(url: str, **kwargs: object) -> MagicMock:
            threads.append(threading.current_thread())
            all_in_flight.wait()
            return _etag_response(_part_number(url))

        with patch.object(up._s3_session, "put", side_effect=put):
            assert up._upload_single(tmp_path / "big.bin", "RUN-001") is True

        self._check(threads, "upload-part-", 4)

    def test_the_hash_and_the_upload_url_request(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        path = tmp_path / "f.csv"
        path.write_text("x")
        up = _make_uploader(mock_client, state_db, tmp_path, parallelism=1)
        threads: list[threading.Thread] = []

        def digests(file_path: Path, cancel: threading.Event) -> tuple[str, str]:
            threads.append(threading.current_thread())
            return file_digests(file_path, cancel)

        def request_url(*args: object, **kwargs: object) -> PresignedUploadResponse:
            threads.append(threading.current_thread())
            return _single_presigned("f.csv")

        mock_client.request_upload_url.side_effect = request_url

        with (
            patch("data_hub_watcher.uploader.file_digests", side_effect=digests),
            patch.object(Uploader, "_put_to_presigned_url"),
        ):
            assert up._upload_single(path, "RUN-001") is True

        self._check(threads, "upload-prep-", 2)
        assert threading.current_thread() not in threads

    def test_auto_mode_file_workers(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        up = _make_uploader(mock_client, state_db, tmp_path, parallelism=3)
        files = []
        for i in range(3):
            (tmp_path / f"f-{i}.csv").write_text("x")
            files.append(_file_info(tmp_path / f"f-{i}.csv"))
        threads: list[threading.Thread] = []
        all_started = threading.Barrier(3, timeout=5)

        def upload(path: Path, run_id: str) -> bool:
            threads.append(threading.current_thread())
            all_started.wait()
            return True

        with patch.object(up, "_upload_single", side_effect=upload):
            assert up.upload_files("RUN-001", files) == 3

        self._check(threads, "uploader-", 3)

    def test_queue_file_workers(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        mock_client.get_upload_queue.return_value = TestParallelQueue._queue(tmp_path, 3)
        up = _make_uploader(mock_client, state_db, tmp_path, parallelism=3)
        threads: list[threading.Thread] = []
        all_started = threading.Barrier(3, timeout=5)

        def upload(path: Path, run_id: str) -> bool:
            threads.append(threading.current_thread())
            all_started.wait()
            return True

        with patch.object(up, "_upload_single", side_effect=upload):
            up.poll_upload_queue()

        self._check(threads, "uploader-", 3)


class TestFileUploadedDetails:
    """The `file_uploaded` event carries the size and where the time went."""

    def test_single_put_details(
        self, uploader: Uploader, mock_client: MagicMock, tmp_file: Path
    ) -> None:
        content = tmp_file.read_bytes()

        def request_url(*args: object, **kwargs: object) -> PresignedUploadResponse:
            time.sleep(0.05)
            return _single_presigned(tmp_file.name)

        def slow_notify(*args: object, **kwargs: object) -> MagicMock:
            time.sleep(0.3)
            return MagicMock()

        def slow_put(self_: Uploader, url: str, path: Path, content_type: str | None) -> None:
            time.sleep(0.05)

        mock_client.request_upload_url.side_effect = request_url
        mock_client.mark_file_uploaded.side_effect = slow_notify

        with patch.object(Uploader, "_put_to_presigned_url", new=slow_put):
            assert uploader._upload_single(tmp_file, "RUN-001") is True

        event = cast(MagicMock, uploader._reporter).queue_event.call_args.args[0]
        assert event.event_type == EventType.FILE_UPLOADED
        details = event.details
        assert details["s3_key"] == f"test-instrument/RUN-001/{tmp_file.name}"
        assert details["sha256"] == hashlib.sha256(content).hexdigest()
        assert details["size_bytes"] == len(content)
        assert details["part_count"] == 1
        assert details["prep_seconds"] >= 0.05
        # The transfer ends when the PUT succeeds, before the API is told.
        assert 0.05 <= details["upload_seconds"] < 0.3

    def test_multipart_details(
        self, mock_client: MagicMock, state_db: StateDB, tmp_path: Path
    ) -> None:
        _write_parts_file(tmp_path, "big.bin", part_count=8, part_size=4)

        def request_url(*args: object, **kwargs: object) -> PresignedUploadResponse:
            time.sleep(0.05)
            return _multipart_presigned(part_size=4, part_count=8)

        def put(url: str, **kwargs: object) -> MagicMock:
            time.sleep(0.02)
            return _etag_response(_part_number(url))

        mock_client.request_upload_url.side_effect = request_url
        mock_client.get_part_urls.side_effect = _part_urls
        up = _make_uploader(mock_client, state_db, tmp_path, parallelism=4)

        with patch.object(up._s3_session, "put", side_effect=put):
            assert up._upload_single(tmp_path / "big.bin", "RUN-001") is True

        event = cast(MagicMock, up._reporter).queue_event.call_args.args[0]
        assert event.event_type == EventType.FILE_UPLOADED
        details = event.details
        assert details["size_bytes"] == 32
        assert details["part_count"] == 8
        assert details["prep_seconds"] >= 0.05
        # Eight 20 ms parts, four at a time, take at least two rounds.
        assert details["upload_seconds"] >= 0.04
        assert isinstance(details["upload_seconds"], float)
