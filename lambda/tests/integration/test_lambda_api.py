"""Integration tests: Lambda -> API -> Postgres.

Each test constructs a realistic S3 event, calls `lambda_handler` with
only S3 mocked, then verifies the outcome via API GETs and direct DB
queries.
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
    ) -> None:
        # Register the real fixture CSV so the patched S3 download can find it.
        run_id = "Experiment_20260101"
        filename = f"{run_id}_Cq Values.csv"
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

        # qPCR files don't produce processed CSV files (unlike plate readers).
        assert all(f["category"] == "raw" for f in run["files"])


# ------------------------------------------------------------------
# Test 4b: SpectraMax plate reader — happy path with processed CSV
# ------------------------------------------------------------------


class TestSpectraMaxHappyPath:
    @pytest.mark.parametrize(
        ("fixture_file", "run_id", "expected_metadata"),
        [
            pytest.param(
                "spectramax_plate_reader_endpoint.xls",
                "033126_CM_Od750",
                {
                    "measurement_mode": "Absorbance",
                    "measurement_type": "Endpoint",
                    "wavelengths": ["750"],
                },
                id="endpoint",
            ),
            pytest.param(
                "spectramax_plate_reader_well_scan.xls",
                "033126_WS_Od595",
                {
                    "measurement_mode": "Absorbance",
                    "measurement_type": "Well Scan",
                    "wavelengths": ["595"],
                },
                id="well-scan",
            ),
            pytest.param(
                "spectramax_plate_reader_kinetic.xls",
                "033126_KN_Od595",
                {
                    "measurement_mode": "Absorbance",
                    "measurement_type": "Kinetic",
                    "wavelengths": ["595"],
                },
                id="kinetic",
            ),
        ],
    )
    def test_xls_completes_with_processed_csv(
        self,
        integration_env: IntegrationEnv,
        make_s3_event: Callable[..., dict[str, Any]],
        s3_fixture_files: dict[str, Path],
        mock_context: MagicMock,
        mock_s3_upload: MagicMock,
        fixture_file: str,
        run_id: str,
        expected_metadata: dict[str, object],
    ) -> None:
        filename = f"{run_id}.xls"
        s3_key = f"spectramax-id3-plate-reader/{run_id}/{filename}"
        s3_fixture_files[s3_key] = _FIXTURES_DIR / fixture_file

        event = make_s3_event("spectramax-id3-plate-reader", run_id, filename)
        lambda_handler(event, mock_context)

        run = _api_get(
            integration_env.base_url,
            integration_env.api_token,
            f"/api/v1/instruments/spectramax-id3-plate-reader/runs/{run_id}",
        )

        assert run["source"] == "lambda"
        assert run["run_id"] == run_id

        # Two files: the raw .xls and the processed CSV.
        assert len(run["files"]) == 2

        raw_file = next(f for f in run["files"] if f["category"] == "raw")
        processed_file = next(f for f in run["files"] if f["category"] == "processed")

        assert raw_file["status"] == "completed"
        assert processed_file["filename"] == f"{run_id}_raw_well_data.csv"
        assert processed_file["status"] == "uploaded"

        for key, value in expected_metadata.items():
            assert run["metadata"][key] == value

        # The pipeline uploads the processed CSV to the processed bucket.
        mock_s3_upload.assert_called_once()
        upload_dest = mock_s3_upload.call_args[0][1]
        assert upload_dest == (
            f"s3://test-processed-bucket/spectramax-id3-plate-reader/{run_id}/{run_id}_raw_well_data.csv"
        )


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

        # Gel Doc files don't produce additional CSV report data.
        assert len([f for f in run["files"] if f["filename"].endswith(".csv")]) == 0

        # The pipeline uploads the contrast-enhanced PNG to the processed bucket.
        mock_s3_upload.assert_called_once()
        upload_dest = mock_s3_upload.call_args[0][1]
        assert upload_dest == f"s3://test-processed-bucket/azure-600-gel-doc/{run_id}/{run_id}.png"


# ------------------------------------------------------------------
# Test 4b'': DishCam — both files present, encode MP4 + poster
# ------------------------------------------------------------------


class TestDishCamHappyPath:
    def test_run_json_encodes_sibling_tiff(
        self,
        integration_env: IntegrationEnv,
        make_s3_event: Callable[..., dict[str, Any]],
        s3_fixture_files: dict[str, Path],
        mock_context: MagicMock,
        mock_s3_upload: MagicMock,
    ) -> None:
        run_id = "dishcam-test_20260819_155803"
        tiff_name = "dishcam-test.tif"
        s3_fixture_files[f"dishcam/{run_id}/{tiff_name}"] = _FIXTURES_DIR / "dishcam_example.tif"
        s3_fixture_files[f"dishcam/{run_id}/run.json"] = _FIXTURES_DIR / "dishcam_run.json"

        event = make_s3_event("dishcam", run_id, "run.json")
        lambda_handler(event, mock_context)

        run = _api_get(
            integration_env.base_url,
            integration_env.api_token,
            f"/api/v1/instruments/dishcam/runs/{run_id}",
        )

        assert run["source"] == "lambda"
        assert run["metadata"]["frames"] == 4
        assert run["metadata"]["measured_fps"] == 0.95
        assert run["metadata"]["quality"] == "High"

        raw_tiff = next(f for f in run["files"] if f["filename"] == tiff_name)
        assert raw_tiff["status"] == "completed"

        processed = [f for f in run["files"] if f["category"] == "processed"]
        names = {f["filename"] for f in processed}
        assert names == {"dishcam-test.mp4", "dishcam-test.jpg"}

        uploaded = {call.args[1] for call in mock_s3_upload.call_args_list}
        assert f"s3://test-processed-bucket/dishcam/{run_id}/dishcam-test.mp4" in uploaded
        assert f"s3://test-processed-bucket/dishcam/{run_id}/dishcam-test.jpg" in uploaded

    def test_tiff_alone_does_not_create_a_run(
        self,
        integration_env: IntegrationEnv,
        make_s3_event: Callable[..., dict[str, Any]],
        s3_fixture_files: dict[str, Path],
        mock_context: MagicMock,
    ) -> None:
        run_id = "dishcam-tiff-only"
        s3_fixture_files[f"dishcam/{run_id}/stack.tif"] = _FIXTURES_DIR / "dishcam_example.tif"

        event = make_s3_event("dishcam", run_id, "stack.tif")
        lambda_handler(event, mock_context)

        resp = requests.get(
            f"{integration_env.base_url}/api/v1/instruments/dishcam/runs/{run_id}",
            headers={"Authorization": f"Bearer {integration_env.api_token}"},
            timeout=10,
        )
        assert resp.status_code == 404


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
        tmp_path: Path,
    ) -> None:
        # Create a CSV whose headers don't match the expected qPCR format.
        # The parser will fail, exercising the error-handling branch.
        bad_csv = tmp_path / "bad.csv"
        bad_csv.write_text("Wrong,Headers,Only\nA,B,C\n")

        run_id = "Experiment_20260201"
        filename = f"{run_id}_Cq Values.csv"
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
    ) -> None:
        run_id = "Experiment_20260301"
        filename = f"{run_id}_Cq Values.csv"
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
    ) -> None:
        """Firing the same S3 event twice must not create a duplicate file row.

        The create_file API is idempotent on s3_key (partial unique index with
        onConflictDoNothing). The second invocation reprocesses the existing
        file via completed → processing → completed.
        """
        run_id = "Experiment_20260301"
        filename = f"{run_id}_Cq Values.csv"
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
        tmp_path: Path,
    ) -> None:
        """A failed file can be reprocessed successfully on a retry.

        First invocation uses a malformed CSV → file ends in "failed" with an
        error_message. Second invocation swaps in the valid fixture → the
        file transitions failed → processing → completed with the error
        cleared.
        """
        run_id = "Experiment_20260301"
        filename = f"{run_id}_Cq Values.csv"
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

    def test_reprocess_does_not_duplicate_processed_csv(
        self,
        integration_env: IntegrationEnv,
        make_s3_event: Callable[..., dict[str, Any]],
        s3_fixture_files: dict[str, Path],
        mock_context: MagicMock,
        mock_s3_upload: MagicMock,
    ) -> None:
        """Reprocessing a plate reader file must not duplicate the CSV file record.

        The create_file API is idempotent on s3_key, so the second invocation
        returns the existing processed file rather than creating a duplicate.
        """
        run_id = "033126_CM_Od750"
        filename = f"{run_id}.xls"
        s3_key = f"spectramax-id3-plate-reader/{run_id}/{filename}"
        s3_fixture_files[s3_key] = _FIXTURES_DIR / "spectramax_plate_reader_endpoint.xls"

        event = make_s3_event("spectramax-id3-plate-reader", run_id, filename)
        lambda_handler(event, mock_context)
        lambda_handler(event, mock_context)

        run = _api_get(
            integration_env.base_url,
            integration_env.api_token,
            f"/api/v1/instruments/spectramax-id3-plate-reader/runs/{run_id}",
        )

        # Two files: one raw .xls and one processed CSV (not duplicated).
        assert len(run["files"]) == 2
        processed_files = [f for f in run["files"] if f["category"] == "processed"]
        assert len(processed_files) == 1
        assert processed_files[0]["filename"] == f"{run_id}_raw_well_data.csv"


# ------------------------------------------------------------------
# Test 4f: Function URL invocation
# ------------------------------------------------------------------


class TestFunctionUrlInvocation:
    """Tests for the Function URL invocation path.

    Inbound auth is enforced by AWS in front of the handler (the Function
    URL is configured with ``AuthType: AWS_IAM``), so these tests only
    exercise body parsing and the dispatch logic — they no longer check
    for a 401 response on missing/invalid bearer tokens.
    """

    def test_happy_path_processes_file(
        self,
        integration_env: IntegrationEnv,
        make_function_url_event: Callable[..., dict[str, Any]],
        s3_fixture_files: dict[str, Path],
        mock_context: MagicMock,
    ) -> None:
        """A Function URL event processes the file identically to a direct
        S3 trigger."""
        run_id = "Experiment_20260401"
        filename = f"{run_id}_Cq Values.csv"
        s3_key = f"azure-cielo-qpcr/{run_id}/{filename}"
        s3_fixture_files[s3_key] = _FIXTURES_DIR / "azure_cielo_qpcr_example.csv"

        event = make_function_url_event("azure-cielo-qpcr", run_id, filename)
        result = lambda_handler(event, mock_context)

        # Function URL invocations should not return an error response.
        assert result is None or result.get("statusCode", 200) == 200

        run = _api_get(
            integration_env.base_url,
            integration_env.api_token,
            f"/api/v1/instruments/azure-cielo-qpcr/runs/{run_id}",
        )
        assert run["run_id"] == run_id
        assert len(run["files"]) == 1
        assert run["files"][0]["status"] == "completed"

    def test_invalid_json_body_returns_400(
        self,
        make_function_url_event: Callable[..., dict[str, Any]],
        mock_context: MagicMock,
    ) -> None:
        """A Function URL event with a non-JSON body is rejected with 400
        (the handler cannot parse the inner S3 event payload)."""
        event = make_function_url_event(
            "azure-cielo-qpcr",
            "Experiment_20260401",
            "Experiment_20260401_Cq Values.csv",
            body_override="this is not json",
        )
        result = lambda_handler(event, mock_context)

        assert result == {"statusCode": 400, "body": "Invalid JSON body"}


# ------------------------------------------------------------------
# Least-privilege Lambda token (matches the curated Lambda scope preset)
# ------------------------------------------------------------------

# Keep in sync with the `lambda` entry in `web/lib/api/scope-catalog.ts`.
_LAMBDA_PRESET_SCOPES = [
    "instruments:read",
    "runs:create",
    "runs:update",
    "files:create",
    "files:update",
    "archive-jobs:write",
]


class TestLeastPrivilegeLambdaScopes:
    """A token minted with exactly the Lambda preset scopes can process a file.

    Catches scope-preset drift: if a new Lambda → API call needs a scope
    that isn't on the preset, this test fails instead of only surfacing
    in production against a freshly minted least-privilege token.
    """

    def test_preset_scopes_can_process_qpcr_file(
        self,
        integration_env: IntegrationEnv,
        make_s3_event: Callable[..., dict[str, Any]],
        s3_fixture_files: dict[str, Path],
        mock_context: MagicMock,
    ) -> None:
        import os

        import data_hub_lambda.api_client as api_module
        from data_hub_shared.testing import seed_auth

        scoped_token = seed_auth(integration_env.db_dsn, scopes=_LAMBDA_PRESET_SCOPES)
        previous_key = os.environ["DATA_HUB_API_KEY"]
        os.environ["DATA_HUB_API_KEY"] = scoped_token
        api_module._client = None

        try:
            run_id = "Experiment_20260501"
            filename = f"{run_id}_Cq Values.csv"
            s3_key = f"azure-cielo-qpcr/{run_id}/{filename}"
            s3_fixture_files[s3_key] = _FIXTURES_DIR / "azure_cielo_qpcr_example.csv"

            event = make_s3_event("azure-cielo-qpcr", run_id, filename)
            lambda_handler(event, mock_context)

            run = _api_get(
                integration_env.base_url,
                integration_env.api_token,
                f"/api/v1/instruments/azure-cielo-qpcr/runs/{run_id}",
            )
            assert run["run_id"] == run_id
            assert len(run["files"]) == 1
            assert run["files"][0]["status"] == "completed"
        finally:
            os.environ["DATA_HUB_API_KEY"] = previous_key
            api_module._client = None
