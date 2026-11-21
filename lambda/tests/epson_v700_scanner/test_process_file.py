"""Unit tests for `epson_v700_scanner.process_file`.

These verify the orchestration logic by mocking S3 I/O, the API client,
and the TiffProcessor.
"""

from __future__ import annotations
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from data_hub_lambda.models import FileResponse, RunResponse


@pytest.fixture(autouse=True)
def _small_raw_object(monkeypatch: pytest.MonkeyPatch) -> None:
    """`local_raw_file` reads the size and downloads through the shared S3 helpers."""

    def _download(_uri: str, local_path: Path, **_kwargs: Any) -> None:
        local_path.parent.mkdir(parents=True, exist_ok=True)
        local_path.write_bytes(b"tif")

    monkeypatch.setattr("data_hub_shared.s3_utils.object_content_length", lambda *_a, **_k: 128)
    monkeypatch.setattr("data_hub_shared.s3_utils.download_file", _download)


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
    """A stand-in TiffProcessor whose export_jpg returns a real tmp file."""
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
    converter.crop_plates.return_value = []
    return converter


_PATCH_PREFIX = "data_hub_lambda.epson_v700_scanner.process_file"
# The shared helper uploads to the processed bucket.
_S3_PATCH = "data_hub_lambda.processed_files.s3_utils"


