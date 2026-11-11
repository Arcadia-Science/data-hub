"""Integration tests: auto-upload flow.

Mirrors the full lifecycle of a watcher in auto-upload mode on a real
instrument:

    register -> heartbeat("watching") -> report_run (1 file)
      -> update_run (add 2nd file) -> mark_file_uploaded
      -> verify upload queue state -> heartbeat("stopped")
"""

from __future__ import annotations
import random
import threading
from pathlib import Path
from typing import Any, cast
from urllib.parse import parse_qs, urlparse

import pytest

from data_hub_shared.testing import IntegrationEnv, db_query
from data_hub_watcher.api_client import DataHubClient
from data_hub_watcher.events import EventReporter
from data_hub_watcher.heartbeat import WatcherCounters
from data_hub_watcher.state import StateDB
from data_hub_watcher.uploader import Uploader

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
                "content_type": "text/csv",
                "status": "uploaded",
            },
        )
        assert result.status == "uploaded"
        # The server derives the location from the run's key and the filename.
        assert result.s3_key == f"{instrument_id}/EXP-001/data_001.csv"
        assert result.s3_bucket
        assert result.content_type == "text/csv"
        assert result.uploaded_at is not None


# ------------------------------------------------------------------
# request_upload_url
# ------------------------------------------------------------------


class TestRequestUploadUrl:
    def test_request_upload_url_returns_presigned_url(
        self,
        client: DataHubClient,
        instrument_id: str,
    ) -> None:
        _register_and_report(client, instrument_id)
        result = client.request_upload_url(instrument_id, "EXP-001", "data_001.csv")
        assert result.upload_url
        assert result.s3_key == f"{instrument_id}/EXP-001/data_001.csv"
        assert result.s3_bucket
        assert result.file_id > 0
        assert result.expires_in == 3600
        assert result.already_uploaded is False

    def test_request_upload_url_creates_file_record_if_missing(
        self,
        client: DataHubClient,
        instrument_id: str,
    ) -> None:
        _register_and_report(client, instrument_id)
        result = client.request_upload_url(instrument_id, "EXP-001", "brand_new_file.csv")
        assert result.file_id > 0
        assert result.already_uploaded is False

    def test_request_upload_url_already_uploaded(
        self,
        client: DataHubClient,
        instrument_id: str,
        integration_env: IntegrationEnv,
    ) -> None:
        _register_and_report(client, instrument_id)
        file_id = _get_file_id(integration_env.db_dsn, "EXP-001", "data_001.csv")

        client.mark_file_uploaded(
            file_id,
            {
                "content_type": "text/csv",
                "status": "uploaded",
            },
        )

        result = client.request_upload_url(instrument_id, "EXP-001", "data_001.csv")
        assert result.already_uploaded is True
        assert result.file_id == file_id


# ------------------------------------------------------------------
# Queue-mode: request-upload -> request-upload-url -> mark uploaded
# ------------------------------------------------------------------


class TestQueueModePresignedUploadFlow:
    """Simulates manual/queue mode: files are detected, queued for upload via
    ``request-upload``, then a presigned URL is obtained and the file is marked
    uploaded — the same sequence ``Uploader.poll_upload_queue`` follows."""

    def test_queued_file_gets_presigned_url_and_marks_uploaded(
        self,
        client: DataHubClient,
        instrument_id: str,
        integration_env: IntegrationEnv,
    ) -> None:
        _register_and_report(client, instrument_id)

        file_id = _get_file_id(integration_env.db_dsn, "EXP-001", "data_001.csv")

        # Transition the file to upload_requested (mirrors the UI "approve" action).
        from data_hub_shared.testing import db_update

        db_update(
            integration_env.db_dsn,
            "UPDATE files SET status = 'upload_requested' WHERE id = %s",
            (file_id,),
        )

        # Watcher asks for a presigned URL for the queued file.
        presigned = client.request_upload_url(
            instrument_id, "EXP-001", "data_001.csv", content_type="text/csv"
        )
        assert presigned.upload_url
        assert presigned.file_id == file_id
        assert presigned.already_uploaded is False

        # After uploading to S3, the watcher notifies the API. The server
        # derives the S3 location itself, so the watcher only sends status/type.
        result = client.mark_file_uploaded(
            presigned.file_id,
            {
                "content_type": "text/csv",
                "status": "uploaded",
            },
        )
        assert result.status == "uploaded"
        assert result.s3_bucket == presigned.s3_bucket
        assert result.s3_key == presigned.s3_key


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


