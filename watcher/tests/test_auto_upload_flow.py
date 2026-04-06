"""Integration tests: auto-upload flow.

Mirrors the full lifecycle of a watcher in auto-upload mode on a real
instrument:

    register -> heartbeat("watching") -> report_run (1 file)
      -> update_run (add 2nd file) -> mark_file_uploaded
      -> verify upload queue state -> heartbeat("stopped")
"""

from __future__ import annotations

import pytest

from data_hub_shared.testing import IntegrationEnv, db_query
from data_hub_watcher.api_client import DataHubClient

pytestmark = pytest.mark.integration


def _register_and_report(
    client: DataHubClient,
    instrument_id: str,
    *,
    run_id: str = "EXP-001",
    files: list[dict[str, str]] | None = None,
) -> tuple[str, str]:
    """Register a watcher and report a run. Returns (watcher_id, run_id)."""
    watcher = client.register_watcher(instrument_id, hostname="LAB-PC-01")
    detected = files or [{"filename": "data_001.csv", "relative_path": "EXP-001/data_001.csv"}]
    client.report_run(
        instrument_id,
        {
            "run_id": run_id,
            "source": "watcher",
            "watcher_id": watcher.watcher_id,
            "detected_files": detected,
        },
    )
    return watcher.watcher_id, run_id


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
# report_run
# ------------------------------------------------------------------


class TestReportRun:
    def test_report_run_creates_run_with_source_watcher(
        self,
        client: DataHubClient,
        instrument_id: str,
        integration_env: IntegrationEnv,
    ) -> None:
        watcher = client.register_watcher(instrument_id)
        result = client.report_run(
            instrument_id,
            {
                "run_id": "EXP-001",
                "source": "watcher",
                "watcher_id": watcher.watcher_id,
                "detected_files": [
                    {"filename": "data_001.csv", "relative_path": "EXP-001/data_001.csv"},
                ],
            },
        )
        assert result.source == "watcher"
        assert result.run_id == "EXP-001"

        rows = db_query(
            integration_env.db_dsn,
            "SELECT source, watcher_id FROM instrument_runs WHERE run_id = %s",
            ("EXP-001",),
        )
        assert rows[0][0] == "watcher"
        assert rows[0][1] == watcher.watcher_id

    def test_report_run_creates_detected_files(
        self,
        client: DataHubClient,
        instrument_id: str,
        integration_env: IntegrationEnv,
    ) -> None:
        _register_and_report(client, instrument_id)

        rows = db_query(
            integration_env.db_dsn,
            """SELECT f.status, f.detected_at FROM files f
               JOIN instrument_runs r ON f.instrument_run_id = r.id
               WHERE r.run_id = 'EXP-001'""",
        )
        assert len(rows) == 1
        assert rows[0][0] == "detected"
        assert rows[0][1] is not None

    def test_report_run_idempotent(
        self,
        client: DataHubClient,
        instrument_id: str,
        integration_env: IntegrationEnv,
    ) -> None:
        watcher = client.register_watcher(instrument_id)
        run_data = {
            "run_id": "EXP-001",
            "source": "watcher",
            "watcher_id": watcher.watcher_id,
            "detected_files": [
                {"filename": "data.csv", "relative_path": "EXP-001/data.csv"},
            ],
        }
        r1 = client.report_run(instrument_id, run_data)
        r2 = client.report_run(instrument_id, run_data)
        assert r1.id == r2.id

        rows = db_query(
            integration_env.db_dsn,
            "SELECT count(*) FROM instrument_runs WHERE run_id = 'EXP-001'",
        )
        assert rows[0][0] == 1

    def test_report_run_idempotent_does_not_duplicate_files(
        self,
        client: DataHubClient,
        instrument_id: str,
        integration_env: IntegrationEnv,
    ) -> None:
        watcher = client.register_watcher(instrument_id)
        run_data = {
            "run_id": "EXP-001",
            "source": "watcher",
            "watcher_id": watcher.watcher_id,
            "detected_files": [
                {"filename": "data.csv", "relative_path": "EXP-001/data.csv"},
            ],
        }
        client.report_run(instrument_id, run_data)
        client.report_run(instrument_id, run_data)

        rows = db_query(
            integration_env.db_dsn,
            """SELECT count(*) FROM files f
               JOIN instrument_runs r ON f.instrument_run_id = r.id
               WHERE r.run_id = 'EXP-001'""",
        )
        assert rows[0][0] == 1


