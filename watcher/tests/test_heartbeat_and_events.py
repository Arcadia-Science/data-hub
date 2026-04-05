"""Integration tests: heartbeat status transitions and event reporting.

Tests the watcher's ongoing lifecycle — heartbeat-driven status transitions
(registered -> watching -> stopped), counter persistence, and event batches.
"""

from __future__ import annotations

import pytest

from data_hub_shared.testing import IntegrationEnv, db_query, db_update
from data_hub_watcher.api_client import ApiError, DataHubClient

pytestmark = pytest.mark.integration


# ------------------------------------------------------------------
# Heartbeat
# ------------------------------------------------------------------


class TestHeartbeat:
    def test_heartbeat_returns_ok(self, client: DataHubClient, instrument_id: str) -> None:
        watcher = client.register_watcher(instrument_id)
        result = client.send_heartbeat(watcher.watcher_id, {"status": "watching"})
        assert result.ok is True

    def test_heartbeat_transitions_status_to_watching(
        self,
        client: DataHubClient,
        instrument_id: str,
        integration_env: IntegrationEnv,
    ) -> None:
        watcher = client.register_watcher(instrument_id)
        client.send_heartbeat(watcher.watcher_id, {"status": "watching"})

        rows = db_query(
            integration_env.db_dsn,
            "SELECT status, last_heartbeat_at FROM watchers WHERE id = %s",
            (watcher.watcher_id,),
        )
        assert rows[0][0] == "watching"
        assert rows[0][1] is not None

    def test_heartbeat_with_counters_persisted(
        self,
        client: DataHubClient,
        instrument_id: str,
        integration_env: IntegrationEnv,
    ) -> None:
        watcher = client.register_watcher(instrument_id)
        client.send_heartbeat(
            watcher.watcher_id,
            {
                "status": "watching",
                "files_uploaded_since_last_heartbeat": 3,
                "runs_reported_since_last_heartbeat": 1,
                "errors_since_last_heartbeat": 0,
                "uptime_seconds": 120,
                "upload_mode": "auto",
            },
        )

        rows = db_query(
            integration_env.db_dsn,
            """SELECT files_uploaded_since_last_heartbeat,
                      runs_reported_since_last_heartbeat,
                      errors_since_last_heartbeat,
                      uptime_seconds,
                      upload_mode
               FROM watcher_heartbeats
               WHERE watcher_id = %s""",
            (watcher.watcher_id,),
        )
        assert len(rows) == 1
        assert rows[0] == (3, 1, 0, 120, "auto")

    def test_heartbeat_stopped_updates_status(
        self,
        client: DataHubClient,
        instrument_id: str,
        integration_env: IntegrationEnv,
    ) -> None:
        watcher = client.register_watcher(instrument_id)
        client.send_heartbeat(watcher.watcher_id, {"status": "watching"})
        client.send_heartbeat(watcher.watcher_id, {"status": "stopped"})

        rows = db_query(
            integration_env.db_dsn,
            "SELECT status FROM watchers WHERE id = %s",
            (watcher.watcher_id,),
        )
        assert rows[0][0] == "stopped"

    def test_heartbeat_deleted_watcher_404(
        self,
        client: DataHubClient,
        instrument_id: str,
        integration_env: IntegrationEnv,
    ) -> None:
        watcher = client.register_watcher(instrument_id)
        db_update(
            integration_env.db_dsn,
            "UPDATE watchers SET deleted_at = NOW() WHERE id = %s",
            (watcher.watcher_id,),
        )
        with pytest.raises(ApiError) as exc_info:
            client.send_heartbeat(watcher.watcher_id, {"status": "watching"})
        assert exc_info.value.status_code == 404


# ------------------------------------------------------------------
# Events
# ------------------------------------------------------------------


class TestEvents:
    def test_send_events_batch(
        self,
        client: DataHubClient,
        instrument_id: str,
        integration_env: IntegrationEnv,
    ) -> None:
        watcher = client.register_watcher(instrument_id)
        result = client.send_events(
            watcher.watcher_id,
            [
                {"event_type": "watcher_started", "message": "Watcher started on LAB-PC-01"},
                {"event_type": "run_detected", "message": "Detected run EXP-001"},
            ],
        )
        assert result.received == 2

        rows = db_query(
            integration_env.db_dsn,
            "SELECT event_type, message FROM watcher_events"
            " WHERE watcher_id = %s ORDER BY created_at",
            (watcher.watcher_id,),
        )
        assert len(rows) == 2
        assert rows[0][0] == "watcher_started"
        assert rows[1][0] == "run_detected"

    def test_send_events_watcher_started_and_stopped(
        self,
        client: DataHubClient,
        instrument_id: str,
        integration_env: IntegrationEnv,
    ) -> None:
        watcher = client.register_watcher(instrument_id)
        client.send_events(
            watcher.watcher_id,
            [{"event_type": "watcher_started", "message": "Started"}],
        )
        client.send_events(
            watcher.watcher_id,
            [{"event_type": "watcher_stopped", "message": "Stopped"}],
        )

        rows = db_query(
            integration_env.db_dsn,
            "SELECT event_type FROM watcher_events WHERE watcher_id = %s ORDER BY created_at",
            (watcher.watcher_id,),
        )
        assert [r[0] for r in rows] == ["watcher_started", "watcher_stopped"]

    def test_send_events_invalid_type_400(self, client: DataHubClient, instrument_id: str) -> None:
        watcher = client.register_watcher(instrument_id)
        with pytest.raises(ApiError) as exc_info:
            client.send_events(
                watcher.watcher_id,
                [{"event_type": "bogus", "message": "bad event"}],
            )
        assert exc_info.value.status_code == 400

    def test_send_events_empty_list_400(self, client: DataHubClient, instrument_id: str) -> None:
        watcher = client.register_watcher(instrument_id)
        with pytest.raises(ApiError) as exc_info:
            client.send_events(watcher.watcher_id, [])
        assert exc_info.value.status_code == 400