class TestMultipartUpload:
    def test_large_file_is_uploaded_in_parts(
        self,
        client: DataHubClient,
        instrument_id: str,
        integration_env: IntegrationEnv,
        tmp_path: Path,
    ) -> None:
        watcher_id, _run_id = _register_and_report(client, instrument_id, run_id="PARTS-001")
        payload = b"multipart-bytes-" * 80
        path = tmp_path / "stack.bin"
        path.write_bytes(payload)
        state = StateDB(tmp_path / "state.db")
        try:
            uploader = Uploader(
                client=client,
                state_db=state,
                event_reporter=EventReporter(client, watcher_id),
                counters=WatcherCounters(),
                instrument_id=instrument_id,
                watcher_id=watcher_id,
                watch_directory=tmp_path,
                # One PUT at a time, so the parts go one after another.
                upload_parallelism=1,
            )
            assert uploader._upload_single(path, "PARTS-001") is True
        finally:
            state.close()

        rows = db_query(
            integration_env.db_dsn,
            """SELECT f.status, f.multipart_upload_id FROM files f
               JOIN instrument_runs r ON f.instrument_run_id = r.id
               WHERE r.run_id = %s AND f.filename = %s""",
            ("PARTS-001", "stack.bin"),
        )
        assert rows[0] == ("uploaded", None)
        stored = (
            integration_env.s3_mirror_root
            / "data-hub-test-raw"
            / instrument_id
            / "PARTS-001"
            / "stack.bin"
        )
        assert stored.read_bytes() == payload

    def test_large_file_is_uploaded_in_parallel_parts(
        self,
        client: DataHubClient,
        instrument_id: str,
        integration_env: IntegrationEnv,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        watcher_id, _run_id = _register_and_report(client, instrument_id, run_id="PARTS-001")
        # The test server cuts parts at 1024 bytes, so this is 21 parts, which
        # take three part-URL requests of up to eight. Every part differs, so
        # a part sent in the wrong place changes the stored bytes.
        payload = random.Random(0).randbytes(21 * 1024)
        path = tmp_path / "stack.bin"
        path.write_bytes(payload)
        state = StateDB(tmp_path / "state.db")
        try:
            reporter = EventReporter(client, watcher_id)
            uploader = Uploader(
                client=client,
                state_db=state,
                event_reporter=reporter,
                counters=WatcherCounters(),
                instrument_id=instrument_id,
                watcher_id=watcher_id,
                watch_directory=tmp_path,
                upload_parallelism=4,
            )
            # Hold part 1 until another part is in S3, so the parts finish out
            # of order and the server must be given them sorted. The stub only
            # records what happened, and the test checks it after the upload.
            # A failed assert in here would be a failed part attempt, which
            # the uploader retries, so a regression would show up as a slow
            # failure. If the parts were sent one at a time, part 1 would wait
            # out the timeout, and the check below would fail within seconds.
            real_put = uploader._s3_session.put
            later_part_stored = threading.Event()
            part_one_saw_a_later_part: list[bool] = []
            stored_order: list[int] = []

            def put(url: str, **kwargs: Any) -> Any:
                part_number = int(parse_qs(urlparse(url).query)["partNumber"][0])
                if part_number == 1:
                    part_one_saw_a_later_part.append(later_part_stored.wait(timeout=3))
                response = real_put(url, **kwargs)
                stored_order.append(part_number)
                if part_number != 1:
                    later_part_stored.set()
                return response

            monkeypatch.setattr(uploader._s3_session, "put", put)
            uploaded = uploader._upload_single(path, "PARTS-001")
            reporter.flush()
        finally:
            state.close()

        assert uploaded is True
        assert part_one_saw_a_later_part == [True]
        assert stored_order.index(1) > 0
        assert sorted(stored_order) == list(range(1, 22))

        # The server checked the whole-file CRC when it assembled the parts.
        rows = db_query(
            integration_env.db_dsn,
            """SELECT f.status, f.multipart_upload_id FROM files f
               JOIN instrument_runs r ON f.instrument_run_id = r.id
               WHERE r.run_id = %s AND f.filename = %s""",
            ("PARTS-001", "stack.bin"),
        )
        assert rows[0] == ("uploaded", None)
        stored = (
            integration_env.s3_mirror_root
            / "data-hub-test-raw"
            / instrument_id
            / "PARTS-001"
            / "stack.bin"
        )
        assert stored.read_bytes() == payload

        events = db_query(
            integration_env.db_dsn,
            "SELECT details FROM watcher_events WHERE watcher_id = %s AND event_type = %s",
            (watcher_id, "file_uploaded"),
        )
        assert len(events) == 1
        details = cast(dict[str, Any], events[0][0])
        assert details["part_count"] == 21
        assert details["size_bytes"] == len(payload)
        assert details["prep_seconds"] >= 0
        assert details["upload_seconds"] > 0
