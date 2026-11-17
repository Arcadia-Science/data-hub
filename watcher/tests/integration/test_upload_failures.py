"""Integration tests: files the watcher gives up on (watcher 1.4.5).

The watcher reports each file it stops trying to upload with
``POST /watchers/<id>/upload-failures``, and the server marks it ``upload_failed`` with
the reason and writes one ``uploads_failed`` event per run and reason. These run the
real uploader and client against the real server.
"""

from __future__ import annotations
from pathlib import Path
from typing import Any, cast
from unittest.mock import MagicMock

import pytest

from data_hub_shared.testing import IntegrationEnv, db_query, db_update
from data_hub_watcher.api_client import DataHubClient, UploadFailure
from data_hub_watcher.constants import MAX_QUEUE_FILE_ATTEMPTS
from data_hub_watcher.events import EventReporter
from data_hub_watcher.heartbeat import WatcherCounters
from data_hub_watcher.state import StateDB
from data_hub_watcher.uploader import Uploader

pytestmark = pytest.mark.integration


def _report_run(
    client: DataHubClient, instrument_id: str, run_id: str, files: list[dict[str, Any]]
) -> str:
    """Register a watcher, report a run with *files*, and return the watcher's ID."""
    watcher = client.register_watcher(instrument_id)
    client.report_run(
        instrument_id,
        {
            "run_id": run_id,
            "source": "watcher",
            "watcher_id": watcher.watcher_id,
            "detected_files": files,
        },
    )
    return watcher.watcher_id


def _file(dsn: str, run_id: str, filename: str) -> dict[str, Any]:
    rows = db_query(
        dsn,
        """SELECT f.id, f.status::text, f.upload_failure_reason::text, f.upload_requested_at,
                  f.auto_upload_expected_at, f.error_message
           FROM files f JOIN instrument_runs r ON f.instrument_run_id = r.id
           WHERE r.run_id = %s AND f.filename = %s""",
        (run_id, filename),
    )
    assert rows, f"No file found for run={run_id}, filename={filename}"
    keys = ("id", "status", "reason", "requested_at", "auto_expected_at", "error_message")
    return dict(zip(keys, rows[0], strict=True))


def _uploads_failed_events(dsn: str, watcher_id: str) -> list[dict[str, Any]]:
    rows = db_query(
        dsn,
        "SELECT details FROM watcher_events WHERE watcher_id = %s AND event_type = %s",
        (watcher_id, "uploads_failed"),
    )
    return [cast("dict[str, Any]", row[0]) for row in rows]


