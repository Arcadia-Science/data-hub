"""Unit tests for `unchained_labs_aunty.process_file`.

These mock S3 I/O, the API client and the workbook parser, and check how the
curves CSV and the plate JSON are registered.
"""

from __future__ import annotations
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from data_hub_lambda.models import FileResponse, RunResponse
from data_hub_lambda.unchained_labs_aunty.utils import ParsedAunty

_PATCH_PREFIX = "data_hub_lambda.unchained_labs_aunty.process_file"
_S3_PATCH = "data_hub_lambda.processed_files.s3_utils"
_INSTRUMENT = "unchained-labs-aunty"
_RUN = "aunty_export_1"


@pytest.fixture(autouse=True)
def _small_raw_object(monkeypatch: pytest.MonkeyPatch) -> None:
    """`local_raw_file` reads the size and downloads through the shared S3 helpers."""

    def _download(_uri: str, local_path: Path, **_kwargs: Any) -> None:
        local_path.parent.mkdir(parents=True, exist_ok=True)
        local_path.write_bytes(b"xlsx")

    monkeypatch.setattr("data_hub_shared.s3_utils.object_content_length", lambda *_a, **_k: 128)
    monkeypatch.setattr("data_hub_shared.s3_utils.download_file", _download)


@pytest.fixture(autouse=True)
def _local_dirs_in_tmp(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from data_hub_lambda.unchained_labs_aunty.process_file import config

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
    parsed = ParsedAunty(metadata={"experiments": 0}, experiments=[], curve_rows=[])
    with (
        patch(f"{_PATCH_PREFIX}.get_client", return_value=client),
        patch(_S3_PATCH),
        patch(f"{_PATCH_PREFIX}.parse_aunty_workbook", return_value=parsed),
    ):
        from data_hub_lambda.unchained_labs_aunty.process_file import process_file

        process_file(instrument_id=_INSTRUMENT, run_id=_RUN, filename=f"{_RUN}.xlsx")


def test_registers_both_outputs_with_the_workbook_as_their_source() -> None:
    client = _client(
        _file_response(10, f"{_RUN}.xlsx"),
        _file_response(11, f"{_RUN}_aunty_curves.csv", "processed"),
        _file_response(12, f"{_RUN}_aunty_plate.json", "processed"),
    )

    _process(client)

    created = {call.kwargs["filename"]: call.kwargs for call in client.create_file.call_args_list}
    # An Aunty run is one workbook, so both outputs are linked to it.
    assert created[f"{_RUN}_aunty_curves.csv"]["source_file_id"] == 10
    assert created[f"{_RUN}_aunty_curves.csv"]["content_type"] == "text/csv"
    assert created[f"{_RUN}_aunty_plate.json"]["source_file_id"] == 10
    assert created[f"{_RUN}_aunty_plate.json"]["content_type"] == "application/json"
    assert "source_file_id" not in created[f"{_RUN}.xlsx"]
    statuses = [
        call.kwargs["status"]
        for call in client.update_file.call_args_list
        if "status" in call.kwargs
    ]
    assert statuses == ["processing", "completed"]


def test_outputs_saved_as_deleted_get_no_follow_up_update() -> None:
    client = _client(
        _file_response(10, f"{_RUN}.xlsx"),
        _file_response(11, f"{_RUN}_aunty_curves.csv", "processed", deleted=True),
        _file_response(12, f"{_RUN}_aunty_plate.json", "processed", deleted=True),
    )

    _process(client)

    assert all(call.args[0] == 10 for call in client.update_file.call_args_list)
