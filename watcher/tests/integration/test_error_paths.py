"""Integration tests: consolidated error paths.

Boundary conditions and edge cases — 404s, 400s, 409s across every major
endpoint to verify the API returns proper error codes.
"""

from __future__ import annotations

import pytest

from data_hub_shared.testing import IntegrationEnv, db_query, db_update
from data_hub_watcher.api_client import ApiError, DataHubClient

pytestmark = pytest.mark.integration


def _get_file_id(dsn: str, run_id: str, filename: str) -> int:
    rows = db_query(
        dsn,
        """SELECT f.id FROM files f
           JOIN instrument_runs r ON f.instrument_run_id = r.id
           WHERE r.run_id = %s AND f.filename = %s""",
        (run_id, filename),
    )
    assert rows, f"No file found for run={run_id}, filename={filename}"
    file_id = rows[0][0]
    assert isinstance(file_id, int)
    return file_id


# ------------------------------------------------------------------
# 404s
# ------------------------------------------------------------------


class TestNotFound:
    def test_register_unknown_instrument_404(self, client: DataHubClient) -> None:
        with pytest.raises(ApiError) as exc_info:
            client.register_watcher("nonexistent-instrument")
        assert exc_info.value.status_code == 404

    def test_mark_uploaded_nonexistent_file_404(self, client: DataHubClient) -> None:
        with pytest.raises(ApiError) as exc_info:
            client.mark_file_uploaded(
                99999,
                {
                    "content_type": "text/csv",
                    "status": "uploaded",
                },
            )
        assert exc_info.value.status_code == 404


# ------------------------------------------------------------------
# 400s
# ------------------------------------------------------------------


class TestBadRequest:
    def test_heartbeat_invalid_status_400(self, client: DataHubClient, instrument_id: str) -> None:
        watcher = client.register_watcher(instrument_id)
        with pytest.raises(ApiError) as exc_info:
            client.send_heartbeat(watcher.watcher_id, {"status": "bogus"})
        assert exc_info.value.status_code == 400

    def test_events_invalid_event_type_400(self, client: DataHubClient, instrument_id: str) -> None:
        watcher = client.register_watcher(instrument_id)
        with pytest.raises(ApiError) as exc_info:
            client.send_events(
                watcher.watcher_id,
                [{"event_type": "not_real", "message": "nope"}],
            )
        assert exc_info.value.status_code == 400

    def test_report_run_empty_run_id_400(self, client: DataHubClient, instrument_id: str) -> None:
        watcher = client.register_watcher(instrument_id)
        with pytest.raises(ApiError) as exc_info:
            client.report_run(
                instrument_id,
                {
                    "run_id": "",
                    "source": "watcher",
                    "watcher_id": watcher.watcher_id,
                    "detected_files": [],
                },
            )
        assert exc_info.value.status_code == 400

    def test_report_run_invalid_source_400(self, client: DataHubClient, instrument_id: str) -> None:
        watcher = client.register_watcher(instrument_id)
        with pytest.raises(ApiError) as exc_info:
            client.report_run(
                instrument_id,
                {
                    "run_id": "EXP-001",
                    "source": "invalid",
                    "watcher_id": watcher.watcher_id,
                    "detected_files": [],
                },
            )
        assert exc_info.value.status_code == 400

    def test_report_run_invalid_watcher_id_400(
        self, client: DataHubClient, instrument_id: str
    ) -> None:
        with pytest.raises(ApiError) as exc_info:
            client.report_run(
                instrument_id,
                {
                    "run_id": "EXP-001",
                    "source": "watcher",
                    "watcher_id": "00000000-0000-0000-0000-000000000000",
                    "detected_files": [],
                },
            )
        assert exc_info.value.status_code == 400


# ------------------------------------------------------------------
# 409s
# ------------------------------------------------------------------


class TestConflict:
    def test_mark_uploaded_invalid_transition_409(
        self,
        client: DataHubClient,
        instrument_id: str,
        integration_env: IntegrationEnv,
    ) -> None:
        watcher = client.register_watcher(instrument_id)
        client.report_run(
            instrument_id,
            {
                "run_id": "EXP-CONFLICT",
                "source": "watcher",
                "watcher_id": watcher.watcher_id,
                "detected_files": [
                    {"filename": "f.csv", "relative_path": "EXP-CONFLICT/f.csv"},
                ],
            },
        )
        file_id = _get_file_id(integration_env.db_dsn, "EXP-CONFLICT", "f.csv")

        updates = {
            "content_type": "text/csv",
            "status": "uploaded",
        }
        client.mark_file_uploaded(file_id, updates)

        with pytest.raises(ApiError) as exc_info:
            client.mark_file_uploaded(file_id, updates)
        assert exc_info.value.status_code == 409

    def test_update_deleted_run_409(
        self,
        client: DataHubClient,
        instrument_id: str,
        integration_env: IntegrationEnv,
    ) -> None:
        watcher = client.register_watcher(instrument_id)
        client.report_run(
            instrument_id,
            {
                "run_id": "EXP-DELETE",
                "source": "watcher",
                "watcher_id": watcher.watcher_id,
                "detected_files": [],
            },
        )

        db_update(
            integration_env.db_dsn,
            "UPDATE instrument_runs SET deleted_at = NOW() WHERE run_id = %s",
            ("EXP-DELETE",),
        )

        with pytest.raises(ApiError) as exc_info:
            client.update_run(
                instrument_id,
                "EXP-DELETE",
                {"detected_files": []},
            )
        assert exc_info.value.status_code == 409
