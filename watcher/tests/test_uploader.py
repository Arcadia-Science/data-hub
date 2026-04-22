"""Unit tests for the presigned-URL upload flow in Uploader."""

from __future__ import annotations
from collections.abc import Generator
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from data_hub_watcher.api_client import ApiError
from data_hub_watcher.events import EventReporter
from data_hub_watcher.heartbeat import WatcherCounters
from data_hub_watcher.models import PresignedUploadResponse
from data_hub_watcher.state import StateDB
from data_hub_watcher.uploader import Uploader


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

        # Stat columns must be populated so subsequent initial scans can
        # skip this file without re-hashing its contents.
        st = tmp_file.stat()
        assert state_db.has_stat_match(tmp_file.name, st.st_size, st.st_mtime) is True

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


class TestPutToPresignedUrl:
    def test_successful_put(self, tmp_file: Path) -> None:
        with patch("data_hub_watcher.uploader.http_requests.put") as mock_put:
            mock_put.return_value = MagicMock(status_code=200)
            mock_put.return_value.raise_for_status = MagicMock()

            Uploader._put_to_presigned_url("https://s3.example.com/presigned", tmp_file, "text/csv")

        mock_put.assert_called_once()
        call_kwargs = mock_put.call_args
        assert call_kwargs.kwargs["headers"]["Content-Type"] == "text/csv"
        assert call_kwargs.kwargs["timeout"] == 300
