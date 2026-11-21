"""Unit tests for `azure_600_gel_doc.process_file`.

These verify the orchestration by mocking S3 I/O, the API client, and the TIFF
processor.
"""

from __future__ import annotations
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from data_hub_lambda.api_client import FileDeletedError
from data_hub_lambda.models import FileResponse, RunResponse

_PATCH_PREFIX = "data_hub_lambda.azure_600_gel_doc.process_file"
_S3_PATCH = "data_hub_lambda.processed_files.s3_utils"


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


def _file_response(
    file_id: int, filename: str = "gel.tif", category: str = "raw", deleted: bool = False
) -> FileResponse:
    return FileResponse(
        id=file_id,
        instrument_run_id="run-uuid",
        filename=filename,
        category=category,
        status="uploaded",
        deleted_at=datetime.now(UTC) if deleted else None,
    )


@pytest.fixture
def png_path(tmp_path: Path) -> Path:
    png = tmp_path / "gel.png"
    png.write_bytes(b"fake-png-bytes")
    return png


def _client(*created: FileResponse) -> MagicMock:
    client = MagicMock()
    client.ensure_run.return_value = RunResponse(
        id="run-uuid",
        instrument_id="azure-600-gel-doc",
        run_id="gel",
        source="lambda",
        metadata={},
    )
    client.create_file.side_effect = list(created)
    return client


def _process(client: MagicMock, png_path: Path) -> None:
    processor = MagicMock()
    processor.export_figure.return_value = png_path
    with (
        patch(f"{_PATCH_PREFIX}.get_client", return_value=client),
        patch(_S3_PATCH),
        patch(f"{_PATCH_PREFIX}.TIFFProcessor", return_value=processor),
        patch(f"{_PATCH_PREFIX}.parse_metadata", return_value={"capture_type": "Manual"}),
    ):
        from data_hub_lambda.azure_600_gel_doc.process_file import process_file

        process_file(instrument_id="azure-600-gel-doc", run_id="gel", filename="gel.tif")


def test_registers_the_png_with_its_raw_file_as_the_source(png_path: Path) -> None:
    client = _client(_file_response(10), _file_response(11, "gel.png", "processed"))

    _process(client, png_path)

    png = client.create_file.call_args_list[1].kwargs
    assert png["filename"] == "gel.png"
    assert png["category"] == "processed"
    assert png["source_file_id"] == 10
    assert png["content_type"] == "image/png"
    assert png["size_bytes"] == png_path.stat().st_size
    client.update_file.assert_any_call(
        11, size_bytes=png_path.stat().st_size, content_type="image/png"
    )


def test_marks_the_raw_file_completed_and_stores_run_metadata(png_path: Path) -> None:
    client = _client(_file_response(10), _file_response(11, "gel.png", "processed"))

    _process(client, png_path)

    client.update_run.assert_called_once_with(
        "azure-600-gel-doc", "gel", metadata={"capture_type": "Manual"}
    )
    statuses = [
        call.kwargs["status"]
        for call in client.update_file.call_args_list
        if "status" in call.kwargs
    ]
    assert statuses == ["processing", "completed"]


def test_a_png_saved_as_deleted_gets_no_follow_up_update(png_path: Path) -> None:
    # The raw file was deleted while it processed, so the API saved the PNG as
    # deleted too, and a deleted file refuses a PATCH.
    client = _client(_file_response(10), _file_response(11, "gel.png", "processed", deleted=True))

    _process(client, png_path)

    assert all(call.args[0] != 11 for call in client.update_file.call_args_list)


def test_stops_when_the_raw_file_was_deleted_before_it_started(png_path: Path) -> None:
    client = _client(_file_response(10, deleted=True))
    client.update_file.side_effect = FileDeletedError(
        "Cannot update a soft-deleted file", status_code=409
    )

    with pytest.raises(FileDeletedError):
        _process(client, png_path)

    assert client.create_file.call_count == 1