class TestProcessFileHappyPath:
    def test_creates_run_and_files(
        self,
        patched_converter: MagicMock,
    ) -> None:
        client = _build_client_mock()

        with (
            patch(f"{_PATCH_PREFIX}.get_client", return_value=client),
            patch(_S3_PATCH) as s3_mock,
            patch(
                f"{_PATCH_PREFIX}.TiffProcessor",
                return_value=patched_converter,
            ),
        ):
            from data_hub_lambda.epson_v700_scanner.process_file import process_file

            process_file(
                instrument_id="epson-v700-scanner",
                run_id="run-xyz",
                filename="scan.tif",
            )

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
            patch(_S3_PATCH),
            patch(
                f"{_PATCH_PREFIX}.TiffProcessor",
                return_value=patched_converter,
            ),
        ):
            from data_hub_lambda.epson_v700_scanner.process_file import process_file

            process_file(
                instrument_id="epson-v700-scanner",
                run_id="run-xyz",
                filename="scan.tif",
            )

        patched_converter.export_jpg.assert_called_once()
        output_dir = patched_converter.export_jpg.call_args.kwargs["output_dir"]
        assert output_dir.name == "run-xyz"

        processed_create_call = client.create_file.call_args_list[1]
        assert processed_create_call.kwargs["category"] == "processed"
        assert processed_create_call.kwargs["filename"] == "scan.jpg"

    def test_registers_the_jpg_with_its_raw_file_as_the_source(
        self,
        patched_converter: MagicMock,
        patched_jpg_path: Path,
    ) -> None:
        client = _build_client_mock()

        with (
            patch(f"{_PATCH_PREFIX}.get_client", return_value=client),
            patch(_S3_PATCH),
            patch(
                f"{_PATCH_PREFIX}.TiffProcessor",
                return_value=patched_converter,
            ),
        ):
            from data_hub_lambda.epson_v700_scanner.process_file import process_file

            process_file(
                instrument_id="epson-v700-scanner",
                run_id="run-xyz",
                filename="scan.tif",
            )

        # The raw file's row is the first create_file result (id 10).
        processed = client.create_file.call_args_list[1].kwargs
        assert processed["source_file_id"] == 10
        # The size and type go with the create call.
        assert processed["size_bytes"] == patched_jpg_path.stat().st_size
        assert processed["content_type"] == "image/jpeg"

    def test_registers_the_colony_table_with_its_raw_file_as_the_source(
        self,
        patched_converter: MagicMock,
        tmp_path: Path,
    ) -> None:
        client = _build_client_mock()
        client.create_file.side_effect = [
            _file_response(file_id=10),
            _file_response(file_id=11),
            _file_response(file_id=12),
        ]
        patched_converter.crop_plates.return_value = [MagicMock()]
        patched_converter.path = tmp_path / "scan.tif"
        csv_path = tmp_path / "scan_colonies.csv"
        csv_path.write_bytes(b"colony,area\n1,2\n")
        pipeline = MagicMock()
        pipeline.summaries = []

        with (
            patch(f"{_PATCH_PREFIX}.get_client", return_value=client),
            patch(_S3_PATCH),
            patch(
                f"{_PATCH_PREFIX}.TiffProcessor",
                return_value=patched_converter,
            ),
            patch(f"{_PATCH_PREFIX}.run_colony_pipeline", return_value=pipeline),
            patch(f"{_PATCH_PREFIX}.export_colony_csv", return_value=csv_path),
        ):
            from data_hub_lambda.epson_v700_scanner.process_file import process_file

            process_file(
                instrument_id="epson-v700-scanner",
                run_id="run-xyz",
                filename="scan.tif",
            )

        csv_create = client.create_file.call_args_list[2].kwargs
        assert csv_create["filename"] == "scan_colonies.csv"
        assert csv_create["category"] == "processed"
        assert csv_create["content_type"] == "text/csv"
        assert csv_create["source_file_id"] == 10

    def test_leaves_a_deleted_output_alone_and_stops_at_the_deleted_raw_file(
        self,
        patched_converter: MagicMock,
    ) -> None:
        from data_hub_lambda.api_client import FileDeletedError

        client = _build_client_mock()
        # The raw file was deleted while it processed: the API saves the new
        # output as deleted, and refuses the final PATCH on the raw file.
        client.create_file.side_effect = [
            _file_response(file_id=10),
            _file_response(file_id=11).model_copy(update={"deleted_at": datetime.now(UTC)}),
        ]

        def _update(file_id: int, **kwargs: Any) -> None:
            if file_id == 10 and kwargs.get("status") == "completed":
                raise FileDeletedError("Cannot update a soft-deleted file", status_code=409)

        client.update_file.side_effect = _update

        with (
            patch(f"{_PATCH_PREFIX}.get_client", return_value=client),
            patch(_S3_PATCH),
            patch(
                f"{_PATCH_PREFIX}.TiffProcessor",
                return_value=patched_converter,
            ),
        ):
            from data_hub_lambda.epson_v700_scanner.process_file import process_file

            with pytest.raises(FileDeletedError):
                process_file(
                    instrument_id="epson-v700-scanner",
                    run_id="run-xyz",
                    filename="scan.tif",
                )

        # No PATCH went to the deleted output.
        assert all(call.args[0] != 11 for call in client.update_file.call_args_list)

    def test_stores_metadata_on_run(
        self,
        patched_converter: MagicMock,
    ) -> None:
        client = _build_client_mock()

        with (
            patch(f"{_PATCH_PREFIX}.get_client", return_value=client),
            patch(_S3_PATCH),
            patch(
                f"{_PATCH_PREFIX}.TiffProcessor",
                return_value=patched_converter,
            ),
        ):
            from data_hub_lambda.epson_v700_scanner.process_file import process_file

            process_file(
                instrument_id="epson-v700-scanner",
                run_id="run-xyz",
                filename="scan.tif",
            )

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
            patch(_S3_PATCH),
            patch(
                f"{_PATCH_PREFIX}.TiffProcessor",
                return_value=patched_converter,
            ),
        ):
            from data_hub_lambda.epson_v700_scanner.process_file import process_file

            process_file(
                instrument_id="epson-v700-scanner",
                run_id="run-xyz",
                filename="scan.tif",
            )

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
            patch(_S3_PATCH),
            patch(
                f"{_PATCH_PREFIX}.TiffProcessor",
                return_value=failing_converter,
            ),
        ):
            from data_hub_lambda.epson_v700_scanner.process_file import process_file

            with pytest.raises(RuntimeError, match="boom"):
                process_file(
                    instrument_id="epson-v700-scanner",
                    run_id="run-xyz",
                    filename="broken.tif",
                )

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
