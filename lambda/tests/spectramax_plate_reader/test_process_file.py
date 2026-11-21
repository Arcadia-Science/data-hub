"""Unit tests for `spectramax_plate_reader.process_file`.

These mock S3 I/O, the API client and the parsers, and check how the processed
CSV is registered.
"""

from __future__ import annotations
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pandas as pd
import pytest

from data_hub_lambda.models import FileResponse, RunResponse

_PATCH_PREFIX = "data_hub_lambda.spectramax_plate_reader.process_file"
_S3_PATCH = "data_hub_lambda.processed_files.s3_utils"
_INSTRUMENT = "spectramax-id3-plate-reader"
_RUN = "plate_od750"


@pytest.fixture(autouse=True)
def _small_raw_object(monkeypatch: pytest.MonkeyPatch) -> None:
    """`local_raw_file` reads the size and downloads through the shared S3 helpers."""

    def _download(_uri: str, local_path: Path, **_kwargs: Any) -> None:
        local_path.parent.mkdir(parents=True, exist_ok=True)
        local_path.write_bytes(b"xls")

    monkeypatch.setattr("data_hub_shared.s3_utils.object_content_length", lambda *_a, **_k: 128)
    monkeypatch.setattr("data_hub_shared.s3_utils.download_file", _download)


@pytest.fixture(autouse=True)
def _local_dirs_in_tmp(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from data_hub_lambda.spectramax_plate_reader.process_file import config

    monkeypatch.setattr(config, "LOCAL_RAW_DATA_DIRPATH", tmp_path / "raw")
    monkeypatch.setattr(config, "LOCAL_PROCESSED_DATA_DIRPATH", tmp_path / "processed")


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
    file_id: int, filename: str, category: str = "raw", deleted: bool = False
) -> FileResponse:
    return FileResponse(
        id=file_id,
        instrument_run_id="run-uuid",
        filename=filename,
        category=category,
        status="uploaded",
        deleted_at=datetime.now(UTC) if deleted else None,
    )


def _client(*created: FileResponse) -> MagicMock:
    client = MagicMock()
    client.ensure_run.return_value = RunResponse(
        id="run-uuid", instrument_id=_INSTRUMENT, run_id=_RUN, source="lambda", metadata={}
    )
    client.create_file.side_effect = list(created)
    return client


def _process(client: MagicMock) -> None:
    with (
        patch(f"{_PATCH_PREFIX}.get_client", return_value=client),
        patch(_S3_PATCH),
        patch(f"{_PATCH_PREFIX}.parse_metadata", return_value={"measurement_mode": "Absorbance"}),
        patch(
            f"{_PATCH_PREFIX}.parse_raw_well_data",
            return_value=pd.DataFrame({"well": ["A1"], "value": [0.5]}),
        ),
    ):
        from data_hub_lambda.spectramax_plate_reader.process_file import process_file

        process_file(instrument_id=_INSTRUMENT, run_id=_RUN, filename=f"{_RUN}.xls")


def test_registers_the_csv_with_the_export_as_its_source() -> None:
    csv_name = f"{_RUN}_raw_well_data.csv"
    client = _client(_file_response(10, f"{_RUN}.xls"), _file_response(11, csv_name, "processed"))

    _process(client)

    csv = client.create_file.call_args_list[1].kwargs
    assert csv["filename"] == csv_name
    assert csv["category"] == "processed"
    # A SpectraMax run is one export, so the CSV is linked to it.
    assert csv["source_file_id"] == 10
    assert csv["content_type"] == "text/csv"
    statuses = [
        call.kwargs["status"]
        for call in client.update_file.call_args_list
        if "status" in call.kwargs
    ]
    assert statuses == ["processing", "completed"]


def test_a_csv_saved_as_deleted_gets_no_follow_up_update() -> None:
    client = _client(
        _file_response(10, f"{_RUN}.xls"),
        _file_response(11, f"{_RUN}_raw_well_data.csv", "processed", deleted=True),
    )

    _process(client)

    assert all(call.args[0] != 11 for call in client.update_file.call_args_list)
