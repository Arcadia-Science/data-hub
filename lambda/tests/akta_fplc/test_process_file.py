"""AKTA FPLC registers the PDF without fetching it."""

from __future__ import annotations
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from data_hub_lambda.akta_fplc.process_file import process_file
from data_hub_lambda.models import FileResponse


def _never(*_a: Any, **_k: Any) -> None:
    raise AssertionError("AKTA does not read the raw file, so it should not fetch it")


def test_pdf_is_completed_without_a_download(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("data_hub_shared.s3_utils.object_content_length", _never)
    monkeypatch.setattr("data_hub_shared.s3_utils.download_file", _never)
    client = MagicMock()
    client.create_file.return_value = FileResponse(
        id=7,
        instrument_run_id="run-uuid",
        filename="chromatogram.pdf",
        s3_bucket="raw",
        s3_key="akta/run-1/chromatogram.pdf",
        category="raw",
        status="uploaded",
    )

    with patch("data_hub_lambda.akta_fplc.process_file.get_client", return_value=client):
        process_file("akta", "run-1", "chromatogram.pdf")

    statuses = [call.kwargs["status"] for call in client.update_file.call_args_list]
    assert statuses == ["processing", "completed"]
