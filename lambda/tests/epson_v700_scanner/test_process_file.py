"""Unit tests for `epson_v700_scanner.process_file`.

These verify the orchestration logic by mocking S3 I/O, the API client,
and the TIFFToJPEGConverter.
"""

from __future__ import annotations
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from data_hub_lambda.models import FileResponse, RunResponse


@pytest.fixture(autouse=True)
def _reset_api_client() -> Any:
    """Ensure `get_client()` returns a fresh mock per test."""
    import data_hub_lambda.api_client as api_module

    original = api_module._client
    api_module._client = None
    try:
        yield
    finally:
        api_module._client = original


def _run_response() -> RunResponse:
    return RunResponse(
        id="run-uuid",
        instrument_id="epson-v700-scanner",
        run_id="run-xyz",
        source="lambda",
        metadata={},
    )


def _file_response(file_id: int = 123) -> FileResponse:
    return FileResponse(
        id=file_id,
        instrument_run_id="run-uuid",
        filename="scan.tif",
        s3_bucket="raw",
        s3_key="epson-v700-scanner/run-xyz/scan.tif",
        category="raw",
        status="uploaded",
    )


def _build_client_mock() -> MagicMock:
    client = MagicMock()
    client.ensure_run.return_value = _run_response()
    client.create_file.side_effect = [
        _file_response(file_id=10),
        _file_response(file_id=11),
    ]
    return client


@pytest.fixture
def patched_jpg_path(tmp_path: Path) -> Path:
    """A fake JPG output path that actually exists on disk (for stat())."""
    jpg = tmp_path / "scan.jpg"
    jpg.write_bytes(b"fake-jpg-bytes")
    return jpg


@pytest.fixture
def patched_converter(patched_jpg_path: Path) -> MagicMock:
    """A stand-in TIFFToJPEGConverter whose export_jpg returns a real tmp file."""
    converter = MagicMock()
    converter.load.return_value = None
    converter.export_jpg.return_value = patched_jpg_path
    converter.parse_metadata.return_value = {
        "ImageWidth": 6400,
        "ImageLength": 4800,
        "BitsPerSample": [8, 8, 8],
        "OriginalHeight": 4800,
        "OriginalWidth": 6400,
    }
    return converter


_PATCH_PREFIX = "data_hub_lambda.epson_v700_scanner.process_file"


class TestProcessFileHappyPath:
    def test_creates_run_and_files(
        self,
        patched_converter: MagicMock,
    ) -> None:
        client = _build_client_mock()

        with (
            patch(f"{_PATCH_PREFIX}.get_client", return_value=client),
            patch(f"{_PATCH_PREFIX}.s3_utils") as s3_mock,
            patch(
                f"{_PATCH_PREFIX}.TIFFToJPEGConverter",
                return_value=patched_converter,
            ),
        ):
            from data_hub_lambda.epson_v700_scanner.process_file import process_file

            process_file(run_id="run-xyz", filename="scan.tif")

        client.ensure_run.assert_called_once()
        assert client.create_file.call_count == 2
        s3_mock.upload_file.assert_called_once()
        client.update_run.assert_called_once()

    def test_uploads_jpg_and_registers_processed_file(
        self,
        patched_converter: MagicMock,
    ) -> None:
        client = _build_client_mock()

        with (
            patch(f"{_PATCH_PREFIX}.get_client", return_value=client),
            patch(f"{_PATCH_PREFIX}.s3_utils"),
            patch(
                f"{_PATCH_PREFIX}.TIFFToJPEGConverter",
                return_value=patched_converter,
            ),
        ):
            from data_hub_lambda.epson_v700_scanner.process_file import process_file

            process_file(run_id="run-xyz", filename="scan.tif")

        patched_converter.export_jpg.assert_called_once()

        processed_create_call = client.create_file.call_args_list[1]
        assert processed_create_call.kwargs["category"] == "processed"
        assert processed_create_call.kwargs["filename"] == "scan.jpg"

    def test_stores_metadata_on_run(
        self,
        patched_converter: MagicMock,
    ) -> None:
        client = _build_client_mock()

        with (
            patch(f"{_PATCH_PREFIX}.get_client", return_value=client),
            patch(f"{_PATCH_PREFIX}.s3_utils"),
            patch(
                f"{_PATCH_PREFIX}.TIFFToJPEGConverter",
                return_value=patched_converter,
            ),
        ):
            from data_hub_lambda.epson_v700_scanner.process_file import process_file

            process_file(run_id="run-xyz", filename="scan.tif")

        client.update_run.assert_called_once()
        _, kwargs = client.update_run.call_args
        assert kwargs["metadata"]["OriginalWidth"] == 6400

    def test_marks_raw_file_completed(
        self,
        patched_converter: MagicMock,
    ) -> None:
        client = _build_client_mock()

        with (
            patch(f"{_PATCH_PREFIX}.get_client", return_value=client),
            patch(f"{_PATCH_PREFIX}.s3_utils"),
            patch(
                f"{_PATCH_PREFIX}.TIFFToJPEGConverter",
                return_value=patched_converter,
            ),
        ):
            from data_hub_lambda.epson_v700_scanner.process_file import process_file

            process_file(run_id="run-xyz", filename="scan.tif")

        statuses = [
            call.kwargs.get("status")
            for call in client.update_file.call_args_list
            if "status" in call.kwargs
        ]
        assert "completed" in statuses


class TestProcessFileFailure:
    def test_marks_raw_file_failed_on_exception(self) -> None:
        client = _build_client_mock()

        failing_converter = MagicMock()
        failing_converter.load.side_effect = RuntimeError("boom")

        with (
            patch(f"{_PATCH_PREFIX}.get_client", return_value=client),
            patch(f"{_PATCH_PREFIX}.s3_utils"),
            patch(
                f"{_PATCH_PREFIX}.TIFFToJPEGConverter",
                return_value=failing_converter,
            ),
        ):
            from data_hub_lambda.epson_v700_scanner.process_file import process_file

            with pytest.raises(RuntimeError, match="boom"):
                process_file(run_id="run-xyz", filename="broken.tif")

        statuses = [
            call.kwargs.get("status")
            for call in client.update_file.call_args_list
            if "status" in call.kwargs
        ]
        assert "processing" in statuses
        assert "failed" in statuses

        failed_call = next(
            call
            for call in client.update_file.call_args_list
            if call.kwargs.get("status") == "failed"
        )
        assert failed_call.kwargs["error_message"] == "boom"
