"""TapeStation reads the tape type from the filename without fetching the file."""

from __future__ import annotations
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from data_hub_lambda.agilent_4150_tapestation.process_file import process_file
from data_hub_lambda.models import FileResponse

_FILENAME = "2026-02-18 - 18-00-04-gDNA_peakTable.csv"


def _never(*_a: Any, **_k: Any) -> None:
    raise AssertionError("TapeStation does not read the raw file, so it should not fetch it")


def test_tape_type_is_stored_without_a_download(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("data_hub_shared.s3_utils.object_content_length", _never)
    monkeypatch.setattr("data_hub_shared.s3_utils.download_file", _never)
    client = MagicMock()
    client.create_file.return_value = FileResponse(
        id=8,
        instrument_run_id="run-uuid",
        filename=_FILENAME,
        s3_bucket="raw",
        s3_key=f"tapestation/2026-02-18 - 18-00-04/{_FILENAME}",
        category="raw",
        status="uploaded",
    )

    with patch(
        "data_hub_lambda.agilent_4150_tapestation.process_file.get_client", return_value=client
    ):
        process_file("tapestation", "2026-02-18 - 18-00-04", _FILENAME)

    client.update_run.assert_called_once_with(
        "tapestation", "2026-02-18 - 18-00-04", metadata={"Tape Type": "gDNA"}
    )
    statuses = [call.kwargs["status"] for call in client.update_file.call_args_list]
    assert statuses == ["processing", "completed"]