class TestRequestedFileGivenUp:
    def test_a_file_whose_folder_is_gone_is_marked_upload_failed_after_three_polls(
        self,
        client: DataHubClient,
        instrument_id: str,
        integration_env: IntegrationEnv,
        tmp_path: Path,
    ) -> None:
        dsn = integration_env.db_dsn
        watcher_id = _report_run(
            client,
            instrument_id,
            "GONE-001",
            [{"filename": "a.csv", "relative_path": "GONE-001/a.csv"}],
        )
        file_id = _file(dsn, "GONE-001", "a.csv")["id"]
        db_update(
            dsn,
            "UPDATE files SET upload_requested_at = NOW(), status = 'upload_requested'"
            " WHERE id = %s",
            (file_id,),
        )
        state_db = StateDB(tmp_path / "state.db")
        reporter = MagicMock(spec=EventReporter)
        uploader = Uploader(
            client=client,
            state_db=state_db,
            event_reporter=reporter,
            counters=WatcherCounters(),
            instrument_id=instrument_id,
            watcher_id=watcher_id,
            # The run's folder isn't in it.
            watch_directory=tmp_path,
        )
        try:
            for _ in range(MAX_QUEUE_FILE_ATTEMPTS - 1):
                uploader.poll_upload_queue()
            assert _file(dsn, "GONE-001", "a.csv")["status"] == "upload_requested"
            uploader.poll_upload_queue()
        finally:
            state_db.close()

        row = _file(dsn, "GONE-001", "a.csv")
        assert (row["status"], row["reason"], row["requested_at"]) == (
            "upload_failed",
            "folder_missing",
            None,
        )
        assert "GONE-001" in row["error_message"]
        assert client.get_upload_queue(watcher_id).files == []
        [event] = _uploads_failed_events(dsn, watcher_id)
        assert (event["run_id"], event["reason"], event["failed_count"]) == (
            "GONE-001",
            "folder_missing",
            1,
        )
        # Data Hub wrote the event, so the watcher sent none of its own, and cancelled nothing.
        reporter.report_error.assert_not_called()
        assert uploader._queue_attempts == {}

    def test_a_report_about_an_earlier_request_is_skipped(
        self, client: DataHubClient, instrument_id: str, integration_env: IntegrationEnv
    ) -> None:
        dsn = integration_env.db_dsn
        watcher_id = _report_run(
            client,
            instrument_id,
            "STALE-001",
            [{"filename": "a.csv", "relative_path": "STALE-001/a.csv"}],
        )
        file_id = _file(dsn, "STALE-001", "a.csv")["id"]
        db_update(
            dsn,
            "UPDATE files SET upload_requested_at = NOW() - interval '1 hour',"
            " status = 'upload_requested' WHERE id = %s",
            (file_id,),
        )
        [queued] = client.get_upload_queue(watcher_id).files
        assert queued.upload_requested_at is not None
        # The request is cancelled and made again before the give-up arrives.
        db_update(dsn, "UPDATE files SET upload_requested_at = NOW() WHERE id = %s", (file_id,))

        counts = client.report_upload_failures(
            watcher_id,
            [
                UploadFailure(
                    run_id="STALE-001",
                    reason="file_missing",
                    file_id=file_id,
                    requested_at=queued.upload_requested_at,
                )
            ],
        )

        assert counts is not None
        assert (counts.failed, counts.skipped) == (0, 1)
        assert _file(dsn, "STALE-001", "a.csv")["status"] == "upload_requested"
        assert _uploads_failed_events(dsn, watcher_id) == []


class TestAutoModeFileGivenUp:
    def test_a_file_the_watcher_said_it_would_upload_is_marked_once(
        self, client: DataHubClient, instrument_id: str, integration_env: IntegrationEnv
    ) -> None:
        dsn = integration_env.db_dsn
        watcher_id = _report_run(
            client,
            instrument_id,
            "AUTO-001",
            [
                {"filename": "a.csv", "relative_path": "AUTO-001/a.csv", "will_upload": True},
                {"filename": "b.csv", "relative_path": "AUTO-001/b.csv"},
            ],
        )
        assert _file(dsn, "AUTO-001", "a.csv")["auto_expected_at"] is not None
        assert _file(dsn, "AUTO-001", "b.csv")["auto_expected_at"] is None
        failure = UploadFailure(
            run_id="AUTO-001",
            reason="upload_error",
            relative_path="AUTO-001/a.csv",
            detail="Upload URL request failed: down",
        )

        first = client.report_upload_failures(watcher_id, [failure])
        again = client.report_upload_failures(watcher_id, [failure])

        assert first is not None and (first.failed, first.skipped) == (1, 0)
        # A report the server already has is skipped, so a retry is safe.
        assert again is not None and (again.failed, again.skipped) == (0, 1)
        row = _file(dsn, "AUTO-001", "a.csv")
        assert (row["status"], row["reason"], row["auto_expected_at"]) == (
            "upload_failed",
            "upload_error",
            None,
        )
        assert "Upload URL request failed: down" in row["error_message"]
        assert len(_uploads_failed_events(dsn, watcher_id)) == 1

    def test_a_file_reported_without_the_mark_is_skipped(
        self, client: DataHubClient, instrument_id: str, integration_env: IntegrationEnv
    ) -> None:
        dsn = integration_env.db_dsn
        watcher_id = _report_run(
            client,
            instrument_id,
            "AUTO-002",
            [{"filename": "old.csv", "relative_path": "AUTO-002/old.csv"}],
        )

        counts = client.report_upload_failures(
            watcher_id,
            [
                UploadFailure(
                    run_id="AUTO-002", reason="file_missing", relative_path="AUTO-002/old.csv"
                )
            ],
        )

        assert counts is not None and (counts.failed, counts.skipped) == (0, 1)
        assert _file(dsn, "AUTO-002", "old.csv")["status"] == "detected"
