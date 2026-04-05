"""Integration tests: Lambda -> API -> Postgres.

Each test constructs a realistic S3 event, calls `lambda_handler` with
only S3 and Slack mocked, then verifies the outcome via API GETs and
direct DB queries.
"""

from __future__ import annotations
from collections.abc import Callable
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import psycopg2
import pytest
import requests

from data_hub_lambda.handler import lambda_handler
from integration.conftest import IntegrationEnv

_FIXTURES_DIR = Path(__file__).resolve().parents[1] / "fixtures"

# Apply the `integration` marker to every test in this module so they can
# be selected (or excluded) with `pytest -m integration`.
pytestmark = pytest.mark.integration


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------


def _api_get(base_url: str, api_token: str, path: str) -> dict[str, Any]:
    """GET an API endpoint on the test server and return parsed JSON."""
    resp = requests.get(
        f"{base_url}{path}",
        headers={"Authorization": f"Bearer {api_token}"},
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()


# ------------------------------------------------------------------
# Test 4a: Azure Cielo qPCR CSV — happy path
# ------------------------------------------------------------------


class TestQPCRHappyPath:
    def test_csv_completes_with_dye_channels(
        self,
        integration_env: IntegrationEnv,
        make_s3_event: Callable[..., dict[str, Any]],
        s3_fixture_files: dict[str, Path],
        mock_context: MagicMock,
        mock_slack: MagicMock,
    ) -> None:
        # Register the real fixture CSV so the patched S3 download can find it.
        s3_key = "azure-cielo-qpcr/Experiment_20260101_CqValues.csv"
        s3_fixture_files[s3_key] = _FIXTURES_DIR / "azure_cielo_qpcr_example.csv"

        event = make_s3_event("azure-cielo-qpcr", "Experiment_20260101_CqValues.csv")
        lambda_handler(event, mock_context)

        # Verify via the real API that the full pipeline wrote correct data.
        run = _api_get(
            integration_env.base_url,
            integration_env.api_token,
            "/api/v1/instruments/azure-cielo-qpcr/runs/Experiment_20260101",
        )

        # Runs auto-created by the Lambda (no pre-existing watcher run) are
        # tagged with source "lambda" to distinguish them in the UI.
        assert run["source"] == "lambda"
        assert run["run_id"] == "Experiment_20260101"

        assert len(run["files"]) == 1
        file = run["files"][0]
        assert file["status"] == "completed"
        # Dye channels are extracted from the Fluorescence column of the CSV
        # and stored as run-level metadata.
        assert run["metadata"]["dye_channels"] == ["ORANGE 560", "TAMRA", "ROX"]

        # qPCR files don't produce tabular report_data (unlike plate readers).
        assert run["report_data"] == []

        mock_slack.assert_called_once()
        slack_msg = mock_slack.call_args[0][0]
        assert "Experiment_20260101" in slack_msg
        assert "View in Data Hub" in slack_msg


# ------------------------------------------------------------------
# Test 4b: SpectraMax plate reader — happy path with report_data
# ------------------------------------------------------------------


class TestSpectraMaxHappyPath:
    def test_xls_completes_with_report_data(
        self,
        integration_env: IntegrationEnv,
        make_s3_event: Callable[..., dict[str, Any]],
        s3_fixture_files: dict[str, Path],
        mock_context: MagicMock,
        mock_slack: MagicMock,
    ) -> None:
        s3_key = "spectramax-id3-plate-reader/033126_CM_Od750.xls"
        s3_fixture_files[s3_key] = _FIXTURES_DIR / "spectramax_plate_reader_example_1.xls"

        event = make_s3_event("spectramax-id3-plate-reader", "033126_CM_Od750.xls")
        lambda_handler(event, mock_context)

        run = _api_get(
            integration_env.base_url,
            integration_env.api_token,
            "/api/v1/instruments/spectramax-id3-plate-reader/runs/033126_CM_Od750",
        )

        assert run["source"] == "lambda"
        assert run["run_id"] == "033126_CM_Od750"

        assert len(run["files"]) == 1
        file = run["files"][0]
        assert file["status"] == "completed"

        # Fixture example_1 is an Endpoint / Absorbance / 750 nm plate.
        # Measurement metadata is stored at the run level.
        assert run["metadata"]["measurement_mode"] == "Absorbance"
        assert run["metadata"]["measurement_type"] == "Endpoint"
        assert run["metadata"]["wavelength"] == "750 nm"

        # Plate readers produce tabular report_data rows stored in
        # run_report_data and returned alongside the run.
        assert len(run["report_data"]) == 1
        rd = run["report_data"][0]
        assert rd["data_type"] == "raw_well_data"
        assert isinstance(rd["data"], list)
        assert len(rd["data"]) > 0

        first_row = rd["data"][0]
        expected_columns = {
            "time",
            "plate_name",
            "well_position",
            "temperature_c",
            "value",
            "row_label",
            "column_label",
            "wavelength",
        }
        assert set(first_row.keys()) == expected_columns
        assert first_row["plate_name"] == "Plate2"

        mock_slack.assert_called_once()
        slack_msg = mock_slack.call_args[0][0]
        assert "033126_CM_Od750" in slack_msg
        assert "View in Data Hub" in slack_msg


# ------------------------------------------------------------------
# Test 4b': Azure 600 Gel Doc — happy path with processed image
# ------------------------------------------------------------------


class TestAzure600GelDocHappyPath:
    def test_tif_completes_with_metadata_and_processed_image(
        self,
        integration_env: IntegrationEnv,
        make_s3_event: Callable[..., dict[str, Any]],
        s3_fixture_files: dict[str, Path],
        mock_context: MagicMock,
        mock_slack: MagicMock,
        mock_s3_upload: MagicMock,
    ) -> None:
        s3_key = "azure-600-gel-doc/26.04.01_16.51.59.tif"
        s3_fixture_files[s3_key] = _FIXTURES_DIR / "azure_600_gel_doc_example.tif"

        event = make_s3_event("azure-600-gel-doc", "26.04.01_16.51.59.tif")
        lambda_handler(event, mock_context)

        run = _api_get(
            integration_env.base_url,
            integration_env.api_token,
            "/api/v1/instruments/azure-600-gel-doc/runs/26.04.01_16.51.59",
        )

        assert run["source"] == "lambda"
        assert run["run_id"] == "26.04.01_16.51.59"

        # The Gel Doc pipeline registers two files: the raw TIFF and a
        # contrast-enhanced PNG derived from it.
        assert len(run["files"]) == 2

        raw_file = next(f for f in run["files"] if f["category"] == "raw")
        processed_file = next(f for f in run["files"] if f["category"] == "processed")

        assert raw_file["status"] == "completed"
        assert raw_file["filename"] == "26.04.01_16.51.59.tif"

        # TIFF metadata is stored at the run level.
        assert run["metadata"]["capture_type"] == "Manual"
        assert run["metadata"]["imaging_mode"] == "Chemiluminescence"
        assert run["metadata"]["wavelengths"] == []
        assert run["metadata"]["colors"] == []

        assert processed_file["filename"] == "26.04.01_16.51.59.png"
        assert processed_file["status"] == "uploaded"

        # Gel Doc files don't produce tabular report_data.
        assert run["report_data"] == []

        # The pipeline uploads the contrast-enhanced PNG to the processed bucket.
        mock_s3_upload.assert_called_once()
        upload_dest = mock_s3_upload.call_args[0][1]
        assert upload_dest == "s3://test-processed-bucket/azure-600-gel-doc/26.04.01_16.51.59.png"

        mock_slack.assert_called_once()
        slack_msg = mock_slack.call_args[0][0]
        assert "26.04.01_16.51.59" in slack_msg
        assert "View in Data Hub" in slack_msg


# ------------------------------------------------------------------
# Test 4c: Malformed file — failure path
# ------------------------------------------------------------------


class TestFailurePath:
    def test_malformed_csv_marks_file_as_failed(
        self,
        integration_env: IntegrationEnv,
        make_s3_event: Callable[..., dict[str, Any]],
        s3_fixture_files: dict[str, Path],
        mock_context: MagicMock,
        mock_slack: MagicMock,
        tmp_path: Path,
    ) -> None:
        # Create a CSV whose headers don't match the expected qPCR format.
        # The parser will fail, exercising the error-handling branch.
        bad_csv = tmp_path / "bad.csv"
        bad_csv.write_text("Wrong,Headers,Only\nA,B,C\n")

        s3_key = "azure-cielo-qpcr/Experiment_20260201_CqValues.csv"
        s3_fixture_files[s3_key] = bad_csv

        event = make_s3_event("azure-cielo-qpcr", "Experiment_20260201_CqValues.csv")
        # No `pytest.raises` needed — process_file marks the file as failed
        # via the API and re-raises; lambda_handler then catches the
        # re-raised exception and sends a Slack notification (also mocked).
        lambda_handler(event, mock_context)

        run = _api_get(
            integration_env.base_url,
            integration_env.api_token,
            "/api/v1/instruments/azure-cielo-qpcr/runs/Experiment_20260201",
        )

        assert len(run["files"]) == 1
        file = run["files"][0]
        assert file["status"] == "failed"
        assert file["error_message"]

        mock_slack.assert_called_once()
        slack_msg = mock_slack.call_args[0][0]
        assert "Experiment_20260201" in slack_msg
        assert "View CloudWatch logs" in slack_msg


# ------------------------------------------------------------------
# Test 4d: Idempotent run creation
# ------------------------------------------------------------------


class TestIdempotentRunCreation:
    def test_duplicate_event_creates_single_run(
        self,
        integration_env: IntegrationEnv,
        make_s3_event: Callable[..., dict[str, Any]],
        s3_fixture_files: dict[str, Path],
        mock_context: MagicMock,
        mock_slack: MagicMock,
    ) -> None:
        s3_key = "azure-cielo-qpcr/Experiment_20260301_CqValues.csv"
        s3_fixture_files[s3_key] = _FIXTURES_DIR / "azure_cielo_qpcr_example.csv"

        # Fire the same event twice to verify the upsert semantics of
        # ensure_run: the API returns 200 (existing) on the second call
        # rather than creating a duplicate.
        event = make_s3_event("azure-cielo-qpcr", "Experiment_20260301_CqValues.csv")
        lambda_handler(event, mock_context)
        lambda_handler(event, mock_context)

        # Direct DB query — the API GET returns a single run object, so it
        # can't reveal whether a duplicate row was silently created.  Counting
        # rows in instrument_runs is the only reliable check.
        conn = psycopg2.connect(integration_env.db_dsn)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*) FROM instrument_runs WHERE run_id = %s",
                    ("Experiment_20260301",),
                )
                row = cur.fetchone()
                assert row is not None
                run_count = row[0]
        finally:
            conn.close()

        assert run_count == 1

        run = _api_get(
            integration_env.base_url,
            integration_env.api_token,
            "/api/v1/instruments/azure-cielo-qpcr/runs/Experiment_20260301",
        )
        assert run["run_id"] == "Experiment_20260301"
        assert run["source"] == "lambda"

        assert mock_slack.call_count == 2
        for call in mock_slack.call_args_list:
            slack_msg = call[0][0]
            assert "Experiment_20260301" in slack_msg
            assert "View in Data Hub" in slack_msg