# ------------------------------------------------------------------
# update_run
# ------------------------------------------------------------------


class TestUpdateRun:
    def test_update_run_adds_new_file(
        self,
        client: DataHubClient,
        instrument_id: str,
        integration_env: IntegrationEnv,
    ) -> None:
        watcher_id, run_id = _register_and_report(
            client,
            instrument_id,
            files=[{"filename": "file_a.csv", "relative_path": "EXP-001/file_a.csv"}],
        )
        client.update_run(
            instrument_id,
            run_id,
            {
                "detected_files": [
                    {"filename": "file_a.csv", "relative_path": "EXP-001/file_a.csv"},
                    {"filename": "file_b.csv", "relative_path": "EXP-001/file_b.csv"},
                ],
            },
        )

        rows = db_query(
            integration_env.db_dsn,
            """SELECT f.filename FROM files f
               JOIN instrument_runs r ON f.instrument_run_id = r.id
               WHERE r.run_id = %s ORDER BY f.filename""",
            (run_id,),
        )
        assert [r[0] for r in rows] == ["file_a.csv", "file_b.csv"]

    def test_update_run_returns_run_detail(self, client: DataHubClient, instrument_id: str) -> None:
        watcher_id, run_id = _register_and_report(client, instrument_id)
        detail = client.update_run(instrument_id, run_id, {"detected_files": []})
        assert detail.source == "watcher"
        assert detail.watcher_id == watcher_id
        assert detail.instrument_display_name == "Contract Test Instrument"


# ------------------------------------------------------------------
# mark_file_uploaded
# ------------------------------------------------------------------


class TestMarkFileUploaded:
    def test_mark_file_uploaded_transitions_detected_to_uploaded(
        self,
        client: DataHubClient,
        instrument_id: str,
        integration_env: IntegrationEnv,
    ) -> None:
        _register_and_report(client, instrument_id)
        file_id = _get_file_id(integration_env.db_dsn, "EXP-001", "data_001.csv")

        result = client.mark_file_uploaded(
            file_id,
            {
                "s3_bucket": "test-bucket",
                "s3_key": f"{instrument_id}/EXP-001/data_001.csv",
                "content_type": "text/csv",
                "status": "uploaded",
            },
        )
        assert result.status == "uploaded"
        assert result.s3_bucket == "test-bucket"
        assert result.s3_key == f"{instrument_id}/EXP-001/data_001.csv"
        assert result.content_type == "text/csv"
        assert result.uploaded_at is not None


# ------------------------------------------------------------------
# Full end-to-end lifecycle
# ------------------------------------------------------------------


class TestFullAutoModeLifecycle:
    def test_full_auto_mode_lifecycle(
        self,
        client: DataHubClient,
        instrument_id: str,
        integration_env: IntegrationEnv,
    ) -> None:
        # 1. Register
        watcher = client.register_watcher(instrument_id, hostname="LAB-PC-01")
        wid = watcher.watcher_id

        # 2. Heartbeat -> watching
        hb = client.send_heartbeat(wid, {"status": "watching"})
        assert hb.ok is True

        # 3. Report run with one file
        client.report_run(
            instrument_id,
            {
                "run_id": "LIFECYCLE-001",
                "source": "watcher",
                "watcher_id": wid,
                "detected_files": [
                    {"filename": "raw.csv", "relative_path": "LIFECYCLE-001/raw.csv"},
                ],
            },
        )

        # 4. Get file ID from DB and mark uploaded
        file_id = _get_file_id(integration_env.db_dsn, "LIFECYCLE-001", "raw.csv")
        uploaded = client.mark_file_uploaded(
            file_id,
            {
                "s3_bucket": "test-bucket",
                "s3_key": f"{instrument_id}/LIFECYCLE-001/raw.csv",
                "content_type": "text/csv",
                "status": "uploaded",
            },
        )
        assert uploaded.status == "uploaded"

        # 5. Heartbeat -> stopped
        client.send_heartbeat(wid, {"status": "stopped"})

        # 6. Verify final watcher status
        rows = db_query(
            integration_env.db_dsn,
            "SELECT status FROM watchers WHERE id = %s",
            (wid,),
        )
        assert rows[0][0] == "stopped"
