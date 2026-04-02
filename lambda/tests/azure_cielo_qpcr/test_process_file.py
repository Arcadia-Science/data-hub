from __future__ import annotations
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from data_hub_lambda.azure_cielo_qpcr.process_file import process_file
from data_hub_lambda.models import FileResponse

_FIXTURES_DIR = Path(__file__).parent / "fixtures"

_INSTRUMENT_ID = "azure-cielo-qpcr"
_RUN_ID = "Experiment_20260101"
_S3_BUCKET = "test-bucket"
_FILENAME_CSV = "Experiment_20260101_CqValues.csv"
_S3_KEY = f"{_INSTRUMENT_ID}/{_FILENAME_CSV}"


def _make_file_response(file_id: int = 1, status: str = "uploaded") -> FileResponse:
    return FileResponse(
        id=file_id,
        instrument_run_id="test-run-id",
        filename=_FILENAME_CSV,
        s3_bucket=_S3_BUCKET,
        s3_key=_S3_KEY,
        category="raw",
        status=status,
    )


def _make_client(file_response: FileResponse | None = None) -> MagicMock:
    client = MagicMock()
    client.create_file.return_value = file_response or _make_file_response()
    client.update_file.return_value = file_response or _make_file_response(status="completed")
    return client


class TestProcessFile:
    """Integration-style tests for the process_file workflow."""

    @patch("data_hub_lambda.azure_cielo_qpcr.process_file.s3_utils")
    @patch("data_hub_lambda.azure_cielo_qpcr.process_file.config")
    def test_csv_file_extracts_dye_channels(
        self, mock_config: MagicMock, mock_s3: MagicMock, tmp_path: Path
    ) -> None:
        """A CSV file should have dye_channels parsed and sent as metadata."""
        mock_config.LOCAL_RAW_DATA_DIRPATH = tmp_path

        fixture = _FIXTURES_DIR / "example.csv"
        run_dir = tmp_path / _INSTRUMENT_ID / _RUN_ID
        run_dir.mkdir(parents=True)
        (run_dir / _FILENAME_CSV).write_text(fixture.read_text())

        client = _make_client()

        result_url = process_file(
            instrument_id=_INSTRUMENT_ID,
            run_id=_RUN_ID,
            s3_bucket=_S3_BUCKET,
            s3_key=_S3_KEY,
            filename=_FILENAME_CSV,
            client=client,
        )

        client.ensure_run.assert_called_once_with(_INSTRUMENT_ID, _RUN_ID)
        client.create_file.assert_called_once()

        update_calls = client.update_file.call_args_list
        assert update_calls[0].kwargs["status"] == "processing"
        assert update_calls[1].kwargs["status"] == "completed"
        assert update_calls[1].kwargs["metadata"] == {
            "dye_channels": ["ORANGE 560", "TAMRA", "ROX"],
        }

        assert _INSTRUMENT_ID in result_url
        assert _RUN_ID in result_url

    @patch("data_hub_lambda.azure_cielo_qpcr.process_file.s3_utils")
    @patch("data_hub_lambda.azure_cielo_qpcr.process_file.config")
    def test_non_csv_file_has_empty_metadata(
        self, mock_config: MagicMock, mock_s3: MagicMock, tmp_path: Path
    ) -> None:
        """Non-CSV files (e.g. PDF) should be registered with empty metadata."""
        mock_config.LOCAL_RAW_DATA_DIRPATH = tmp_path
        pdf_filename = "Experiment_20260101_Report.pdf"
        s3_key = f"{_INSTRUMENT_ID}/{pdf_filename}"

        run_dir = tmp_path / _INSTRUMENT_ID / _RUN_ID
        run_dir.mkdir(parents=True)
        (run_dir / pdf_filename).write_bytes(b"%PDF-1.4 fake content")

        file_resp = _make_file_response()
        file_resp.filename = pdf_filename
        client = _make_client(file_resp)

        process_file(
            instrument_id=_INSTRUMENT_ID,
            run_id=_RUN_ID,
            s3_bucket=_S3_BUCKET,
            s3_key=s3_key,
            filename=pdf_filename,
            client=client,
        )

        completed_call = client.update_file.call_args_list[1]
        assert completed_call.kwargs["metadata"] == {}

    @patch("data_hub_lambda.azure_cielo_qpcr.process_file.s3_utils")
    @patch("data_hub_lambda.azure_cielo_qpcr.process_file.config")
    def test_marks_failed_on_error(
        self, mock_config: MagicMock, mock_s3: MagicMock, tmp_path: Path
    ) -> None:
        """If processing raises, the file should be marked as failed."""
        mock_config.LOCAL_RAW_DATA_DIRPATH = tmp_path

        run_dir = tmp_path / _INSTRUMENT_ID / _RUN_ID
        run_dir.mkdir(parents=True)
        bad_csv = run_dir / _FILENAME_CSV
        bad_csv.write_text("Wrong,Headers,Only\nA,B,C\n")

        client = _make_client()

        with pytest.raises(ValueError):
            process_file(
                instrument_id=_INSTRUMENT_ID,
                run_id=_RUN_ID,
                s3_bucket=_S3_BUCKET,
                s3_key=_S3_KEY,
                filename=_FILENAME_CSV,
                client=client,
            )

        failed_call = client.update_file.call_args_list[-1]
        assert failed_call.kwargs["status"] == "failed"
        assert "error_message" in failed_call.kwargs
