"""Integration tests: manual-upload flow.

Mirrors the manual-upload mode where scientists review files before
uploading:

    report_run (files detected) -> admin sets upload_requested_at (via DB)
      -> poll upload queue -> mark_file_uploaded -> poll again (empty)
"""

from __future__ import annotations

import pytest

from data_hub_shared.testing import IntegrationEnv, db_query, db_update
from data_hub_watcher.api_client import DataHubClient

pytestmark = pytest.mark.integration


def _setup_run_with_file(
    client: DataHubClient,
    instrument_id: str,
    *,
    run_id: str = "MANUAL-001",
    filename: str = "data.csv",
) -> str:
    """Register watcher, report run with one file, return watcher_id."""
    watcher = client.register_watcher(instrument_id)
    client.report_run(
        instrument_id,
        {
            "run_id": run_id,
            "source": "watcher",
            "watcher_id": watcher.watcher_id,
            "detected_files": [
                {"filename": filename, "relative_path": f"{run_id}/{filename}"},
            ],
        },
    )
    return watcher.watcher_id


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


class TestManualUploadQueue:
    def test_detected_files_not_in_upload_queue(
        self, client: DataHubClient, instrument_id: str
    ) -> None:
        watcher_id = _setup_run_with_file(client, instrument_id)
        queue = client.get_upload_queue(watcher_id)
        assert queue.files == []

    def test_upload_requested_file_appears_in_queue(
        self,
        client: DataHubClient,
        instrument_id: str,
        integration_env: IntegrationEnv,
    ) -> None:
        watcher_id = _setup_run_with_file(client, instrument_id)
        file_id = _get_file_id(integration_env.db_dsn, "MANUAL-001", "data.csv")

        db_update(
            integration_env.db_dsn,
            "UPDATE files SET upload_requested_at = NOW(),"
            " status = 'upload_requested' WHERE id = %s",
            (file_id,),
        )

        queue = client.get_upload_queue(watcher_id)
        assert len(queue.files) == 1
        f = queue.files[0]
        assert f.id == file_id
        assert f.instrument_id == instrument_id
        assert f.run_id == "MANUAL-001"
        assert f.filename == "data.csv"

    def test_uploaded_file_leaves_queue(
        self,
        client: DataHubClient,
        instrument_id: str,
        integration_env: IntegrationEnv,
    ) -> None:
        watcher_id = _setup_run_with_file(client, instrument_id)
        file_id = _get_file_id(integration_env.db_dsn, "MANUAL-001", "data.csv")

        db_update(
            integration_env.db_dsn,
            "UPDATE files SET upload_requested_at = NOW(),"
            " status = 'upload_requested' WHERE id = %s",
            (file_id,),
        )

        client.mark_file_uploaded(
            file_id,
            {
                "s3_bucket": "test-bucket",
                "s3_key": f"{instrument_id}/MANUAL-001/data.csv",
                "content_type": "text/csv",
                "status": "uploaded",
            },
        )

        queue = client.get_upload_queue(watcher_id)
        assert queue.files == []

    def test_queue_excludes_deleted_files(
        self,
        client: DataHubClient,
        instrument_id: str,
        integration_env: IntegrationEnv,
    ) -> None:
        watcher_id = _setup_run_with_file(client, instrument_id)
        file_id = _get_file_id(integration_env.db_dsn, "MANUAL-001", "data.csv")

        db_update(
            integration_env.db_dsn,
            "UPDATE files SET upload_requested_at = NOW(),"
            " status = 'upload_requested' WHERE id = %s",
            (file_id,),
        )
        db_update(
            integration_env.db_dsn,
            "UPDATE files SET deleted_at = NOW() WHERE id = %s",
            (file_id,),
        )

        queue = client.get_upload_queue(watcher_id)
        assert queue.files == []

    def test_queue_scoped_to_watcher_instrument(
        self,
        client: DataHubClient,
        instrument_id: str,
        integration_env: IntegrationEnv,
    ) -> None:
        other_inst = "other-manual-instrument"
        client.create_instrument(other_inst, display_name="Other Instrument")

        watcher_a = _setup_run_with_file(client, instrument_id, run_id="RUN-A", filename="a.csv")
        watcher_b = _setup_run_with_file(client, other_inst, run_id="RUN-B", filename="b.csv")

        file_a = _get_file_id(integration_env.db_dsn, "RUN-A", "a.csv")
        file_b = _get_file_id(integration_env.db_dsn, "RUN-B", "b.csv")

        for fid in (file_a, file_b):
            db_update(
                integration_env.db_dsn,
                "UPDATE files SET upload_requested_at = NOW(), status = 'upload_requested'"
                " WHERE id = %s",
                (fid,),
            )

        queue_a = client.get_upload_queue(watcher_a)
        queue_b = client.get_upload_queue(watcher_b)

        assert {f.filename for f in queue_a.files} == {"a.csv"}
        assert {f.filename for f in queue_b.files} == {"b.csv"}
