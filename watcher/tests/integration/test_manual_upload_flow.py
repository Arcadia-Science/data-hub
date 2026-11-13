"""Integration tests: manual-upload flow.

Mirrors the manual-upload mode where scientists review files before
uploading:

    report_run (files detected) -> admin sets upload_requested_at (via DB)
      -> poll upload queue -> mark_file_uploaded -> poll again (empty)
"""

from __future__ import annotations
import time
from typing import Any
from unittest.mock import MagicMock

import pytest

from data_hub_shared.testing import IntegrationEnv, db_query, db_update
from data_hub_watcher.api_client import DataHubClient
from data_hub_watcher.constants import AUTO_UPDATE_STATUS_REASON, SYSTEM_SHUTDOWN_STATUS_REASON
from data_hub_watcher.heartbeat import HeartbeatLoop

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


class TestStopWithRequestedUploads:
    """What the server does with queued upload requests when the watcher stops.

    A stop caused by Windows shutting down or restarting, or by the watcher installing an
    update, keeps them queued, so the watcher uploads them after it starts again. Any other
    stop cancels them.
    This runs the watcher's own final heartbeat against the real server, so the
    reason the watcher sends and the one the server expects can't drift apart.
    """

    @staticmethod
    def _stop_the_watcher(client: DataHubClient, watcher_id: str, **stop_kwargs: Any) -> None:
        loop = HeartbeatLoop(
            client=client,
            watcher_id=watcher_id,
            interval_seconds=60,
            event_reporter=MagicMock(),
            instrument_id="watcher-contract-test",
            watch_directory="/tmp/watch",
            upload_mode="manual",
        )
        loop.stop(**stop_kwargs)

    @staticmethod
    def _request_the_upload(
        client: DataHubClient, integration_env: IntegrationEnv
    ) -> tuple[str, int]:
        watcher_id = _setup_run_with_file(client, "watcher-contract-test")
        file_id = _get_file_id(integration_env.db_dsn, "MANUAL-001", "data.csv")
        db_update(
            integration_env.db_dsn,
            "UPDATE files SET upload_requested_at = NOW(),"
            " status = 'upload_requested' WHERE id = %s",
            (file_id,),
        )
        return watcher_id, file_id

    @staticmethod
    def _file_status(integration_env: IntegrationEnv, file_id: int) -> str:
        rows = db_query(
            integration_env.db_dsn, "SELECT status FROM files WHERE id = %s", (file_id,)
        )
        return str(rows[0][0])

    def test_a_stop_for_a_system_shutdown_keeps_the_request_queued(
        self, client: DataHubClient, integration_env: IntegrationEnv
    ) -> None:
        watcher_id, file_id = self._request_the_upload(client, integration_env)

        # With the deadline a stop for a system shutdown has, the heartbeat goes out with the
        # short HTTP timeout it gets there. This sends it through the real client.
        self._stop_the_watcher(
            client,
            watcher_id,
            stop_reason=SYSTEM_SHUTDOWN_STATUS_REASON,
            deadline=time.monotonic() + 7,
        )

        watchers = db_query(
            integration_env.db_dsn, "SELECT status FROM watchers WHERE id = %s", (watcher_id,)
        )
        assert watchers[0][0] == "stopped"
        assert self._file_status(integration_env, file_id) == "upload_requested"
        # Once the PC is back and the watcher has started, it finds the request in its queue.
        client.send_heartbeat(watcher_id, {"status": "watching"})
        assert [f.id for f in client.get_upload_queue(watcher_id).files] == [file_id]

    def test_a_stop_for_an_update_keeps_the_request_queued(
        self, client: DataHubClient, integration_env: IntegrationEnv
    ) -> None:
        watcher_id, file_id = self._request_the_upload(client, integration_env)

        self._stop_the_watcher(client, watcher_id, stop_reason=AUTO_UPDATE_STATUS_REASON)

        watchers = db_query(
            integration_env.db_dsn,
            "SELECT status, status_reason FROM watchers WHERE id = %s",
            (watcher_id,),
        )
        assert tuple(watchers[0]) == ("stopped", "auto_update")
        assert self._file_status(integration_env, file_id) == "upload_requested"
        # Once the updated watcher has started, it finds the request in its queue.
        client.send_heartbeat(watcher_id, {"status": "watching"})
        assert [f.id for f in client.get_upload_queue(watcher_id).files] == [file_id]

    def test_any_other_stop_cancels_the_request(
        self, client: DataHubClient, integration_env: IntegrationEnv
    ) -> None:
        watcher_id, file_id = self._request_the_upload(client, integration_env)

        self._stop_the_watcher(client, watcher_id)

        assert self._file_status(integration_env, file_id) == "detected"
