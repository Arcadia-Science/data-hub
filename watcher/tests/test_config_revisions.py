"""Unit tests for config revisions from the web app (watcher 1.4.0).

Covers `runtime.WatcherSupervisor` end to end against a mocked API client:
applying a revision by rebuilding the runtime in the same process, rejecting a
revision whose folder is missing, the waiting state, and the startup sync. The
runtimes are real (real `StateDB`, monitor and heartbeat threads) so the tests
exercise the actual rebuild, not a stand-in.
"""

from __future__ import annotations
import collections
import itertools
import logging
import os
import shutil
import sqlite3
import threading
import time
from collections.abc import Callable, Iterator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest
import requests
import yaml
from watchdog.events import DirDeletedEvent, DirMovedEvent, FileDeletedEvent

from data_hub_watcher import runtime
from data_hub_watcher.api_client import DEFAULT_TIMEOUT, ApiError, DataHubClient
from data_hub_watcher.config_io import save_config
from data_hub_watcher.constants import (
    DEFAULT_CHECK_INTERVAL_TICKS,
    DEFAULT_IDLE_TICKS_REQUIRED,
    HEARTBEAT_INTERVAL_SECONDS,
    STOP_BUDGET_SECONDS,
    SYSTEM_SHUTDOWN_HTTP_TIMEOUT,
    UPGRADE_HANDOFF_TIMEOUT_SECONDS,
)
from data_hub_watcher.events import EventType
from data_hub_watcher.heartbeat import HeartbeatLoop
from data_hub_watcher.models import (
    ConfigChecksumResponse,
    ConfigRevisionResponse,
    HeartbeatResponse,
    InstrumentConfig,
    MultipartPartUrl,
    MultipartPartUrlsResponse,
    PresignedUploadResponse,
    RunDetectionConfig,
    WatcherConfig,
)
from data_hub_watcher.runtime import WatcherSupervisor
from data_hub_watcher.state import StateDB
from data_hub_watcher.updater import UpgradeHandoff

WATCHER_ID = "w-test"


def _settings(watch_dir: Path, **overrides: Any) -> dict[str, Any]:
    settings: dict[str, Any] = {
        "watch_directory": str(watch_dir),
        "file_patterns": ["*.csv"],
        "run_detection": {"pattern": r"^([^_]+)", "recursive": False},
        "upload_mode": "auto",
        "stability_period_seconds": 5,
        "max_stability_wait_seconds": 300,
        "upload_parallelism": 4,
    }
    settings.update(overrides)
    return settings


def _revision(
    number: int, settings: dict[str, Any], *, status: str = "pending", source: str = "web"
) -> ConfigRevisionResponse:
    return ConfigRevisionResponse(
        revision=number,
        source=source,
        status=status,
        settings=settings,
        created_at=datetime.now(timezone.utc),
    )


def _client() -> MagicMock:
    client = MagicMock(name="DataHubClient")
    client.get_config_checksum.return_value = None
    client.push_config.return_value = ConfigChecksumResponse(config_checksum="sha256:x")
    client.get_latest_config_revision.return_value = None
    client.send_heartbeat.return_value = HeartbeatResponse(ok=True)
    return client


def _cfg(watch_dir: Path) -> WatcherConfig:
    return WatcherConfig(
        version=1,
        environment="staging",
        api_base_urls={"staging": "https://staging.example.test/api/v1"},
        watcher_ids={"staging": WATCHER_ID},
        # Baseline the files already on disk at first start so the tests
        # don't race the stability checker uploading them.
        initial_scan="new-only",
        instrument=InstrumentConfig(
            id="test-instrument",
            watch_directory=watch_dir,
            file_patterns=["*.csv"],
            upload_mode="auto",
            run_detection=RunDetectionConfig(pattern=r"^([^_]+)", recursive=False),
        ),
    )


class _Env:
    """A config file, state DB path and mocked client under *tmp_path*."""

    def __init__(self, tmp_path: Path) -> None:
        self.tmp_path = tmp_path
        self.watch_dir = tmp_path / "data"
        self.watch_dir.mkdir()
        (self.watch_dir / "RUN001_sample.csv").write_text("a,b\n1,2\n")
        self.config_path = tmp_path / "config.yaml"
        self.db_path = tmp_path / "state" / "watcher.staging.db"
        self.client = _client()
        self.supervisors: list[WatcherSupervisor] = []

    def write_config(self, cfg: WatcherConfig) -> WatcherConfig:
        save_config(cfg, self.config_path)
        return cfg

    def supervisor(
        self, cfg: WatcherConfig | None = None, *, upgrade_handoff: UpgradeHandoff | None = None
    ) -> WatcherSupervisor:
        if cfg is None:
            cfg = self.write_config(_cfg(self.watch_dir))
        sup = WatcherSupervisor(
            client=self.client,
            cfg=cfg,
            config_path=self.config_path,
            db_path=self.db_path,
            config_dir=self.tmp_path,
            role="Watcher",
            host="test-host",
            upgrade_handoff=upgrade_handoff,
        )
        self.supervisors.append(sup)
        return sup

    def saved_instrument(self) -> dict[str, Any]:
        return yaml.safe_load(self.config_path.read_text(encoding="utf-8"))["instrument"]

    def results(self) -> list[tuple[Any, ...]]:
        return [c.args for c in self.client.report_config_revision_result.call_args_list]

    def state(self) -> StateDB:
        return StateDB(self.db_path)


@pytest.fixture
def env(tmp_path: Path) -> Iterator[_Env]:
    e = _Env(tmp_path)
    try:
        yield e
    finally:
        for sup in e.supervisors:
            if sup.rt is not None or sup.waiting_reason is not None:
                sup.stop(stopped_message="test teardown")


def _deliver(sup: WatcherSupervisor, latest: int | None) -> None:
    """Simulate a heartbeat reply carrying *latest*, then handle it."""
    sup._on_heartbeat_revision(latest)
    sup.poll(timeout=0)


class TestApplyInProcess:
    def test_revision_rebuilds_runtime_without_exiting(self, env: _Env) -> None:
        sup = env.supervisor()
        sup.start()
        old_rt = sup.rt
        assert old_rt is not None

        env.client.get_latest_config_revision.return_value = _revision(
            2, _settings(env.watch_dir, file_patterns=["*.csv", "*.txt"])
        )
        env.client.push_config.reset_mock()
        sup._on_heartbeat_revision(2)
        # `poll` returning False means the process keeps running.
        assert sup.poll(timeout=0) is False

        new_rt = sup.rt
        assert new_rt is not None and new_rt is not old_rt
        # The new filters are live in the rebuilt monitor.
        assert new_rt.monitor._patterns == ["*.csv", "*.txt"]
        assert new_rt.monitor._matches_name("later.txt")
        assert not old_rt.monitor._matches_name("later.txt")
        assert new_rt.heartbeat._thread is not None and new_rt.heartbeat._thread.is_alive()
        # The rebuild is not a stop: no "stopped" heartbeat, no WATCHER_STOPPED.
        statuses = [c.args[1]["status"] for c in env.client.send_heartbeat.call_args_list]
        assert "stopped" not in statuses
        flushed = [
            e["event_type"] for c in env.client.send_events.call_args_list for e in c.args[1]
        ]
        assert EventType.WATCHER_STOPPED.value not in flushed
        assert flushed.count(EventType.WATCHER_STARTED.value) == 2
        # Saved, reported, then pushed with the revision it is based on.
        assert env.saved_instrument()["file_patterns"] == ["*.csv", "*.txt"]
        assert env.results() == [(WATCHER_ID, 2, "applied", None)]
        assert env.client.push_config.call_args.kwargs["based_on_revision"] == 2
        assert sup.applied_revision == 2
        # The heartbeat now reports the new applied revision.
        payload = new_rt.heartbeat._build_payload("watching")
        assert payload["config_revision"] == 2
        state = env.state()
        try:
            assert state.config_revision_applied() == 2
        finally:
            state.close()

    def test_widening_revision_rescans_existing_files_as_report_only(self, env: _Env) -> None:
        sup = env.supervisor()
        sup.start()
        old_txt = env.watch_dir / "RUN002_old.txt"
        old_txt.write_text("x\n")
        past = old_txt.stat().st_mtime - 600
        os.utime(old_txt, (past, past))
        env.client.get_latest_config_revision.return_value = _revision(
            2, _settings(env.watch_dir, file_patterns=["*.csv", "*.txt"])
        )

        _deliver(sup, 2)

        assert sup.rt is not None
        assert sup.rt.monitor._report_only_paths == {old_txt}

    def test_next_rebuild_keeps_reporting_files_the_earlier_change_matched(self, env: _Env) -> None:
        sup = env.supervisor()
        sup.start()
        old_txt = env.watch_dir / "RUN002_old.txt"
        old_txt.write_text("x\n")
        past = old_txt.stat().st_mtime - 600
        os.utime(old_txt, (past, past))
        widened = _settings(env.watch_dir, file_patterns=["*.csv", "*.txt"])
        env.client.get_latest_config_revision.return_value = _revision(2, widened)
        _deliver(sup, 2)
        assert sup.rt is not None and sup.rt.monitor._report_only_paths == {old_txt}

        # A second change that doesn't widen anything arrives before the first
        # rebuild's scan has reported the file.
        env.client.get_latest_config_revision.return_value = _revision(
            3, {**widened, "stability_period_seconds": 10}
        )
        _deliver(sup, 3)

        assert sup.applied_revision == 3
        assert sup.rt is not None and sup.rt.monitor._stability_period == 10
        assert sup.rt.monitor._report_only_paths == {old_txt}

    def test_non_widening_revision_rescans_normally(self, env: _Env) -> None:
        sup = env.supervisor()
        sup.start()
        env.client.get_latest_config_revision.return_value = _revision(
            2, _settings(env.watch_dir, stability_period_seconds=10)
        )

        _deliver(sup, 2)

        assert sup.rt is not None
        assert sup.rt.monitor._report_only is None
        assert sup.rt.monitor._stability_period == 10

    def test_folder_is_saved_as_typed_in_the_web_app(self, env: _Env) -> None:
        sup = env.supervisor()
        sup.start()
        # A path that resolves to another one, like a mapped drive that
        # resolves to a UNC path on Windows. The server can't tell the two are
        # the same folder, so pushing the resolved form back would look like a
        # new edit made on the PC.
        link = env.tmp_path / "data-link"
        link.symlink_to(env.watch_dir, target_is_directory=True)
        typed = str(link)
        env.client.get_latest_config_revision.return_value = _revision(
            2, _settings(env.watch_dir, watch_directory=typed, file_patterns=["*.txt"])
        )
        env.client.push_config.reset_mock()

        _deliver(sup, 2)

        assert env.saved_instrument()["watch_directory"] == typed
        pushed = yaml.safe_load(env.client.push_config.call_args.args[1])
        assert pushed["instrument"]["watch_directory"] == typed
        # The running config, and the file once loaded, use the resolved path.
        assert sup.cfg.instrument.watch_directory == env.watch_dir.resolve()
        from data_hub_watcher.config_io import load_config

        assert load_config(env.config_path).instrument.watch_directory == env.watch_dir.resolve()

    def test_non_editable_fields_are_kept(self, env: _Env) -> None:
        sup = env.supervisor()
        sup.start()
        env.client.get_latest_config_revision.return_value = _revision(
            2, _settings(env.watch_dir, upload_mode="manual", upload_parallelism=2)
        )
        _deliver(sup, 2)

        saved = yaml.safe_load(env.config_path.read_text(encoding="utf-8"))
        assert saved["environment"] == "staging"
        assert saved["watcher_ids"] == {"staging": WATCHER_ID}
        assert saved["api_base_urls"] == {"staging": "https://staging.example.test/api/v1"}
        assert saved["initial_scan"] == "new-only"
        assert saved["instrument"]["id"] == "test-instrument"
        assert saved["instrument"]["upload_mode"] == "manual"
        assert saved["instrument"]["upload_parallelism"] == 2
        assert sup.rt is not None and sup.rt.detector._upload_cb is None

    def test_restoring_the_running_settings_overwrites_an_unloaded_pc_edit(self, env: _Env) -> None:
        sup = env.supervisor()
        sup.start()
        old_rt = sup.rt
        # `config edit` on the PC while the watcher runs: the file changes,
        # but this process keeps running what it loaded at startup.
        save_config(
            _cfg(env.watch_dir).model_copy(
                update={
                    "instrument": _cfg(env.watch_dir).instrument.model_copy(
                        update={"file_patterns": ["*.csv", "*.dat"]}
                    )
                }
            ),
            env.config_path,
        )
        # An admin restores the settings the watcher still runs.
        env.client.get_latest_config_revision.return_value = _revision(2, _settings(env.watch_dir))
        env.client.push_config.reset_mock()

        _deliver(sup, 2)

        assert sup.rt is old_rt  # nothing to rebuild
        assert env.saved_instrument()["file_patterns"] == ["*.csv"]
        assert env.results() == [(WATCHER_ID, 2, "applied", None)]
        env.client.push_config.assert_called_once()
        assert sup.applied_revision == 2

    def test_matching_file_is_left_alone(self, env: _Env) -> None:
        sup = env.supervisor()
        sup.start()
        before = env.config_path.read_bytes()
        env.client.get_latest_config_revision.return_value = _revision(2, _settings(env.watch_dir))
        env.client.push_config.reset_mock()

        _deliver(sup, 2)

        assert env.config_path.read_bytes() == before
        assert env.results() == [(WATCHER_ID, 2, "applied", None)]
        env.client.push_config.assert_not_called()

    def test_older_revision_than_applied_is_not_refetched(self, env: _Env) -> None:
        sup = env.supervisor()
        sup.start()
        env.client.get_latest_config_revision.return_value = _revision(
            2, _settings(env.watch_dir, file_patterns=["*.txt"])
        )
        _deliver(sup, 2)
        env.client.get_latest_config_revision.reset_mock()

        _deliver(sup, 2)
        _deliver(sup, None)

        env.client.get_latest_config_revision.assert_not_called()


