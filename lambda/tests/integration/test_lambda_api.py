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
from data_hub_shared.testing import IntegrationEnv

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
        run_id = "Experiment_20260101"
        filename = f"{run_id}_CqValues.csv"
        s3_key = f"azure-cielo-qpcr/{run_id}/{filename}"
        s3_fixture_files[s3_key] = _FIXTURES_DIR / "azure_cielo_qpcr_example.csv"

        # Fire the event to trigger the pipeline.
        event = make_s3_event("azure-cielo-qpcr", run_id, filename)
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
    @pytest.mark.parametrize(
        ("fixture_file", "run_id", "expected_metadata", "expected_first_plate"),
        [
            pytest.param(
                "spectramax_plate_reader_endpoint.xls",
                "033126_CM_Od750",
                {
                    "measurement_mode": "Absorbance",
                    "measurement_type": "Endpoint",
                    "wavelength": "750 nm",
                },
                "Plate2",
                id="endpoint",
            ),
            pytest.param(
                "spectramax_plate_reader_well_scan.xls",
                "033126_WS_Od595",
                {
                    "measurement_mode": "Absorbance",
                    "measurement_type": "Well Scan",
                    "wavelength": "595 nm",
                },
                "Plate1",
                id="well-scan",
            ),
            pytest.param(
                "spectramax_plate_reader_kinetic.xls",
                "033126_KN_Od595",
                {
                    "measurement_mode": "Absorbance",
                    "measurement_type": "Kinetic",
                    "wavelength": "595 nm",
                },
                "Plate4",
                id="kinetic",
            ),
        ],
    )
    def test_xls_completes_with_report_data(
        self,
        integration_env: IntegrationEnv,
        make_s3_event: Callable[..., dict[str, Any]],
        s3_fixture_files: dict[str, Path],
        mock_context: MagicMock,
        mock_slack: MagicMock,
        fixture_file: str,
        run_id: str,
        expected_metadata: dict[str, str],
        expected_first_plate: str,
    ) -> None:
        # Register the real fixture CSV so the patched S3 download can find it.
        filename = f"{run_id}.xls"
        s3_key = f"spectramax-id3-plate-reader/{run_id}/{filename}"
        s3_fixture_files[s3_key] = _FIXTURES_DIR / fixture_file

        # Fire the event to trigger the pipeline.
        event = make_s3_event("spectramax-id3-plate-reader", run_id, filename)
        lambda_handler(event, mock_context)

        # Verify via the real API that the full pipeline wrote correct data.
        run = _api_get(
            integration_env.base_url,
            integration_env.api_token,
            f"/api/v1/instruments/spectramax-id3-plate-reader/runs/{run_id}",
        )

        assert run["source"] == "lambda"
        assert run["run_id"] == run_id

        assert len(run["files"]) == 1
        file = run["files"][0]
        assert file["status"] == "completed"

        # Verify the run-level metadata.
        for key, value in expected_metadata.items():
            assert run["metadata"][key] == value

        # Verify the raw well data.
        assert len(run["report_data"]) == 1
        run_report_data = run["report_data"][0]
        assert run_report_data["data_type"] == "raw_well_data"
        assert isinstance(run_report_data["data"], list)
        assert len(run_report_data["data"]) > 0

        first_row = run_report_data["data"][0]
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
        assert first_row["plate_name"] == expected_first_plate

        # Verify the Slack notification.
        mock_slack.assert_called_once()
        slack_msg = mock_slack.call_args[0][0]
        assert run_id in slack_msg
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
        # Register the real fixture TIFF so the patched S3 download can find it.
        run_id = "26.04.01_16.51.59"
        filename = f"{run_id}.tif"
        s3_key = f"azure-600-gel-doc/{run_id}/{filename}"
        s3_fixture_files[s3_key] = _FIXTURES_DIR / "azure_600_gel_doc_example.tif"

        # Fire the event to trigger the pipeline.
        event = make_s3_event("azure-600-gel-doc", run_id, filename)
        lambda_handler(event, mock_context)

        # Verify via the real API that the full pipeline wrote correct data.
        run = _api_get(
            integration_env.base_url,
            integration_env.api_token,
            f"/api/v1/instruments/azure-600-gel-doc/runs/{run_id}",
        )

        assert run["source"] == "lambda"
        assert run["run_id"] == run_id

        # The Gel Doc pipeline registers two files: the raw TIFF and a
        # contrast-enhanced PNG derived from it.
        assert len(run["files"]) == 2

        raw_file = next(f for f in run["files"] if f["category"] == "raw")
        processed_file = next(f for f in run["files"] if f["category"] == "processed")

        assert raw_file["status"] == "completed"
        assert raw_file["filename"] == f"{run_id}.tif"

        # Verify the run-level metadata.
        assert run["metadata"]["capture_type"] == "Manual"
        assert run["metadata"]["imaging_mode"] == "Chemiluminescence"
        assert run["metadata"]["wavelengths"] == []
        assert run["metadata"]["colors"] == []

        # Verify the processed file.
        assert processed_file["filename"] == f"{run_id}.png"
        assert processed_file["status"] == "uploaded"

        # Gel Doc files don't produce tabular report_data.
        assert run["report_data"] == []

        # The pipeline uploads the contrast-enhanced PNG to the processed bucket.
        mock_s3_upload.assert_called_once()
        upload_dest = mock_s3_upload.call_args[0][1]
        assert upload_dest == f"s3://test-processed-bucket/azure-600-gel-doc/{run_id}/{run_id}.png"

        # Verify the Slack notification.
        mock_slack.assert_called_once()
        slack_msg = mock_slack.call_args[0][0]
        assert run_id in slack_msg
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

        run_id = "Experiment_20260201"
        filename = f"{run_id}_CqValues.csv"
        s3_key = f"azure-cielo-qpcr/{run_id}/{filename}"
        s3_fixture_files[s3_key] = bad_csv

        # Fire the event to trigger the pipeline.
        event = make_s3_event("azure-cielo-qpcr", run_id, filename)
        lambda_handler(event, mock_context)

        # Verify via the real API that the full pipeline wrote correct data.
        run = _api_get(
            integration_env.base_url,
            integration_env.api_token,
            f"/api/v1/instruments/azure-cielo-qpcr/runs/{run_id}",
        )

        # Verify that the file was marked as failed.
        assert len(run["files"]) == 1
        file = run["files"][0]
        assert file["status"] == "failed"
        assert file["error_message"]

        # Verify the Slack notification.
        mock_slack.assert_called_once()
        slack_msg = mock_slack.call_args[0][0]
        assert run_id in slack_msg
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
        run_id = "Experiment_20260301"
        filename = f"{run_id}_CqValues.csv"
        s3_key = f"azure-cielo-qpcr/{run_id}/{filename}"
        s3_fixture_files[s3_key] = _FIXTURES_DIR / "azure_cielo_qpcr_example.csv"

        # Fire the same event twice to verify the upsert semantics of
        # ensure_run: the API returns 200 (existing) on the second call
        # rather than creating a duplicate.
        event = make_s3_event("azure-cielo-qpcr", run_id, filename)
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
                    (run_id,),
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
            f"/api/v1/instruments/azure-cielo-qpcr/runs/{run_id}",
        )
        assert run["run_id"] == run_id
        assert run["source"] == "lambda"

        assert mock_slack.call_count == 2
        for call in mock_slack.call_args_list:
            slack_msg = call[0][0]
            assert run_id in slack_msg
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
        run_id = "Experiment_20260301"
        filename = f"{run_id}_CqValues.csv"
        s3_key = f"azure-cielo-qpcr/{run_id}/{filename}"
        s3_fixture_files[s3_key] = _FIXTURES_DIR / "azure_cielo_qpcr_example.csv"

        event = make_s3_event("azure-cielo-qpcr", run_id, filename)
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
            f"/api/v1/instruments/azure-cielo-qpcr/runs/{run_id}",
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
        run_id = "Experiment_20260301"
        filename = f"{run_id}_CqValues.csv"
        s3_key = f"azure-cielo-qpcr/{run_id}/{filename}"
        bad_csv = tmp_path / "bad.csv"
        bad_csv.write_text("Wrong,Headers,Only\nA,B,C\n")
        s3_fixture_files[s3_key] = bad_csv

        event = make_s3_event("azure-cielo-qpcr", run_id, filename)
        lambda_handler(event, mock_context)

        run = _api_get(
            integration_env.base_url,
            integration_env.api_token,
            f"/api/v1/instruments/azure-cielo-qpcr/runs/{run_id}",
        )
        assert run["files"][0]["status"] == "failed"
        assert run["files"][0]["error_message"]

        # Swap in the valid fixture and reprocess.
        s3_fixture_files[s3_key] = _FIXTURES_DIR / "azure_cielo_qpcr_example.csv"
        lambda_handler(event, mock_context)

        run = _api_get(
            integration_env.base_url,
            integration_env.api_token,
            f"/api/v1/instruments/azure-cielo-qpcr/runs/{run_id}",
        )
        assert len(run["files"]) == 1
        assert run["files"][0]["status"] == "completed"
        assert run["files"][0]["error_message"] is None

        # Verify the Slack notifications.
        assert mock_slack.call_count == 2
        assert "View CloudWatch logs" in mock_slack.call_args_list[0][0][0]
        assert "View in Data Hub" in mock_slack.call_args_list[1][0][0]

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
        run_id = "033126_CM_Od750"
        filename = f"{run_id}.xls"
        s3_key = f"spectramax-id3-plate-reader/{run_id}/{filename}"
        s3_fixture_files[s3_key] = _FIXTURES_DIR / "spectramax_plate_reader_endpoint.xls"

        # Fire the event twice.
        event = make_s3_event("spectramax-id3-plate-reader", run_id, filename)
        lambda_handler(event, mock_context)
        lambda_handler(event, mock_context)

        # Verify via the real API that the full pipeline wrote correct data.
        run = _api_get(
            integration_env.base_url,
            integration_env.api_token,
            f"/api/v1/instruments/spectramax-id3-plate-reader/runs/{run_id}",
        )

        # Verify that the report_data was not duplicated.
        assert len(run["report_data"]) == 1
        assert run["report_data"][0]["data_type"] == "raw_well_data"

        # Verify the Slack notifications.
        assert mock_slack.call_count == 2
        for call in mock_slack.call_args_list:
            slack_msg = call[0][0]
            assert run_id in slack_msg
            assert "View in Data Hub" in slack_msg