# ------------------------------------------------------------------
# Test 4e: File reprocessing
# ------------------------------------------------------------------


class TestFileReprocessing:
    def test_duplicate_event_creates_single_file(
        self,
        integration_env: IntegrationEnv,
        make_s3_event: Callable[..., dict[str, Any]],
        s3_fixture_files: dict[str, Path],
        mock_context: MagicMock,
        mock_slack: MagicMock,
    ) -> None:
        """Firing the same S3 event twice must not create a duplicate file row.

        The create_file API is idempotent on s3_key (partial unique index with
        onConflictDoNothing). The second invocation reprocesses the existing
        file via completed → processing → completed.
        """
        s3_key = "azure-cielo-qpcr/Experiment_20260301_CqValues.csv"
        s3_fixture_files[s3_key] = _FIXTURES_DIR / "azure_cielo_qpcr_example.csv"

        event = make_s3_event("azure-cielo-qpcr", "Experiment_20260301_CqValues.csv")
        lambda_handler(event, mock_context)
        lambda_handler(event, mock_context)

        conn = psycopg2.connect(integration_env.db_dsn)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*) FROM files WHERE s3_key = %s",
                    (s3_key,),
                )
                row = cur.fetchone()
                assert row is not None
                file_count = row[0]
        finally:
            conn.close()

        assert file_count == 1

        run = _api_get(
            integration_env.base_url,
            integration_env.api_token,
            "/api/v1/instruments/azure-cielo-qpcr/runs/Experiment_20260301",
        )
        assert len(run["files"]) == 1
        assert run["files"][0]["status"] == "completed"

    def test_reprocess_clears_failed_state(
        self,
        integration_env: IntegrationEnv,
        make_s3_event: Callable[..., dict[str, Any]],
        s3_fixture_files: dict[str, Path],
        mock_context: MagicMock,
        mock_slack: MagicMock,
        tmp_path: Path,
    ) -> None:
        """A failed file can be reprocessed successfully on a retry.

        First invocation uses a malformed CSV → file ends in "failed" with an
        error_message. Second invocation swaps in the valid fixture → the
        file transitions failed → processing → completed with the error
        cleared.
        """
        s3_key = "azure-cielo-qpcr/Experiment_20260301_CqValues.csv"
        bad_csv = tmp_path / "bad.csv"
        bad_csv.write_text("Wrong,Headers,Only\nA,B,C\n")
        s3_fixture_files[s3_key] = bad_csv

        event = make_s3_event("azure-cielo-qpcr", "Experiment_20260301_CqValues.csv")
        lambda_handler(event, mock_context)

        run = _api_get(
            integration_env.base_url,
            integration_env.api_token,
            "/api/v1/instruments/azure-cielo-qpcr/runs/Experiment_20260301",
        )
        assert run["files"][0]["status"] == "failed"
        assert run["files"][0]["error_message"]

        # Swap in the valid fixture and reprocess.
        s3_fixture_files[s3_key] = _FIXTURES_DIR / "azure_cielo_qpcr_example.csv"
        lambda_handler(event, mock_context)

        run = _api_get(
            integration_env.base_url,
            integration_env.api_token,
            "/api/v1/instruments/azure-cielo-qpcr/runs/Experiment_20260301",
        )
        assert len(run["files"]) == 1
        assert run["files"][0]["status"] == "completed"
        assert run["files"][0]["error_message"] is None

    def test_reprocess_does_not_duplicate_report_data(
        self,
        integration_env: IntegrationEnv,
        make_s3_event: Callable[..., dict[str, Any]],
        s3_fixture_files: dict[str, Path],
        mock_context: MagicMock,
        mock_slack: MagicMock,
    ) -> None:
        """Reprocessing a plate reader file must not double the report_data.

        The PATCH endpoint deletes existing run_report_data rows for the file
        when transitioning back to "processing", so the second invocation
        replaces rather than appends.
        """
        s3_key = "spectramax-id3-plate-reader/033126_CM_Od750.xls"
        s3_fixture_files[s3_key] = _FIXTURES_DIR / "spectramax_plate_reader_example_1.xls"

        event = make_s3_event("spectramax-id3-plate-reader", "033126_CM_Od750.xls")
        lambda_handler(event, mock_context)
        lambda_handler(event, mock_context)

        run = _api_get(
            integration_env.base_url,
            integration_env.api_token,
            "/api/v1/instruments/spectramax-id3-plate-reader/runs/033126_CM_Od750",
        )
        assert len(run["report_data"]) == 1
        assert run["report_data"][0]["data_type"] == "raw_well_data"
