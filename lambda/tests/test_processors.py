"""Unit tests for the type → processor registry and filename gates."""

from __future__ import annotations
import re
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from data_hub_lambda.api_client import ApiError, DataHubClient, clear_instrument_cache
from data_hub_lambda.handler import lambda_handler
from data_hub_lambda.models import FileResponse, InstrumentResponse
from data_hub_lambda.processors import (
    PROCESSORS,
    get_processor,
    matches_any_processor_gate,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
PROCESSABLE_TYPES_TS = REPO_ROOT / "web" / "lib" / "instruments" / "processable-types.ts"


class TestFilenameGates:
    @pytest.mark.parametrize(
        ("instrument_type", "filename", "expected"),
        [
            ("qpcr", "Experiment_20260101_Cq Values.csv", True),
            ("qpcr", "Experiment_20260101_cq values.CSV", True),
            ("qpcr", "Experiment_20260101_CqValues.csv", False),
            ("qpcr", "Experiment_20260101_Amplification Results.csv", False),
            ("plate_reader", "plate.xls", True),
            ("plate_reader", "PLATE.XLS", True),
            ("plate_reader", "plate.xlsx", False),
            ("gel_doc", "gel.tif", True),
            ("gel_doc", "gel.tiff", True),
            ("gel_doc", "gel.TIF", True),
            ("gel_doc", "gel.png", False),
            ("tape_station", "report.pdf", True),
            ("tape_station", "peaks.csv", False),
            ("hina_microscope", "well.nd2", True),
            ("hina_microscope", "well.tif", False),
            ("epson_v700_scanner", "scan.tif", True),
            ("epson_v700_scanner", "scan.tiff", True),
            ("epson_v700_scanner", "scan.jpg", False),
            ("fplc", "chromatogram.pdf", True),
            ("fplc", "notes.txt", False),
        ],
    )
    def test_per_type_gate(self, instrument_type: str, filename: str, expected: bool) -> None:
        entry = PROCESSORS[instrument_type]
        assert entry.matches_filename(filename) is expected

    def test_union_gate_matches_any_processor(self) -> None:
        assert matches_any_processor_gate("Experiment_Cq Values.csv")
        assert matches_any_processor_gate("scan.TIFF")
        assert matches_any_processor_gate("well.nd2")
        assert not matches_any_processor_gate("readme.txt")
        assert not matches_any_processor_gate("notes.md")

    def test_unmapped_types_have_no_entry(self) -> None:
        assert get_processor("generic") is None
        assert get_processor("instant_raman") is None
        assert get_processor("unknown_type") is None

    def test_processable_types_match_web_allowlist(self) -> None:
        """Python registry keys must match PROCESSABLE_INSTRUMENT_TYPES."""
        text = PROCESSABLE_TYPES_TS.read_text()
        match = re.search(
            r"PROCESSABLE_INSTRUMENT_TYPES\s*=\s*\[(.*?)]\s*as const",
            text,
            re.DOTALL,
        )
        assert match is not None, "Could not find PROCESSABLE_INSTRUMENT_TYPES in TS"
        ts_types = set(re.findall(r'"([^"]+)"', match.group(1)))
        assert ts_types == set(PROCESSORS)


class TestInstrumentCache:
    def setup_method(self) -> None:
        clear_instrument_cache()

    def teardown_method(self) -> None:
        clear_instrument_cache()

    def test_get_instrument_caches_successful_lookup(self) -> None:
        client = DataHubClient(base_url="https://example.test/api/v1")
        payload = {
            "id": "azure-cielo-qpcr",
            "display_name": "Azure Cielo qPCR",
            "status": "active",
            "instrument_type": "qpcr",
        }
        resp = MagicMock()
        resp.json.return_value = payload
        with patch.object(client, "_request", return_value=resp) as request:
            first = client.get_instrument("azure-cielo-qpcr")
            second = client.get_instrument("azure-cielo-qpcr")

        assert first.instrument_type == "qpcr"
        assert second is first
        request.assert_called_once_with("GET", "/instruments/azure-cielo-qpcr")

    def test_get_instrument_does_not_cache_errors(self) -> None:
        client = DataHubClient(base_url="https://example.test/api/v1")
        with patch.object(
            client,
            "_request",
            side_effect=ApiError("not found", status_code=404),
        ) as request:
            with pytest.raises(ApiError):
                client.get_instrument("missing")
            with pytest.raises(ApiError):
                client.get_instrument("missing")

        assert request.call_count == 2


class TestHandlerDispatch:
    """Dispatch paths that used to be ID if/elif branches."""

    def _s3_event(self, instrument_id: str, run_id: str, filename: str) -> dict:
        from urllib.parse import quote_plus

        key = quote_plus(f"{instrument_id}/{run_id}/{filename}", safe="/")
        return {
            "Records": [
                {
                    "s3": {
                        "bucket": {"name": "test-bucket"},
                        "object": {"key": key},
                    }
                }
            ]
        }

    def _function_url_event(self, instrument_id: str, run_id: str, filename: str) -> dict:
        import json

        return {
            "version": "2.0",
            "requestContext": {"http": {"method": "POST", "path": "/"}},
            "body": json.dumps(self._s3_event(instrument_id, run_id, filename)),
            "isBase64Encoded": False,
        }

    def _file_response(self, file_id: int = 42) -> FileResponse:
        return FileResponse(
            id=file_id,
            instrument_run_id="run-uuid",
            filename="file.csv",
            category="raw",
            status="processing",
        )

    def test_union_gate_short_circuits_without_api_call(self) -> None:
        client = MagicMock()
        with (
            patch("data_hub_lambda.handler.get_client", return_value=client),
            patch("data_hub_lambda.handler._cleanup_tmp"),
        ):
            result = lambda_handler(
                self._s3_event("azure-cielo-qpcr", "run-1", "readme.txt"),
                MagicMock(),
            )

        assert result is None
        client.get_instrument.assert_not_called()

    def test_unmapped_type_is_noop_on_s3(self) -> None:
        client = MagicMock()
        client.get_instrument.return_value = InstrumentResponse(
            id="instantraman",
            display_name="InstantRaman",
            status="active",
            instrument_type="instant_raman",
        )
        with (
            patch("data_hub_lambda.handler.get_client", return_value=client),
            patch("data_hub_lambda.handler._cleanup_tmp"),
        ):
            result = lambda_handler(
                self._s3_event("instantraman", "run-1", "scan.tif"),
                MagicMock(),
            )

        assert result is None
        client.get_instrument.assert_called_once_with("instantraman")
        client.create_file.assert_not_called()

    def test_generic_type_is_noop_on_s3(self) -> None:
        client = MagicMock()
        client.get_instrument.return_value = InstrumentResponse(
            id="jolene-fplc",
            display_name="Jolene FPLC",
            status="active",
            instrument_type="generic",
        )
        with (
            patch("data_hub_lambda.handler.get_client", return_value=client),
            patch("data_hub_lambda.handler._cleanup_tmp"),
        ):
            result = lambda_handler(
                self._s3_event("jolene-fplc", "run-1", "chromatogram.pdf"),
                MagicMock(),
            )

        assert result is None
        client.create_file.assert_not_called()

    def test_404_is_noop_on_s3(self) -> None:
        client = MagicMock()
        client.get_instrument.side_effect = ApiError("not found", status_code=404)
        with (
            patch("data_hub_lambda.handler.get_client", return_value=client),
            patch("data_hub_lambda.handler._cleanup_tmp"),
        ):
            result = lambda_handler(
                self._s3_event("missing-instrument", "run-1", "scan.tif"),
                MagicMock(),
            )

        assert result is None
        client.create_file.assert_not_called()

    def test_reprocess_marks_failed_when_type_unmapped(self) -> None:
        client = MagicMock()
        client.get_instrument.return_value = InstrumentResponse(
            id="instantraman",
            display_name="InstantRaman",
            status="active",
            instrument_type="instant_raman",
        )
        client.create_file.return_value = self._file_response(7)
        with (
            patch("data_hub_lambda.handler.get_client", return_value=client),
            patch("data_hub_lambda.handler._cleanup_tmp"),
            patch(
                "data_hub_shared.config.config.AWS_S3_RAW_DATA_BUCKET",
                "test-bucket",
            ),
        ):
            result = lambda_handler(
                self._function_url_event("instantraman", "run-1", "scan.tif"),
                MagicMock(),
            )

        assert result is None
        client.create_file.assert_called_once()
        client.update_file.assert_called_once_with(
            7,
            status="failed",
            error_message="No Lambda processor for instrument_type='instant_raman'",
        )

    def test_reprocess_marks_failed_on_instrument_404(self) -> None:
        client = MagicMock()
        client.get_instrument.side_effect = ApiError("not found", status_code=404)
        client.create_file.return_value = self._file_response(9)
        with (
            patch("data_hub_lambda.handler.get_client", return_value=client),
            patch("data_hub_lambda.handler._cleanup_tmp"),
            patch(
                "data_hub_shared.config.config.AWS_S3_RAW_DATA_BUCKET",
                "test-bucket",
            ),
        ):
            result = lambda_handler(
                self._function_url_event("missing-instrument", "run-1", "scan.tif"),
                MagicMock(),
            )

        assert result is None
        client.update_file.assert_called_once_with(
            9,
            status="failed",
            error_message="Instrument 'missing-instrument' not found",
        )

    def test_403_raises(self) -> None:
        client = MagicMock()
        client.get_instrument.side_effect = ApiError("forbidden", status_code=403)
        with (
            patch("data_hub_lambda.handler.get_client", return_value=client),
            patch("data_hub_lambda.handler._cleanup_tmp"),
            pytest.raises(ApiError) as exc_info,
        ):
            lambda_handler(
                self._s3_event("azure-cielo-qpcr", "run-1", "x_Cq Values.csv"),
                MagicMock(),
            )

        assert exc_info.value.status_code == 403

    def test_reprocess_bypasses_filename_gate(self) -> None:
        client = MagicMock()
        client.get_instrument.return_value = InstrumentResponse(
            id="azure-cielo-qpcr",
            display_name="Azure Cielo qPCR",
            status="active",
            instrument_type="qpcr",
        )
        process_file = MagicMock()
        entry = MagicMock()
        entry.matches_filename.return_value = False
        entry.process_file = process_file

        with (
            patch("data_hub_lambda.handler.get_client", return_value=client),
            patch("data_hub_lambda.handler._cleanup_tmp"),
            patch(
                "data_hub_lambda.handler.get_processor",
                return_value=entry,
            ),
            # Union gate would also block S3 events; reprocess must skip it.
            patch(
                "data_hub_lambda.handler.matches_any_processor_gate",
                return_value=False,
            ),
        ):
            result = lambda_handler(
                self._function_url_event(
                    "azure-cielo-qpcr",
                    "run-1",
                    "Experiment_Amplification Results.csv",
                ),
                MagicMock(),
            )

        assert result is None
        process_file.assert_called_once_with(
            "azure-cielo-qpcr",
            "run-1",
            "Experiment_Amplification Results.csv",
        )

    def test_s3_event_applies_per_type_gate(self) -> None:
        client = MagicMock()
        client.get_instrument.return_value = InstrumentResponse(
            id="azure-cielo-qpcr",
            display_name="Azure Cielo qPCR",
            status="active",
            instrument_type="qpcr",
        )
        process_file = MagicMock()
        entry = MagicMock()
        entry.matches_filename.return_value = False
        entry.process_file = process_file

        with (
            patch("data_hub_lambda.handler.get_client", return_value=client),
            patch("data_hub_lambda.handler._cleanup_tmp"),
            patch("data_hub_lambda.handler.get_processor", return_value=entry),
            # Pass the union gate (e.g. a .pdf that belongs to another type).
            patch(
                "data_hub_lambda.handler.matches_any_processor_gate",
                return_value=True,
            ),
        ):
            result = lambda_handler(
                self._s3_event("azure-cielo-qpcr", "run-1", "notes.pdf"),
                MagicMock(),
            )

        assert result is None
        process_file.assert_not_called()