def _wait_until(condition: Callable[[], bool], timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        if time.monotonic() > deadline:
            raise AssertionError("timed out waiting for the condition")
        time.sleep(0.01)


class TestRebuildDuringPartUploads:
    """A rebuild while a large file's parts upload on their own threads (watcher 1.3.0)."""

    PART_SIZE = 64
    PART_COUNT = 4

    def test_parts_still_sending_at_the_limit_are_cut_off_before_the_new_runtime_starts(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # An auto-mode upload an earlier start never finished, so the first
        # runtime's upload worker sends it as soon as it starts.
        big = env.watch_dir / "RUN009_big.csv"
        big.write_bytes(bytes(i % 251 for i in range(self.PART_SIZE * self.PART_COUNT)))
        cfg = env.write_config(_cfg(env.watch_dir))
        state = env.state()
        try:
            state.record_report(
                "RUN009", [], new_run=False, pending_relative_paths=["RUN009_big.csv"]
            )
        finally:
            state.close()

        upload_numbers = itertools.count(1)

        def presign(*args: Any, **kwargs: Any) -> PresignedUploadResponse:
            return PresignedUploadResponse(
                upload_type="multipart",
                upload_id=f"upload-{next(upload_numbers)}",
                part_size=self.PART_SIZE,
                part_count=self.PART_COUNT,
                s3_bucket="test-bucket",
                s3_key="test-instrument/RUN009/RUN009_big.csv",
                file_id=9,
                expires_in=900,
                already_uploaded=False,
            )

        def part_urls(file_id: int, upload_id: str, numbers: list[int]) -> Any:
            return MultipartPartUrlsResponse(
                expires_in=900,
                parts=[
                    MultipartPartUrl(
                        part_number=n, upload_url=f"https://s3.example/{upload_id}/{n}"
                    )
                    for n in numbers
                ],
            )

        env.client.request_upload_url.side_effect = presign
        env.client.get_part_urls.side_effect = part_urls

        # Each part reads its body a byte at a time. While `slow` is set, a
        # part takes about three seconds, far past the drain limit below.
        slow = threading.Event()
        slow.set()
        lock = threading.Lock()
        sending: collections.Counter[str] = collections.Counter()
        # The threads that sent the first upload's parts.
        senders: set[threading.Thread] = set()

        def put(session: Any, url: str, *, data: Any, **kwargs: Any) -> MagicMock:
            upload_id = url.split("/")[-2]
            with lock:
                sending[upload_id] += 1
                if upload_id == "upload-1":
                    senders.add(threading.current_thread())
            try:
                while data.read(1):
                    if slow.is_set():
                        time.sleep(0.05)
            finally:
                with lock:
                    sending[upload_id] -= 1
            response = MagicMock()
            response.headers = {"ETag": f'"{url}"'}
            return response

        monkeypatch.setattr(requests.Session, "put", put)
        monkeypatch.setattr(runtime, "CONFIG_APPLY_DRAIN_TIMEOUT_SECONDS", 0.2)

        sup = env.supervisor(cfg)
        sup.start()
        old_rt = sup.rt
        assert old_rt is not None
        # All four parts are sending at once, within upload_parallelism (4).
        _wait_until(lambda: sending["upload-1"] == self.PART_COUNT)
        with lock:
            old_part_threads = list(senders)
        assert len(old_part_threads) == self.PART_COUNT

        real_build = runtime.build_runtime
        sending_at_rebuild: list[int] = []
        old_threads_at_rebuild: list[list[threading.Thread]] = []

        def build(**kwargs: Any) -> Any:
            with lock:
                sending_at_rebuild.append(sum(sending.values()))
            old_threads_at_rebuild.append([t for t in old_part_threads if t.is_alive()])
            slow.clear()
            return real_build(**kwargs)

        monkeypatch.setattr(runtime, "build_runtime", build)
        env.client.get_latest_config_revision.return_value = _revision(
            2, _settings(env.watch_dir, upload_parallelism=2)
        )

        _deliver(sup, 2)

        # No part of the old runtime was still sending when the new one was
        # built, and nothing of it is left to write to its closed state DB.
        assert sending_at_rebuild == [0]
        assert old_threads_at_rebuild == [[]]
        assert not old_rt.state_db._connections
        assert env.results() == [(WATCHER_ID, 2, "applied", None)]
        new_rt = sup.rt
        assert new_rt is not None
        assert new_rt.uploader._parallelism == 2

        # The interrupted file kept its pending_uploads row, so the new
        # runtime sends it again from the start and finishes it.
        def pending() -> list[str]:
            state = env.state()
            try:
                return [p.relative_path for p in state.pending_uploads()]
            finally:
                state.close()

        _wait_until(lambda: pending() == [])
        [complete] = env.client.complete_multipart_upload.call_args_list
        assert complete.args[1] == "upload-2"
        # Being cut off isn't a failure.
        sup.reporter.flush()
        flushed = [
            e["event_type"] for c in env.client.send_events.call_args_list for e in c.args[1]
        ]
        assert EventType.UPLOAD_FAILED.value not in flushed
        assert flushed.count(EventType.FILE_UPLOADED.value) == 1


class TestUpgradeMarker:
    """The post-upgrade marker is checked once per process, never on a rebuild."""

    def _event_types(self, env: _Env) -> list[str]:
        return [e["event_type"] for c in env.client.send_events.call_args_list for e in c.args[1]]

    def test_rebuild_leaves_a_freshly_written_marker_alone(self, env: _Env) -> None:
        from data_hub_watcher.updater import upgrade_marker_path, write_upgrade_marker
        from data_hub_watcher.upgrade_worker import upgrade_request_path, write_upgrade_request

        sup = env.supervisor()
        sup.start()
        # The updater dispatched an upgrade to the Windows worker on the same
        # heartbeat tick that announced a new revision.
        write_upgrade_marker(env.tmp_path, target_version="9.9.9", previous_version="1.4.0")
        write_upgrade_request(
            env.tmp_path,
            target_version="9.9.9",
            pkg_spec="data-hub-watcher==9.9.9",
            uv_executable="uv",
            index_url="https://example.test/simple",
            previous_version="1.4.0",
            install_method="uv-tool",
        )
        env.client.get_latest_config_revision.return_value = _revision(
            2, _settings(env.watch_dir, file_patterns=["*.txt"])
        )

        _deliver(sup, 2)
        assert sup.rt is not None
        sup.rt.reporter.flush()

        assert upgrade_marker_path(env.tmp_path).exists()
        assert upgrade_request_path(env.tmp_path).exists()
        assert EventType.UPDATE_FAILED.value not in self._event_types(env)

    def test_waiting_at_startup_still_reports_the_update(self, env: _Env) -> None:
        from data_hub_watcher.constants import WATCHER_VERSION
        from data_hub_watcher.updater import upgrade_marker_path, write_upgrade_marker

        write_upgrade_marker(env.tmp_path, target_version=WATCHER_VERSION, previous_version="1.2.3")
        sup = env.supervisor(env.write_config(_cfg(env.tmp_path / "later")))
        sup.start()
        sup.reporter.flush()

        assert sup.waiting_reason is not None
        assert not upgrade_marker_path(env.tmp_path).exists()
        assert EventType.UPDATE_SUCCEEDED.value in self._event_types(env)


class TestRejectMissingFolder:
    def test_missing_folder_is_rejected_and_old_config_keeps_running(self, env: _Env) -> None:
        sup = env.supervisor()
        sup.start()
        old_rt = sup.rt
        before = env.config_path.read_text(encoding="utf-8")
        missing = env.tmp_path / "does-not-exist"
        env.client.get_latest_config_revision.return_value = _revision(
            2, _settings(missing, file_patterns=["*.txt"])
        )

        _deliver(sup, 2)

        assert sup.rt is old_rt
        assert sup.cfg.instrument.file_patterns == ["*.csv"]
        assert env.config_path.read_text(encoding="utf-8") == before
        [(watcher_id, number, status, reason)] = env.results()
        assert (watcher_id, number, status) == (WATCHER_ID, 2, "rejected")
        assert "watch_directory not found" in reason
        assert str(missing) in reason
        assert sup.seen_revision == 2
        assert sup.applied_revision is None

    def test_rejected_revision_is_never_refetched(self, env: _Env) -> None:
        sup = env.supervisor()
        sup.start()
        env.client.get_latest_config_revision.return_value = _revision(
            2, _settings(env.tmp_path / "missing")
        )
        _deliver(sup, 2)
        env.client.get_latest_config_revision.reset_mock()

        # The server keeps replying with the rejected revision.
        _deliver(sup, 2)
        _deliver(sup, 2)

        env.client.get_latest_config_revision.assert_not_called()

        # ... even after a restart, because "seen" is persisted.
        sup.stop(stopped_message="restart")
        env.client.get_config_checksum.return_value = ConfigChecksumResponse(
            config_checksum="ignored"
        )
        restarted = env.supervisor(sup.cfg)
        restarted.start()
        env.client.get_latest_config_revision.reset_mock()
        _deliver(restarted, 2)
        env.client.get_latest_config_revision.assert_not_called()

    def test_invalid_regex_is_rejected(self, env: _Env) -> None:
        sup = env.supervisor()
        sup.start()
        two_groups = {"pattern": "^([^_]+)_(.*)", "recursive": False}
        env.client.get_latest_config_revision.return_value = _revision(
            2, _settings(env.watch_dir, run_detection=two_groups)
        )

        _deliver(sup, 2)

        [(_, _, status, reason)] = env.results()
        assert status == "rejected"
        assert "exactly 1 capture group" in reason

    def test_unsent_result_is_retried_on_a_later_heartbeat(self, env: _Env) -> None:
        sup = env.supervisor()
        sup.start()
        env.client.get_latest_config_revision.return_value = _revision(
            2, _settings(env.tmp_path / "missing")
        )
        env.client.report_config_revision_result.side_effect = [
            ApiError("offline", status_code=0),
            None,
        ]

        _deliver(sup, 2)
        assert sup._unsent_result is not None
        _deliver(sup, 2)

        assert [r[2] for r in env.results()] == ["rejected", "rejected"]
        assert sup._unsent_result is None
        env.client.get_latest_config_revision.assert_called_once()

    def test_unreadable_result_reply_is_retried_and_the_push_still_happens(self, env: _Env) -> None:
        sup = env.supervisor()
        sup.start()
        env.client.get_latest_config_revision.return_value = _revision(
            2, _settings(env.watch_dir, file_patterns=["*.txt"])
        )
        # A proxy answered with a page that isn't JSON.
        env.client.report_config_revision_result.side_effect = [
            ValueError("Expecting value: line 1 column 1 (char 0)"),
            None,
        ]
        env.client.push_config.reset_mock()

        _deliver(sup, 2)

        assert sup.applied_revision == 2
        assert sup._unsent_result == {"revision": 2, "status": "applied", "reason": None}
        env.client.push_config.assert_called_once()
        _deliver(sup, 2)
        assert [r[1:3] for r in env.results()] == [(2, "applied"), (2, "applied")]
        assert sup._unsent_result is None

    def test_config_file_switched_to_another_environment_is_not_overwritten(
        self, env: _Env
    ) -> None:
        sup = env.supervisor()
        sup.start()
        # `config set-environment production` ran while the watcher was up.
        switched = _cfg(env.watch_dir).model_copy(
            update={"environment": "production", "watcher_ids": {"production": "w-prod"}}
        )
        save_config(switched, env.config_path)
        env.client.get_latest_config_revision.return_value = _revision(
            2, _settings(env.watch_dir, file_patterns=["*.txt"])
        )

        _deliver(sup, 2)

        [(_, _, status, reason)] = env.results()
        assert status == "rejected"
        assert "restart the watcher" in reason
        saved = yaml.safe_load(env.config_path.read_text(encoding="utf-8"))
        assert saved["environment"] == "production"

    def test_start_failure_rolls_back_and_rejects(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        sup = env.supervisor()
        # The file on the PC has a comment, which re-saving the config drops.
        original = b"# Plate reader, set up by the lab\n" + env.config_path.read_bytes()
        env.config_path.write_bytes(original)
        sup.start()
        real_start = runtime.start_runtime
        attempts: list[list[str]] = []

        def flaky_start(rt: Any, **kwargs: Any) -> None:
            attempts.append(list(rt.monitor._patterns))
            if len(attempts) == 1:
                raise OSError("cannot watch")
            real_start(rt, **kwargs)

        monkeypatch.setattr(runtime, "start_runtime", flaky_start)
        env.client.get_latest_config_revision.return_value = _revision(
            2, _settings(env.watch_dir, file_patterns=["*.txt"])
        )

        _deliver(sup, 2)

        assert attempts == [["*.txt"], ["*.csv"]]
        assert sup.rt is not None
        assert sup.cfg.instrument.file_patterns == ["*.csv"]
        # Restored byte for byte, so its checksum still matches the server's.
        assert env.config_path.read_bytes() == original
        [(_, number, status, reason)] = env.results()
        assert (number, status) == (2, "rejected")
        assert "cannot watch" in reason
        assert sup.applied_revision is None

    def test_error_after_teardown_rolls_back_instead_of_going_silent(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        sup = env.supervisor()
        sup.start()
        before = env.config_path.read_bytes()
        elsewhere = env.tmp_path / "elsewhere"
        elsewhere.mkdir()

        def locked() -> None:
            raise sqlite3.OperationalError("database is locked")

        # Fails after the old loops have stopped, before the new ones start.
        monkeypatch.setattr(sup, "_forget_old_folder_uploads", locked)
        env.client.get_latest_config_revision.return_value = _revision(2, _settings(elsewhere))

        _deliver(sup, 2)

        assert sup.rt is not None
        assert sup.rt.heartbeat._thread is not None and sup.rt.heartbeat._thread.is_alive()
        assert sup.cfg.instrument.watch_directory == env.watch_dir.resolve()
        assert env.config_path.read_bytes() == before
        [(_, number, status, reason)] = env.results()
        assert (number, status) == (2, "rejected")
        assert "database is locked" in reason


class TestWaitingState:
    def _missing_cfg(self, env: _Env) -> WatcherConfig:
        cfg = _cfg(env.tmp_path / "later")
        return env.write_config(cfg)

    def test_missing_folder_at_startup_waits_and_sends_waiting_heartbeats(self, env: _Env) -> None:
        sup = env.supervisor(self._missing_cfg(env))
        sup.start()

        assert sup.rt is None
        assert sup.waiting_reason is not None
        assert "watch_directory not found" in sup.waiting_reason
        payload = env.client.send_heartbeat.call_args.args[1]
        assert payload["status"] == "waiting"
        assert payload["status_reason"] == sup.waiting_reason
        assert "config_revision" in payload

    def test_resumes_when_the_folder_appears(self, env: _Env) -> None:
        sup = env.supervisor(self._missing_cfg(env))
        sup.start()
        waiting = sup._waiting
        assert waiting is not None

        # Still missing: a tick changes nothing.
        waiting.heartbeat._on_tick()  # type: ignore[misc]
        sup.poll(timeout=0)
        assert sup.rt is None

        (env.tmp_path / "later").mkdir()
        waiting.heartbeat._on_tick()  # type: ignore[misc]
        sup.poll(timeout=0)

        assert sup.waiting_reason is None
        assert sup.rt is not None
        assert sup.rt.monitor._watch_dir == (env.tmp_path / "later").resolve()

    def test_resumes_when_a_revision_fixes_the_folder(self, env: _Env) -> None:
        sup = env.supervisor(self._missing_cfg(env))
        sup.start()
        env.client.get_latest_config_revision.return_value = _revision(1, _settings(env.watch_dir))
        waiting = sup._waiting
        assert waiting is not None

        # The waiting heartbeat's reply announces the fixing revision.
        env.client.send_heartbeat.return_value = HeartbeatResponse(ok=True, config_revision=1)
        waiting.heartbeat._send_heartbeat("waiting")
        sup.poll(timeout=0)

        assert sup.waiting_reason is None
        assert sup.rt is not None
        assert sup.cfg.instrument.watch_directory == env.watch_dir.resolve()
        assert env.saved_instrument()["watch_directory"] == str(env.watch_dir.resolve())
        assert env.results() == [(WATCHER_ID, 1, "applied", None)]

    def test_start_that_keeps_failing_queues_events_only_when_the_reason_changes(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from data_hub_watcher.monitor import FileMonitor

        def events() -> list[tuple[str, str | None]]:
            """Started events and waiting errors flushed so far, in order."""
            sup.reporter.flush()
            flushed = [e for c in env.client.send_events.call_args_list for e in c.args[1]]
            return [
                (e["event_type"], (e.get("details") or {}).get("reason"))
                for e in flushed
                if e["event_type"] == "watcher_started"
                or (e.get("details") or {}).get("kind") == "watch_directory_unavailable"
            ]

        def tick() -> None:
            waiting = sup._waiting
            assert waiting is not None
            waiting.heartbeat._on_tick()  # type: ignore[misc]
            sup.poll(timeout=0)

        def heartbeat_reason() -> str | None:
            waiting = sup._waiting
            assert waiting is not None
            return waiting.heartbeat._build_payload("waiting").get("status_reason")

        sup = env.supervisor(self._missing_cfg(env))
        sup.start()
        assert events() == [
            ("watcher_started", None),
            ("error", sup.waiting_reason),
        ]

        # The folder appears, but watching it fails every time.
        failure = OSError("inotify watch limit reached")
        attempts: list[int] = []

        def failing_start(_self: FileMonitor) -> None:
            attempts.append(1)
            raise failure

        monkeypatch.setattr(FileMonitor, "start", failing_start)
        (env.tmp_path / "later").mkdir()
        tick()
        assert len(attempts) == 1  # tried straight away
        reason = "could not start watching: inotify watch limit reached"
        assert sup.waiting_reason == reason
        assert heartbeat_reason() == reason
        assert events()[2:] == [("error", reason)]

        # The next ticks fall inside the backoff, so nothing is retried.
        tick()
        tick()
        assert len(attempts) == 1

        # Retries that fail the same way queue nothing, not even the started
        # event the attempt would have queued.
        for _ in range(3):
            sup._next_start_attempt = 0.0
            tick()
        assert len(attempts) == 4
        assert events()[3:] == []

        # A different failure is a new reason, reported once.
        failure = OSError("permission denied")
        sup._next_start_attempt = 0.0
        tick()
        assert events()[3:] == [("error", "could not start watching: permission denied")]

        # The folder goes away: the reason changes, and once it is back the
        # watcher tries again at once.
        (env.tmp_path / "later").rmdir()
        tick()
        assert sup.waiting_reason is not None
        assert "watch_directory not found" in sup.waiting_reason
        assert heartbeat_reason() == sup.waiting_reason
        assert events()[4:] == [("error", sup.waiting_reason)]
        (env.tmp_path / "later").mkdir()
        monkeypatch.undo()
        tick()

        assert sup.rt is not None
        assert events()[5:] == [("watcher_started", None)]
        started = [
            e["message"]
            for c in env.client.send_events.call_args_list
            for e in c.args[1]
            if e["event_type"] == "watcher_started"
        ]
        assert started[-1] == "Watcher resumed on test-host"

    def test_waiting_keeps_the_production_timers_without_overrides(self, env: _Env) -> None:
        sup = env.supervisor(self._missing_cfg(env))
        sup.start()

        waiting = sup._waiting
        assert waiting is not None
        assert waiting.heartbeat._interval == HEARTBEAT_INTERVAL_SECONDS
        assert waiting.updater._check_interval_ticks == DEFAULT_CHECK_INTERVAL_TICKS
        assert waiting.updater._idle_ticks_required == DEFAULT_IDLE_TICKS_REQUIRED

    def test_waiting_heartbeat_and_updater_use_the_test_only_overrides(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A waiting watcher builds its own heartbeat and updater, not through
        # `build_runtime`, so it has to read the overrides itself.
        monkeypatch.setenv("DATA_HUB_WATCHER_HEARTBEAT_INTERVAL_SECONDS", "7")
        monkeypatch.setenv("DATA_HUB_WATCHER_UPDATE_CHECK_INTERVAL_TICKS", "3")
        monkeypatch.setenv("DATA_HUB_WATCHER_UPDATE_IDLE_TICKS", "2")
        sup = env.supervisor(self._missing_cfg(env))
        sup.start()

        waiting = sup._waiting
        assert waiting is not None
        assert waiting.heartbeat._interval == 7
        assert waiting.updater._check_interval_ticks == 3
        assert waiting.updater._idle_ticks_required == 2

    def test_start_failure_backoff_counts_in_overridden_heartbeat_intervals(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from data_hub_watcher.monitor import FileMonitor

        def failing_start(_self: FileMonitor) -> None:
            raise OSError("inotify watch limit reached")

        def tick() -> None:
            waiting = sup._waiting
            assert waiting is not None
            waiting.heartbeat._on_tick()  # type: ignore[misc]
            sup.poll(timeout=0)

        def seconds_until_next_attempt() -> float:
            return sup._next_start_attempt - time.monotonic()

        monkeypatch.setenv("DATA_HUB_WATCHER_HEARTBEAT_INTERVAL_SECONDS", "7")
        monkeypatch.setattr(FileMonitor, "start", failing_start)
        sup = env.supervisor(self._missing_cfg(env))
        sup.start()
        (env.tmp_path / "later").mkdir()

        # The first failure waits one heartbeat interval before the next try
        # (a minute in production), the second two.
        tick()
        assert 0 < seconds_until_next_attempt() <= 7
        sup._next_start_attempt = 0.0
        tick()
        assert 7 < seconds_until_next_attempt() <= 14

    def test_config_still_loads_with_a_missing_folder(self, env: _Env) -> None:
        from data_hub_watcher.config_io import load_config

        self._missing_cfg(env)

        cfg = load_config(env.config_path)

        assert cfg.instrument.watch_directory == (env.tmp_path / "later").resolve()


class TestWatchFolderVanishesWhileWatching:
    """The watch folder disappears under a running watcher (watcher 1.4.3).

    The watcher moves to the waiting state, as it does when the folder is missing
    at start, and starts watching again once the folder is back.
    """

    PART_SIZE = 64
    PART_COUNT = 4

    @pytest.fixture(autouse=True)
    def _only_the_test_reports_the_folder_gone(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Ignore watchdog's own report of a deleted folder, so a tick is what is tested.

        The tests that hand the event handler an event themselves still work: they call it
        from the test's thread, and watchdog's runs on its observer's.
        """
        from data_hub_watcher import monitor as monitor_module

        real = monitor_module._EventHandler._note_root_event

        def from_the_test_only(handler: Any, event: Any) -> None:
            if threading.current_thread() is threading.main_thread():
                real(handler, event)

        monkeypatch.setattr(monitor_module._EventHandler, "_note_root_event", from_the_test_only)

    @staticmethod
    def _tick(sup: WatcherSupervisor) -> None:
        """One heartbeat tick of the running runtime, then the supervisor's poll."""
        assert sup.rt is not None
        sup._folder_check_due.clear()
        sup.rt.heartbeat._on_tick()  # type: ignore[misc]
        assert sup._folder_check_due.is_set()
        sup.poll(timeout=0)

    @staticmethod
    def _waiting_tick(sup: WatcherSupervisor) -> None:
        waiting = sup._waiting
        assert waiting is not None
        waiting.heartbeat._on_tick()  # type: ignore[misc]
        sup.poll(timeout=0)

    @staticmethod
    def _events(env: _Env, sup: WatcherSupervisor) -> list[dict[str, Any]]:
        sup.reporter.flush()
        return [e for c in env.client.send_events.call_args_list for e in c.args[1]]

    @staticmethod
    def _started_messages(events: list[dict[str, Any]]) -> list[str]:
        return [e["message"] for e in events if e["event_type"] == "watcher_started"]

    @staticmethod
    def _unavailable_reasons(events: list[dict[str, Any]]) -> list[str]:
        return [
            e["details"]["reason"]
            for e in events
            if (e.get("details") or {}).get("kind") == "watch_directory_unavailable"
        ]

    def test_a_tick_with_the_folder_gone_moves_the_watcher_to_waiting(
        self, env: _Env, caplog: pytest.LogCaptureFixture
    ) -> None:
        sup = env.supervisor()
        sup.start()
        old_rt = sup.rt
        assert old_rt is not None
        assert self._started_messages(self._events(env, sup)) == ["Watcher started on test-host"]

        shutil.rmtree(env.watch_dir)
        with caplog.at_level(logging.INFO, logger="data_hub_watcher.runtime"):
            self._tick(sup)

        assert sup.rt is None
        reason = sup.waiting_reason
        assert reason is not None and reason.startswith("watch_directory not found")
        # The old runtime is stopped for good, not left running next to the waiting loop.
        assert old_rt.heartbeat._thread is not None and not old_rt.heartbeat._thread.is_alive()
        assert old_rt.monitor._checker_thread is not None
        assert not old_rt.monitor._checker_thread.is_alive()
        assert not old_rt.state_db._connections
        # The heartbeat now says `waiting`, with the reason, and the watcher never "stopped".
        payload = env.client.send_heartbeat.call_args.args[1]
        assert payload["status"] == "waiting"
        assert payload["status_reason"] == reason
        statuses = [c.args[1]["status"] for c in env.client.send_heartbeat.call_args_list]
        assert "stopped" not in statuses
        # One error event for the move, and no second `watcher_started` (or a stop event).
        events = self._events(env, sup)
        assert self._started_messages(events) == ["Watcher started on test-host"]
        assert self._unavailable_reasons(events) == [reason]
        assert EventType.WATCHER_STOPPED.value not in [e["event_type"] for e in events]
        # One warning, which names the reason.
        warnings = [
            r.getMessage()
            for r in caplog.records
            if r.name == "data_hub_watcher.runtime" and r.levelno >= logging.WARNING
        ]
        assert len(warnings) == 1
        assert reason in warnings[0]

    def test_a_tick_with_the_folder_there_changes_nothing(self, env: _Env) -> None:
        sup = env.supervisor()
        sup.start()
        rt = sup.rt
        assert rt is not None

        self._tick(sup)

        assert sup.rt is rt
        assert sup.waiting_reason is None
        assert self._started_messages(self._events(env, sup)) == ["Watcher started on test-host"]

    def test_it_resumes_when_the_folder_is_back_and_waits_again_when_it_goes_again(
        self, env: _Env
    ) -> None:
        sup = env.supervisor()
        sup.start()
        old_rt = sup.rt
        shutil.rmtree(env.watch_dir)
        self._tick(sup)
        assert sup.rt is None

        # Still gone: a tick of the waiting heartbeat changes nothing.
        self._waiting_tick(sup)
        assert sup.rt is None and sup.waiting_reason is not None

        env.watch_dir.mkdir()
        self._waiting_tick(sup)

        new_rt = sup.rt
        assert new_rt is not None and new_rt is not old_rt
        assert sup.waiting_reason is None
        assert new_rt.heartbeat._thread is not None and new_rt.heartbeat._thread.is_alive()
        payload = env.client.send_heartbeat.call_args.args[1]
        assert payload["status"] == "watching"
        # The new runtime watches the new folder: a file written to it is picked up.
        (env.watch_dir / "RUN002_new.csv").write_text("a,b\n1,2\n")
        _wait_until(lambda: any(p.name == "RUN002_new.csv" for p in list(new_rt.monitor._pending)))
        events = self._events(env, sup)
        assert self._started_messages(events) == [
            "Watcher started on test-host",
            "Watcher resumed on test-host",
        ]

        # It can happen again, and reports the new stretch of waiting once more.
        shutil.rmtree(env.watch_dir)
        self._tick(sup)
        assert sup.rt is None and sup.waiting_reason is not None
        events = self._events(env, sup)
        assert len(self._unavailable_reasons(events)) == 2
        assert len(self._started_messages(events)) == 2

    def test_the_check_runs_on_the_poll_thread_when_the_heartbeat_ticks(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A real heartbeat thread, ticking every second: its tick must only ask for the
        # check, which `poll` runs on this thread.
        monkeypatch.setenv("DATA_HUB_WATCHER_HEARTBEAT_INTERVAL_SECONDS", "1")
        checked_on: list[threading.Thread] = []
        real_problem = runtime.watch_directory_problem

        def spy(path: Path) -> str | None:
            checked_on.append(threading.current_thread())
            return real_problem(path)

        monkeypatch.setattr(runtime, "watch_directory_problem", spy)
        sup = env.supervisor()
        sup.start()
        checked_on.clear()

        shutil.rmtree(env.watch_dir)
        deadline = time.monotonic() + 15
        while sup.waiting_reason is None:
            assert time.monotonic() < deadline, "the watcher never moved to waiting"
            sup.poll(timeout=0.5)

        assert checked_on
        assert set(checked_on) == {threading.current_thread()}

    def test_a_delete_event_for_the_folder_itself_asks_for_a_check_at_once(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        handlers = _record_handlers(monkeypatch)
        sup = env.supervisor()
        sup.start()
        [handler] = handlers
        sup._folder_check_due.clear()
        shutil.rmtree(env.watch_dir)

        # No heartbeat tick: watchdog's report alone asks for the check.
        handler.on_deleted(DirDeletedEvent(str(env.watch_dir)))
        assert sup._folder_check_due.is_set()
        sup.poll(timeout=0)

        assert sup.rt is None
        assert sup.waiting_reason is not None
        assert sup.waiting_reason.startswith("watch_directory not found")

    def test_a_delete_inside_the_folder_asks_for_nothing(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        handlers = _record_handlers(monkeypatch)
        sup = env.supervisor()
        sup.start()
        [handler] = handlers
        sup._folder_check_due.clear()

        handler.on_deleted(FileDeletedEvent(str(env.watch_dir / "RUN001_sample.csv")))
        handler.on_deleted(DirDeletedEvent(str(env.watch_dir / "subfolder")))
        handler.on_moved(DirMovedEvent(str(env.watch_dir / "subfolder"), str(env.tmp_path / "x")))

        assert not sup._folder_check_due.is_set()
        rt = sup.rt
        assert rt is not None
        sup.poll(timeout=0)
        assert sup.rt is rt

    def test_a_file_monitor_that_stopped_watching_is_rebuilt(self, env: _Env) -> None:
        sup = env.supervisor()
        sup.start()
        old_rt = sup.rt
        assert old_rt is not None
        assert old_rt.monitor.is_watching()

        # Deleted and created again before the watcher looked: the folder is there, but
        # watchdog stopped watching the one that was deleted.
        shutil.rmtree(env.watch_dir)
        env.watch_dir.mkdir()
        _wait_until(lambda: not old_rt.monitor.is_watching())
        self._tick(sup)

        new_rt = sup.rt
        assert new_rt is not None and new_rt is not old_rt
        assert sup.waiting_reason is None
        assert new_rt.monitor.is_watching()
        assert self._started_messages(self._events(env, sup)) == [
            "Watcher started on test-host",
            "Watcher resumed on test-host",
        ]

    def test_uploads_get_a_short_wait_and_start_again_when_the_folder_is_back(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # An auto-mode upload an earlier start never finished, so the runtime's upload
        # worker sends it as soon as it starts.
        big = env.watch_dir / "RUN009_big.csv"
        content = bytes(i % 251 for i in range(self.PART_SIZE * self.PART_COUNT))
        big.write_bytes(content)
        cfg = env.write_config(_cfg(env.watch_dir))
        state = env.state()
        try:
            state.record_report(
                "RUN009", [], new_run=False, pending_relative_paths=["RUN009_big.csv"]
            )
        finally:
            state.close()

        upload_numbers = itertools.count(1)

        def presign(*args: Any, **kwargs: Any) -> PresignedUploadResponse:
            return PresignedUploadResponse(
                upload_type="multipart",
                upload_id=f"upload-{next(upload_numbers)}",
                part_size=self.PART_SIZE,
                part_count=self.PART_COUNT,
                s3_bucket="test-bucket",
                s3_key="test-instrument/RUN009/RUN009_big.csv",
                file_id=9,
                expires_in=900,
                already_uploaded=False,
            )

        def part_urls(file_id: int, upload_id: str, numbers: list[int]) -> Any:
            return MultipartPartUrlsResponse(
                expires_in=900,
                parts=[
                    MultipartPartUrl(
                        part_number=n, upload_url=f"https://s3.example/{upload_id}/{n}"
                    )
                    for n in numbers
                ],
            )

        env.client.request_upload_url.side_effect = presign
        env.client.get_part_urls.side_effect = part_urls

        # Each part reads its body a byte at a time. While `slow` is set, a part takes
        # about three seconds, far past the wait below.
        slow = threading.Event()
        slow.set()
        lock = threading.Lock()
        sending: collections.Counter[str] = collections.Counter()

        def put(session: Any, url: str, *, data: Any, **kwargs: Any) -> MagicMock:
            upload_id = url.split("/")[-2]
            with lock:
                sending[upload_id] += 1
            try:
                while data.read(1):
                    if slow.is_set():
                        time.sleep(0.05)
            finally:
                with lock:
                    sending[upload_id] -= 1
            response = MagicMock()
            response.headers = {"ETag": f'"{url}"'}
            return response

        monkeypatch.setattr(requests.Session, "put", put)
        # The wait for a runtime whose folder is gone is its own, shorter limit. The one
        # for a config rebuild stays at its default, so reaching for it would hang.
        monkeypatch.setattr(runtime, "WATCH_FOLDER_GONE_DRAIN_TIMEOUT_SECONDS", 0.2)
        monkeypatch.setattr(runtime, "CONFIG_APPLY_DRAIN_TIMEOUT_SECONDS", 600)

        sup = env.supervisor(cfg)
        sup.start()
        # All four parts are sending at once, within upload_parallelism (4).
        _wait_until(lambda: sending["upload-1"] == self.PART_COUNT)

        # The parts hold the file open, so removing the folder works on POSIX, where an
        # open file can be deleted.
        shutil.rmtree(env.watch_dir)
        self._tick(sup)

        assert sup.rt is None and sup.waiting_reason is not None
        # The parts were cut off, not waited for: they would finish and complete the
        # upload if the move waited as long as a config rebuild does.
        with lock:
            assert sending["upload-1"] == 0
        assert env.client.complete_multipart_upload.call_args_list == []

        slow.clear()
        env.watch_dir.mkdir()
        big.write_bytes(content)
        self._waiting_tick(sup)
        assert sup.rt is not None

        # The interrupted file kept its pending_uploads row, so the new runtime sends it
        # again from the start and finishes it.
        def pending() -> list[str]:
            state = env.state()
            try:
                return [p.relative_path for p in state.pending_uploads()]
            finally:
                state.close()

        _wait_until(lambda: pending() == [])
        [complete] = env.client.complete_multipart_upload.call_args_list
        assert complete.args[1] == "upload-2"
        events = self._events(env, sup)
        assert EventType.UPLOAD_FAILED.value not in [e["event_type"] for e in events]

    def test_a_stop_after_the_move_is_a_clean_stop(self, env: _Env) -> None:
        sup = env.supervisor()
        sup.start()
        shutil.rmtree(env.watch_dir)
        self._tick(sup)
        assert sup.waiting_reason is not None
        env.client.send_heartbeat.reset_mock()

        sup.stop(stopped_message="Watcher stopped by user", operator_stop=True)

        assert env.client.send_heartbeat.call_args.args[1]["status"] == "stopped"
        stopped = [
            e
            for c in env.client.send_events.call_args_list
            for e in c.args[1]
            if e["event_type"] == EventType.WATCHER_STOPPED.value
        ]
        assert [e["message"] for e in stopped] == ["Watcher stopped by user"]


def _record_handlers(monkeypatch: pytest.MonkeyPatch) -> list[Any]:
    """Make every `FileMonitor` built from now on keep the event handler it schedules.

    The tests then hand the handler the events watchdog would report.
    """
    from data_hub_watcher import monitor as monitor_module

    handlers: list[Any] = []

    class RecordingObserver(monitor_module.Observer):  # type: ignore[misc]
        def schedule(self, event_handler: Any, path: Any, **kwargs: Any) -> Any:
            handlers.append(event_handler)
            return super().schedule(event_handler, path, **kwargs)

    monkeypatch.setattr(monitor_module, "Observer", RecordingObserver)
    return handlers


class TestStartAnnouncesTestOnlyOverrides:
    """`start` says which test-only overrides are set, whichever mode it starts in.

    The package index is only read when an upgrade is dispatched, so a PC with
    only that variable left set would otherwise log nothing until it installs
    from the index.
    """

    INDEX_URL = "DATA_HUB_WATCHER_INDEX_URL"
    INDEX = "http://127.0.0.1:8123/simple/"

    def _announcements(self, caplog: pytest.LogCaptureFixture) -> list[str]:
        return [
            r.getMessage()
            for r in caplog.records
            if r.name == "data_hub_watcher.testing_overrides"
            and "Test-only overrides are active" in r.getMessage()
        ]

    def test_an_index_url_set_on_its_own_is_announced_when_watching_starts(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        caplog.set_level(logging.WARNING)
        monkeypatch.setenv(self.INDEX_URL, self.INDEX)
        sup = env.supervisor()

        sup.start()

        assert sup.rt is not None
        (announcement,) = self._announcements(caplog)
        assert f"{self.INDEX_URL}={self.INDEX}" in announcement

    def test_an_index_url_set_on_its_own_is_announced_when_waiting_starts(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        caplog.set_level(logging.WARNING)
        monkeypatch.setenv(self.INDEX_URL, self.INDEX)
        sup = env.supervisor(env.write_config(_cfg(env.tmp_path / "later")))

        sup.start()

        assert sup.rt is None and sup.waiting_reason is not None
        (announcement,) = self._announcements(caplog)
        assert f"{self.INDEX_URL}={self.INDEX}" in announcement

    def test_it_is_announced_before_the_first_heartbeat(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        # If starting fails part-way, the log still says what was set.
        caplog.set_level(logging.WARNING)
        monkeypatch.setenv(self.INDEX_URL, self.INDEX)
        seen_when_first_heartbeat_sent: list[int] = []

        def first_heartbeat(*_args: Any, **_kwargs: Any) -> HeartbeatResponse:
            seen_when_first_heartbeat_sent.append(len(self._announcements(caplog)))
            return HeartbeatResponse(ok=True)

        env.client.send_heartbeat.side_effect = first_heartbeat
        sup = env.supervisor()

        sup.start()

        assert seen_when_first_heartbeat_sent[0] == 1

    def test_it_is_announced_once_however_often_the_runtime_is_rebuilt(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        caplog.set_level(logging.WARNING)
        monkeypatch.setenv(self.INDEX_URL, self.INDEX)
        sup = env.supervisor()
        sup.start()
        env.client.get_latest_config_revision.return_value = _revision(
            2, _settings(env.watch_dir, file_patterns=["*.csv", "*.txt"])
        )

        _deliver(sup, 2)

        assert sup.applied_revision == 2
        assert len(self._announcements(caplog)) == 1

    def test_nothing_is_announced_when_no_override_is_set(
        self, env: _Env, caplog: pytest.LogCaptureFixture
    ) -> None:
        caplog.set_level(logging.WARNING)
        sup = env.supervisor()

        sup.start()

        assert self._announcements(caplog) == []


class TestStartupSync:
    def test_push_sends_based_on_revision_and_modified_at(self, env: _Env) -> None:
        state = env.state()
        state.claim_config_revisions(WATCHER_ID)
        state.record_config_revision_applied(3)
        state.close()
        sup = env.supervisor()

        sup.start()

        kwargs = env.client.push_config.call_args.kwargs
        assert kwargs["based_on_revision"] == 3
        mtime = env.config_path.stat().st_mtime
        assert kwargs["modified_at"] == datetime.fromtimestamp(mtime, tz=timezone.utc)

    def test_revisions_of_a_previous_registration_are_forgotten(self, env: _Env) -> None:
        # The watcher was deregistered and `init` registered a new one, which
        # kept the state DB. The old watcher had reached revision 12.
        state = env.state()
        state.claim_config_revisions("w-previous")
        state.record_config_revision_applied(12)
        state.close()
        sup = env.supervisor()
        sup.start()

        assert sup.applied_revision is None and sup.seen_revision is None
        assert sup.rt is not None
        assert sup.rt.heartbeat._build_payload("watching")["config_revision"] is None
        assert env.client.push_config.call_args.kwargs["based_on_revision"] is None

        # The new watcher's second revision is picked up and applied.
        env.client.get_latest_config_revision.return_value = _revision(
            2, _settings(env.watch_dir, file_patterns=["*.txt"])
        )
        _deliver(sup, 2)

        assert sup.cfg.instrument.file_patterns == ["*.txt"]
        assert env.results() == [(WATCHER_ID, 2, "applied", None)]
        state = env.state()
        try:
            assert state.get_meta("config_revision_watcher_id") == WATCHER_ID
        finally:
            state.close()

    def test_pending_revision_is_applied_before_monitoring(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls: list[Any] = []
        real_start = runtime.start_runtime

        def record_start(rt: Any, **kwargs: Any) -> None:
            calls.append(("start", list(rt.monitor._patterns)))
            real_start(rt, **kwargs)

        monkeypatch.setattr(runtime, "start_runtime", record_start)
        env.client.push_config.side_effect = lambda *a, **k: (
            calls.append("push"),
            ConfigChecksumResponse(config_checksum="sha256:x", config_revision=4),
        )[1]
        env.client.report_config_revision_result.side_effect = lambda *a, **k: calls.append(
            ("result", a[1], a[2])
        )
        env.client.get_latest_config_revision.return_value = _revision(
            4, _settings(env.watch_dir, file_patterns=["*.csv", "*.txt"])
        )
        sup = env.supervisor()

        sup.start()

        start_index = next(i for i, c in enumerate(calls) if c[0] == "start")
        assert calls[0] == "push"
        assert ("result", 4, "applied") in calls[:start_index]
        assert calls[start_index] == ("start", ["*.csv", "*.txt"])
        assert sup.applied_revision == 4

    def test_pc_revision_from_the_push_is_recorded_as_applied(self, env: _Env) -> None:
        env.client.push_config.return_value = ConfigChecksumResponse(
            config_checksum="sha256:x", config_revision=1
        )
        env.client.get_latest_config_revision.return_value = _revision(
            1, _settings(env.watch_dir), status="applied", source="pc"
        )
        sup = env.supervisor()

        sup.start()

        assert sup.applied_revision == 1
        env.client.report_config_revision_result.assert_not_called()

    def test_without_a_push_the_latest_revision_is_checked(self, env: _Env) -> None:
        # The remote checksum already matches, so nothing is pushed.
        from data_hub_watcher.config_io import config_checksum

        env.write_config(_cfg(env.watch_dir))
        env.client.get_config_checksum.return_value = ConfigChecksumResponse(
            config_checksum=config_checksum(env.config_path)
        )
        env.client.get_latest_config_revision.return_value = _revision(
            5, _settings(env.watch_dir, file_patterns=["*.txt"])
        )
        sup = env.supervisor(_cfg(env.watch_dir))

        sup.start()

        env.client.push_config.assert_called_once()  # the push after applying
        assert sup.cfg.instrument.file_patterns == ["*.txt"]
        assert sup.applied_revision == 5

    def test_offline_conflict_won_by_web_applies_it_and_settles_on_the_superseded_number(
        self, env: _Env
    ) -> None:
        # The PC's file changed while offline, and the newer web change (4)
        # won. The server stored the PC's edit after it (5) as superseded,
        # so the push reply and every heartbeat announce 5, while
        # `…/config-revisions/latest` returns the pending revision first.
        env.client.push_config.return_value = ConfigChecksumResponse(
            config_checksum="sha256:x", config_revision=5
        )
        web = _revision(4, _settings(env.watch_dir, file_patterns=["*.txt"]))
        env.client.get_latest_config_revision.return_value = web
        sup = env.supervisor()

        sup.start()

        assert sup.cfg.instrument.file_patterns == ["*.txt"]
        assert env.results() == [(WATCHER_ID, 4, "applied", None)]
        assert sup.applied_revision == 4

        # Nothing is pending any more, so the server returns the superseded
        # PC edit. It is recorded as seen, never applied or reported.
        env.client.get_latest_config_revision.reset_mock()
        env.client.get_latest_config_revision.return_value = _revision(
            5, _settings(env.watch_dir), status="superseded", source="pc"
        )
        _deliver(sup, 5)

        env.client.get_latest_config_revision.assert_called_once()
        assert sup.seen_revision == 5
        assert sup.applied_revision == 4
        assert sup.cfg.instrument.file_patterns == ["*.txt"]
        assert env.results() == [(WATCHER_ID, 4, "applied", None)]
        assert (
            sup.rt is not None
            and sup.rt.heartbeat._build_payload("watching")["config_revision"] == 4
        )

        # Later heartbeats that still announce 5 don't fetch it again.
        env.client.get_latest_config_revision.reset_mock()
        _deliver(sup, 5)
        _deliver(sup, 5)
        env.client.get_latest_config_revision.assert_not_called()


class TestOldServer:
    def _client_returning(self, status: int, body: Any) -> DataHubClient:
        client = DataHubClient("https://example.test/api/v1", api_key="dhub_test")
        resp = MagicMock()
        resp.ok = 200 <= status < 300
        resp.status_code = status
        resp.json.return_value = body
        resp.text = "Not Found"
        client._session.request = MagicMock(return_value=resp)  # type: ignore[method-assign]
        return client

    def test_404_on_new_endpoints_returns_nothing_and_logs_once(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        client = self._client_returning(404, {"error": {"code": "NOT_FOUND", "message": "nope"}})

        with caplog.at_level(logging.DEBUG, logger="data_hub_watcher.api_client"):
            assert client.get_latest_config_revision("w-1") is None
            assert client.get_latest_config_revision("w-1") is None

        records = [r for r in caplog.records if r.name == "data_hub_watcher.api_client"]
        assert len(records) == 1
        assert records[0].levelno == logging.INFO

    def test_old_heartbeat_reply_never_triggers_a_fetch(self) -> None:
        reply = HeartbeatResponse.model_validate({"ok": True})
        assert reply.config_revision is None
        pushed = ConfigChecksumResponse.model_validate({"config_checksum": "sha256:x"})
        assert pushed.config_revision is None

    def test_supervisor_runs_quietly_against_an_old_server(self, env: _Env) -> None:
        sup = env.supervisor()
        sup.start()
        _deliver(sup, None)

        assert sup.rt is not None
        assert sup.applied_revision is None and sup.seen_revision is None
        env.client.report_config_revision_result.assert_not_called()
        kinds = [
            e.get("details", {}).get("kind")
            for c in env.client.send_events.call_args_list
            for e in c.args[1]
        ]
        assert "config_sync_failed" not in kinds


class TestStopMarksASystemShutdown:
    """`WatcherSupervisor.stop` sends the final heartbeat, running or waiting, and marks it
    when Windows is shutting down (the server then keeps requested uploads queued)."""

    @staticmethod
    def _final_heartbeat(env: _Env) -> dict[str, Any]:
        payload = env.client.send_heartbeat.call_args.args[1]
        assert payload["status"] == "stopped"
        return payload

    @pytest.mark.parametrize("waiting", [False, True], ids=["running", "waiting"])
    def test_a_system_shutdown_marks_the_final_heartbeat(self, env: _Env, waiting: bool) -> None:
        sup = env.supervisor(env.write_config(_cfg(env.tmp_path / "later")) if waiting else None)
        sup.start()
        assert (sup.waiting_reason is not None) is waiting

        sup.stop(stopped_message="Service stopped: Windows is shutting down", system_shutdown=True)

        assert self._final_heartbeat(env)["status_reason"] == "system_shutdown"

    @pytest.mark.parametrize("waiting", [False, True], ids=["running", "waiting"])
    def test_any_other_stop_does_not(self, env: _Env, waiting: bool) -> None:
        sup = env.supervisor(env.write_config(_cfg(env.tmp_path / "later")) if waiting else None)
        sup.start()
        assert (sup.waiting_reason is not None) is waiting

        sup.stop(stopped_message="Service stopped")

        assert "status_reason" not in self._final_heartbeat(env)

    @pytest.mark.parametrize("waiting", [False, True], ids=["running", "waiting"])
    def test_a_system_shutdown_sends_the_last_requests_with_a_short_timeout(
        self, env: _Env, waiting: bool
    ) -> None:
        # Windows ends the service within about 10 s, so the final heartbeat and the events
        # can't wait for the client's usual 5 s connect and 30 s read.
        sup = env.supervisor(env.write_config(_cfg(env.tmp_path / "later")) if waiting else None)
        sup.start()
        assert (sup.waiting_reason is not None) is waiting

        sup.stop(stopped_message="Service stopped: Windows is shutting down", system_shutdown=True)

        for send in (env.client.send_heartbeat, env.client.send_events):
            connect, read = send.call_args.kwargs["timeout"]
            assert 0 < connect <= 2
            assert 0 < read <= 3
        assert self._final_heartbeat(env)["status"] == "stopped"
        stopped = [
            e
            for c in env.client.send_events.call_args_list
            for e in c.args[1]
            if e["event_type"] == "watcher_stopped"
        ]
        assert [e["message"] for e in stopped] == ["Service stopped: Windows is shutting down"]

    @pytest.mark.parametrize("waiting", [False, True], ids=["running", "waiting"])
    def test_any_other_stop_sends_the_last_requests_with_what_the_stop_can_spare(
        self, env: _Env, waiting: bool
    ) -> None:
        # Every stop is limited to 25 s, so the last two requests get the client's usual
        # timeout cut down to fit, which is longer than at a shutdown.
        sup = env.supervisor(env.write_config(_cfg(env.tmp_path / "later")) if waiting else None)
        sup.start()
        assert (sup.waiting_reason is not None) is waiting

        sup.stop(stopped_message="Service stopped")

        for send in (env.client.send_heartbeat, env.client.send_events):
            connect, read = send.call_args.kwargs["timeout"]
            assert SYSTEM_SHUTDOWN_HTTP_TIMEOUT[0] < connect <= DEFAULT_TIMEOUT[0]
            # Long enough for a server that takes 6 s to answer.
            assert max(SYSTEM_SHUTDOWN_HTTP_TIMEOUT[1], 6) < read <= DEFAULT_TIMEOUT[1]
            assert connect + read <= STOP_BUDGET_SECONDS

    @pytest.mark.parametrize("system_shutdown", [False, True], ids=["stop", "shutdown"])
    @pytest.mark.parametrize("waiting", [False, True], ids=["running", "waiting"])
    def test_the_stop_event_reaches_the_server_before_the_final_heartbeat(
        self, env: _Env, waiting: bool, system_shutdown: bool
    ) -> None:
        sup = env.supervisor(env.write_config(_cfg(env.tmp_path / "later")) if waiting else None)
        sup.start()
        assert (sup.waiting_reason is not None) is waiting
        sent: list[str] = []
        env.client.send_heartbeat.side_effect = lambda _id, payload, **_kw: sent.append(
            f"heartbeat {payload['status']}"
        )
        env.client.send_events.side_effect = lambda _id, events, **_kw: sent.extend(
            f"event {e['event_type']}" for e in events
        )

        sup.stop(stopped_message="Service stopped", system_shutdown=system_shutdown)

        assert sent.index("event watcher_stopped") < sent.index("heartbeat stopped")
        assert sent[-1] == "heartbeat stopped"


class TestStopMarksAnUpdate:
    """`WatcherSupervisor.stop` marks the final heartbeat `auto_update` for an update.

    The server then keeps the instrument's requested uploads queued for the watcher to
    upload after it starts again. An update is under way when an in-process update was
    installed (the `watch` CLI, or a pip-installed service) or when the updater handed an
    upgrade to the Windows worker, which stops the service from outside.
    """

    @staticmethod
    def _started(env: _Env, *, waiting: bool) -> WatcherSupervisor:
        sup = env.supervisor(env.write_config(_cfg(env.tmp_path / "later")) if waiting else None)
        sup.start()
        assert (sup.waiting_reason is not None) is waiting
        return sup

    @staticmethod
    def _hand_off_to_the_worker(sup: WatcherSupervisor) -> None:
        # What the updater records once `schtasks` has accepted the upgrade.
        sup._handoff.record("9.9.9")

    @staticmethod
    def _final_status_reason(env: _Env) -> str | None:
        payload = env.client.send_heartbeat.call_args.args[1]
        assert payload["status"] == "stopped"
        return payload.get("status_reason")

    @pytest.mark.parametrize("waiting", [False, True], ids=["running", "waiting"])
    def test_an_in_process_update_marks_the_final_heartbeat(self, env: _Env, waiting: bool) -> None:
        sup = self._started(env, waiting=waiting)
        # What the updater does once the new version is installed.
        sup.upgrade_restart_event.set()

        sup.stop(stopped_message="Watcher restarting for auto-update")

        assert self._final_status_reason(env) == "auto_update"

    @pytest.mark.parametrize("waiting", [False, True], ids=["running", "waiting"])
    def test_a_hand_off_to_the_worker_marks_the_final_heartbeat(
        self, env: _Env, waiting: bool
    ) -> None:
        sup = self._started(env, waiting=waiting)
        self._hand_off_to_the_worker(sup)

        # The worker's `Stop-Service` is an ordinary stop for the service loop.
        sup.stop(stopped_message="Service stopped")

        assert self._final_status_reason(env) == "auto_update"

    @pytest.mark.parametrize("waiting", [False, True], ids=["running", "waiting"])
    def test_a_system_shutdown_wins_over_an_update(self, env: _Env, waiting: bool) -> None:
        sup = self._started(env, waiting=waiting)
        sup.upgrade_restart_event.set()
        self._hand_off_to_the_worker(sup)

        sup.stop(stopped_message="Service stopped: Windows is shutting down", system_shutdown=True)

        assert self._final_status_reason(env) == "system_shutdown"

    @pytest.mark.parametrize("waiting", [False, True], ids=["running", "waiting"])
    def test_a_stop_the_operator_asked_for_is_never_marked(self, env: _Env, waiting: bool) -> None:
        # Ctrl+C in the CLI, even with an update installed or handed off at that moment.
        sup = self._started(env, waiting=waiting)
        sup.upgrade_restart_event.set()
        self._hand_off_to_the_worker(sup)

        sup.stop(stopped_message="Watcher stopped by user", operator_stop=True)

        assert self._final_status_reason(env) is None

    @pytest.mark.parametrize("waiting", [False, True], ids=["running", "waiting"])
    def test_a_stop_with_no_update_under_way_is_not_marked(self, env: _Env, waiting: bool) -> None:
        sup = self._started(env, waiting=waiting)

        sup.stop(stopped_message="Service stopped")

        assert self._final_status_reason(env) is None


class TestHandOffToTheWorker:
    """What the supervisor keeps of an upgrade handed to the Windows worker.

    The updater records the hand-off in the supervisor's `UpgradeHandoff`, so it
    outlives the runtime: a runtime is built again, with a new updater, for a config
    revision, when the watch folder comes back, and when a start fails. Each test
    dispatches through the updater's real tick, with `schtasks` and the install
    method stood in for, so the worker's own work is not run.
    """

    @staticmethod
    def _windows_uv_tool(env: _Env, monkeypatch: pytest.MonkeyPatch) -> list[None]:
        """Make every updater dispatch a mandatory update to the worker.

        Returns the list that gets an item for every `schtasks /Run`.
        """
        from data_hub_watcher import updater as updater_module
        from data_hub_watcher.models import WatcherUpdateInfoResponse
        from data_hub_watcher.self_update import InstallMethod

        monkeypatch.setattr(updater_module.sys, "platform", "win32")
        monkeypatch.setattr(updater_module, "detect_install_method", lambda: InstallMethod.UV_TOOL)
        monkeypatch.setattr(
            updater_module,
            "_resolve_uv_executable",
            lambda **_kw: ("/fake/uv.exe", ["/fake/uv.exe"]),
        )
        monkeypatch.setattr(updater_module, "detect_installed_extras", lambda: [])
        triggers: list[None] = []
        monkeypatch.setattr(
            "data_hub_watcher.scheduled_task.trigger_upgrade_task",
            lambda **_kw: triggers.append(None),
        )
        env.client.get_update_info.return_value = WatcherUpdateInfoResponse(
            latest_version="9.9.9", mandatory=True
        )
        return triggers

    @staticmethod
    def _tick(sup: WatcherSupervisor) -> None:
        """One heartbeat tick of whatever runs: the updater's `on_tick` runs from it."""
        heartbeat = sup.rt.heartbeat if sup.rt is not None else sup._waiting.heartbeat  # type: ignore[union-attr]
        heartbeat._on_tick()  # type: ignore[misc]

    @staticmethod
    def _updater(sup: WatcherSupervisor) -> Any:
        return sup.rt.updater if sup.rt is not None else sup._waiting.updater  # type: ignore[union-attr]

    @staticmethod
    def _final_status_reason(env: _Env) -> str | None:
        payload = env.client.send_heartbeat.call_args.args[1]
        assert payload["status"] == "stopped"
        return payload.get("status_reason")

    @staticmethod
    def _flushed_event_types(env: _Env) -> list[str]:
        return [e["event_type"] for c in env.client.send_events.call_args_list for e in c.args[1]]

    def _hand_off(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch, *, waiting: bool = False
    ) -> tuple[WatcherSupervisor, list[None], list[float]]:
        """A started supervisor whose first tick handed an upgrade to the worker."""
        triggers = self._windows_uv_tool(env, monkeypatch)
        now = [1_000.0]
        sup = env.supervisor(
            env.write_config(_cfg(env.tmp_path / "later")) if waiting else None,
            upgrade_handoff=UpgradeHandoff(clock=lambda: now[0]),
        )
        sup.start()
        assert (sup.waiting_reason is not None) is waiting
        self._tick(sup)
        assert triggers == [None]
        return sup, triggers, now

    def _assert_kept(self, env: _Env, sup: WatcherSupervisor, triggers: list[None]) -> None:
        """The runtime was built again, and the hand-off is neither lost nor repeated."""
        env.client.get_update_info.reset_mock()
        updater = self._updater(sup)

        result = updater.on_tick()

        assert result is not None and result.reason == "upgrade handed to the worker"
        env.client.get_update_info.assert_not_called()
        assert triggers == [None]
        # The worker's `Stop-Service` is an ordinary stop for the service loop.
        sup.stop(stopped_message="Service stopped")
        assert self._final_status_reason(env) == "auto_update"

    def test_a_config_revision_rebuild_keeps_the_hand_off(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The heartbeat before the dispatching tick carried a new revision, and the tick
        # that dispatched ran before the poll thread rebuilt the runtime.
        sup, triggers, _now = self._hand_off(env, monkeypatch)
        old_updater = self._updater(sup)
        env.client.get_latest_config_revision.return_value = _revision(
            2, _settings(env.watch_dir, file_patterns=["*.txt"])
        )

        _deliver(sup, 2)

        assert sup.rt is not None and self._updater(sup) is not old_updater
        self._assert_kept(env, sup, triggers)

    def test_the_switch_from_waiting_to_watching_keeps_the_hand_off(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        sup, triggers, _now = self._hand_off(env, monkeypatch, waiting=True)
        old_updater = self._updater(sup)
        (env.tmp_path / "later").mkdir()
        # The next tick still has the hand-off, and the folder check it starts rebuilds.
        self._tick(sup)
        sup.poll(timeout=0)

        assert sup.rt is not None and sup.waiting_reason is None
        assert self._updater(sup) is not old_updater
        self._assert_kept(env, sup, triggers)

    def test_a_rollback_after_a_failed_start_keeps_the_hand_off(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        sup, triggers, _now = self._hand_off(env, monkeypatch)
        old_updater = self._updater(sup)
        real_start = runtime.start_runtime
        attempts: list[None] = []

        def flaky_start(rt: Any, **kwargs: Any) -> None:
            attempts.append(None)
            if len(attempts) == 1:
                raise OSError("cannot watch")
            real_start(rt, **kwargs)

        monkeypatch.setattr(runtime, "start_runtime", flaky_start)
        env.client.get_latest_config_revision.return_value = _revision(
            2, _settings(env.watch_dir, file_patterns=["*.txt"])
        )

        _deliver(sup, 2)

        # The new config failed, and the previous one runs again with a new updater.
        assert len(attempts) == 2 and sup.rt is not None
        assert self._updater(sup) is not old_updater
        self._assert_kept(env, sup, triggers)

    def test_the_fallback_to_waiting_after_a_failed_start_keeps_the_hand_off(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        sup, triggers, _now = self._hand_off(env, monkeypatch)
        old_updater = self._updater(sup)

        def failing_start(rt: Any, **kwargs: Any) -> None:
            raise OSError("cannot watch")

        monkeypatch.setattr(runtime, "start_runtime", failing_start)
        env.client.get_latest_config_revision.return_value = _revision(
            2, _settings(env.watch_dir, file_patterns=["*.txt"])
        )

        _deliver(sup, 2)

        # Neither config could start, so only the heartbeat and a new updater run.
        assert sup.rt is None and sup.waiting_reason is not None
        assert self._updater(sup) is not old_updater
        self._assert_kept(env, sup, triggers)

    def test_a_stop_after_the_window_by_the_clock_is_the_workers_until_a_tick_ends_it(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A late worker stops the service just before the window ends, and the service
        # loop notices the stop up to a second later, when the clock says it is over.
        sup, _triggers, now = self._hand_off(env, monkeypatch)
        now[0] += UPGRADE_HANDOFF_TIMEOUT_SECONDS + 0.3

        sup.stop(stopped_message="Service stopped")

        assert self._final_status_reason(env) == "auto_update"

    def test_a_tick_that_runs_during_the_stop_does_not_end_the_hand_off(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from data_hub_watcher.updater import upgrade_marker_path
        from data_hub_watcher.upgrade_worker import upgrade_request_path

        sup, triggers, now = self._hand_off(env, monkeypatch)
        updater = self._updater(sup)
        now[0] += UPGRADE_HANDOFF_TIMEOUT_SECONDS + 1
        env.client.get_update_info.reset_mock()
        ticks: list[Any] = []

        def final_heartbeat_with_a_tick(
            _watcher_id: str, payload: dict[str, Any], **_kw: Any
        ) -> Any:
            # A heartbeat tick that is still running when the stop begins reaches the
            # updater after the stop has chosen its reason.
            if payload["status"] == "stopped":
                ticks.append(updater.on_tick())
            return HeartbeatResponse(ok=True)

        env.client.send_heartbeat.side_effect = final_heartbeat_with_a_tick

        sup.stop(stopped_message="Service stopped")

        assert ticks == [None]
        assert self._final_status_reason(env) == "auto_update"
        assert EventType.UPDATE_FAILED.value not in self._flushed_event_types(env)
        # What the worker reads, and the next process's marker, are still there.
        assert upgrade_request_path(env.tmp_path).exists()
        assert upgrade_marker_path(env.tmp_path).exists()
        env.client.get_update_info.assert_not_called()
        assert triggers == [None]

    def test_a_tick_that_runs_while_the_uploads_finish_does_not_end_the_hand_off(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from data_hub_watcher.updater import upgrade_marker_path
        from data_hub_watcher.upgrade_worker import upgrade_request_path

        sup, triggers, now = self._hand_off(env, monkeypatch)
        assert sup.rt is not None
        updater = self._updater(sup)
        heartbeat = sup.rt.heartbeat
        now[0] += UPGRADE_HANDOFF_TIMEOUT_SECONDS + 1
        env.client.get_update_info.reset_mock()
        on_tick_results: list[Any] = []
        real_on_tick = updater.on_tick
        real_request_stop = sup.rt.uploader.request_stop

        def recording_on_tick() -> Any:
            on_tick_results.append(real_on_tick())
            return on_tick_results[-1]

        def request_stop_then_tick() -> None:
            # The heartbeat loop goes on ticking until the uploads have stopped, which can
            # take most of the stop's budget. A tick in that time reaches the updater after
            # the stop has chosen its reason, and while the window by the clock is over.
            real_request_stop()
            heartbeat._tick()

        monkeypatch.setattr(updater, "on_tick", recording_on_tick)
        monkeypatch.setattr(sup.rt.uploader, "request_stop", request_stop_then_tick)

        sup.stop(stopped_message="Service stopped")

        assert on_tick_results == [None]
        assert self._final_status_reason(env) == "auto_update"
        assert EventType.UPDATE_FAILED.value not in self._flushed_event_types(env)
        assert upgrade_request_path(env.tmp_path).exists()
        assert upgrade_marker_path(env.tmp_path).exists()
        env.client.get_update_info.assert_not_called()
        assert triggers == [None]

    def test_a_stop_after_the_tick_that_ended_the_hand_off_is_not_marked(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        sup, _triggers, now = self._hand_off(env, monkeypatch)
        now[0] += UPGRADE_HANDOFF_TIMEOUT_SECONDS
        self._tick(sup)

        sup.stop(stopped_message="Service stopped")

        assert self._final_status_reason(env) is None


class TestHeartbeatRevisionFields:
    def _loop(self, client: MagicMock, **kwargs: Any) -> HeartbeatLoop:
        return HeartbeatLoop(
            client=client,
            watcher_id=WATCHER_ID,
            interval_seconds=60,
            event_reporter=MagicMock(),
            instrument_id="inst-1",
            watch_directory="/tmp/watch",
            upload_mode="auto",
            **kwargs,
        )

    def test_payload_carries_applied_revision_and_reply_is_forwarded(self) -> None:
        client = MagicMock()
        client.send_heartbeat.return_value = HeartbeatResponse(ok=True, config_revision=7)
        seen: list[int | None] = []
        loop = self._loop(client, config_revision=lambda: 6, on_config_revision=seen.append)

        loop._send_heartbeat("watching")

        payload = client.send_heartbeat.call_args.args[1]
        assert payload["config_revision"] == 6
        assert "status_reason" not in payload
        assert seen == [7]

    def test_waiting_status_sends_reason(self) -> None:
        client = MagicMock()
        client.send_heartbeat.return_value = HeartbeatResponse(ok=True)
        loop = self._loop(client, status="waiting", status_reason="watch_directory not found: X")

        loop._tick()

        payload = client.send_heartbeat.call_args.args[1]
        assert payload["status"] == "waiting"
        assert payload["status_reason"] == "watch_directory not found: X"

    def test_failed_heartbeat_does_not_forward_a_revision(self) -> None:
        client = MagicMock()
        client.send_heartbeat.side_effect = ApiError("offline", status_code=0)
        seen: list[int | None] = []
        loop = self._loop(client, on_config_revision=seen.append)

        loop._send_heartbeat("watching")

        assert seen == []
