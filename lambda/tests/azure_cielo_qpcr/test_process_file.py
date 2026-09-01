"""Unit tests for Azure Cielo qPCR `process_file` skip vs parse behavior."""

from __future__ import annotations
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from data_hub_lambda.azure_cielo_qpcr.process_file import process_file
from data_hub_lambda.models import FileResponse

_FIXTURES_DIR = Path(__file__).resolve().parents[1] / "fixtures"


@pytest.fixture(autouse=True)
def _reset_api_client() -> Any:
    import data_hub_lambda.api_client as api_module

    original = api_module._client
    api_module._client = None
    try:
        yield
    finally:
        api_module._client = original


def _file_response(file_id: int = 10, filename: str = "file.csv") -> FileResponse:
    return FileResponse(
        id=file_id,
        instrument_run_id="run-uuid",
        filename=filename,
        s3_bucket="raw",
        s3_key=f"azure-cielo-qpcr/Experiment_20260101/{filename}",
        category="raw",
        status="uploaded",
    )


def _client() -> MagicMock:
    client = MagicMock()
    client.create_file.return_value = _file_response()
    return client


def _write_download(contents: str):
    def _download(s3_uri: str, local_path: Path, **_: Any) -> None:
        local_path.parent.mkdir(parents=True, exist_ok=True)
        local_path.write_text(contents)

    return _download


def _copy_fixture(src: Path):
    def _download(s3_uri: str, local_path: Path, **_: Any) -> None:
        local_path.parent.mkdir(parents=True, exist_ok=True)
        local_path.write_bytes(src.read_bytes())

    return _download


def _completed_statuses(client: MagicMock) -> list[str]:
    return [
        call.kwargs["status"]
        for call in client.update_file.call_args_list
        if "status" in call.kwargs
    ]


class TestProcessFileSidecars:
    @pytest.mark.parametrize(
        "filename",
        [
            "Experiment_20260101_Amplification Values.csv",
            "Experiment_20260101_Dye calibration.csv",
            "Experiment_20260101_Post Processed Amp Values.csv",
            "Experiment_20260101_JBEM_rep1_Amplification Values.csv",
        ],
    )
    def test_sidecar_csv_completes_without_failing(self, filename: str) -> None:
        client = _client()
        with (
            patch(
                "data_hub_lambda.azure_cielo_qpcr.process_file.get_client",
                return_value=client,
            ),
            patch(
                "data_hub_lambda.azure_cielo_qpcr.process_file.s3_utils.download_file",
                side_effect=_write_download("Well,Sample,Target\nA1,S1,Ch1\n"),
            ),
        ):
            process_file("azure-cielo-qpcr", "Experiment_20260101", filename)

        assert "failed" not in _completed_statuses(client)
        assert _completed_statuses(client)[-1] == "completed"
        client.update_run.assert_not_called()

    def test_unreadable_sidecar_csv_completes(self) -> None:
        client = _client()

        def _write_binary(s3_uri: str, local_path: Path, **_: Any) -> None:
            local_path.parent.mkdir(parents=True, exist_ok=True)
            local_path.write_bytes(b"\xff\xfe not utf-8")

        with (
            patch(
                "data_hub_lambda.azure_cielo_qpcr.process_file.get_client",
                return_value=client,
            ),
            patch(
                "data_hub_lambda.azure_cielo_qpcr.process_file.s3_utils.download_file",
                side_effect=_write_binary,
            ),
        ):
            process_file(
                "azure-cielo-qpcr",
                "Experiment_20260101",
                "Experiment_20260101_Dye calibration.csv",
            )

        assert _completed_statuses(client)[-1] == "completed"
        client.update_run.assert_not_called()

    def test_report_pdf_completes_without_download(self) -> None:
        client = _client()
        with (
            patch(
                "data_hub_lambda.azure_cielo_qpcr.process_file.get_client",
                return_value=client,
            ),
            patch(
                "data_hub_lambda.azure_cielo_qpcr.process_file.s3_utils.download_file"
            ) as download,
        ):
            process_file(
                "azure-cielo-qpcr",
                "Experiment_20260101",
                "Experiment_20260101_Report.PDF",
            )

        download.assert_not_called()
        assert _completed_statuses(client)[-1] == "completed"
        client.update_run.assert_not_called()

    def test_cq_values_updates_dye_channels(self) -> None:
        client = _client()
        with (
            patch(
                "data_hub_lambda.azure_cielo_qpcr.process_file.get_client",
                return_value=client,
            ),
            patch(
                "data_hub_lambda.azure_cielo_qpcr.process_file.s3_utils.download_file",
                side_effect=_copy_fixture(_FIXTURES_DIR / "azure_cielo_qpcr_example.csv"),
            ),
        ):
            process_file(
                "azure-cielo-qpcr",
                "Experiment_20260101",
                "Experiment_20260101_Cq Values.csv",
            )

        client.update_run.assert_called_once()
        assert client.update_run.call_args.kwargs["metadata"]["dye_channels"] == [
            "ORANGE 560",
            "TAMRA",
            "ROX",
        ]
        assert _completed_statuses(client)[-1] == "completed"

    def test_seed_example_csv_still_yields_dye_channels(self) -> None:
        client = _client()
        with (
            patch(
                "data_hub_lambda.azure_cielo_qpcr.process_file.get_client",
                return_value=client,
            ),
            patch(
                "data_hub_lambda.azure_cielo_qpcr.process_file.s3_utils.download_file",
                side_effect=_copy_fixture(_FIXTURES_DIR / "azure_cielo_qpcr_example.csv"),
            ),
        ):
            process_file(
                "azure-cielo-qpcr",
                "Experiment_20260129",
                "azure_cielo_qpcr_example.csv",
            )

        client.update_run.assert_called_once()
        assert _completed_statuses(client)[-1] == "completed"

    def test_broken_cq_values_still_fails(self) -> None:
        client = _client()
        with (
            patch(
                "data_hub_lambda.azure_cielo_qpcr.process_file.get_client",
                return_value=client,
            ),
            patch(
                "data_hub_lambda.azure_cielo_qpcr.process_file.s3_utils.download_file",
                side_effect=_write_download("Well,Sample,Target\nA1,S1,Ch1\n"),
            ),
            pytest.raises(ValueError, match="Fluorescence"),
        ):
            process_file(
                "azure-cielo-qpcr",
                "Experiment_20260101",
                "Experiment_20260101_Cq Values.csv",
            )

        assert client.update_file.call_args_list[-1].kwargs["status"] == "failed"
