"""Unit tests for config revisions from the web app (watcher 1.3.0).

Covers `runtime.WatcherSupervisor` end to end against a mocked API client:
applying a revision by rebuilding the runtime in the same process, rejecting a
revision whose folder is missing, the waiting state, and the startup sync. The
runtimes are real (real `StateDB`, monitor and heartbeat threads) so the tests
exercise the actual rebuild, not a stand-in.
"""

from __future__ import annotations
import logging
import os
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest
import yaml

from data_hub_watcher import runtime
from data_hub_watcher.api_client import ApiError, DataHubClient
from data_hub_watcher.config_io import save_config
from data_hub_watcher.events import EventType
from data_hub_watcher.heartbeat import HeartbeatLoop
from data_hub_watcher.models import (
    ConfigChecksumResponse,
    ConfigRevisionResponse,
    HeartbeatResponse,
    InstrumentConfig,
    RunDetectionConfig,
    WatcherConfig,
)
from data_hub_watcher.runtime import WatcherSupervisor
from data_hub_watcher.state import StateDB

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
    client.list_config_revisions.return_value = []
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

    def supervisor(self, cfg: WatcherConfig | None = None) -> WatcherSupervisor:
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
        sup.start()
        real_start = runtime.start_runtime
        attempts: list[list[str]] = []

        def flaky_start(rt: Any, *, started_message: str) -> None:
            attempts.append(list(rt.monitor._patterns))
            if len(attempts) == 1:
                raise OSError("cannot watch")
            real_start(rt, started_message=started_message)

        monkeypatch.setattr(runtime, "start_runtime", flaky_start)
        env.client.get_latest_config_revision.return_value = _revision(
            2, _settings(env.watch_dir, file_patterns=["*.txt"])
        )

        _deliver(sup, 2)

        assert attempts == [["*.txt"], ["*.csv"]]
        assert sup.rt is not None
        assert sup.cfg.instrument.file_patterns == ["*.csv"]
        assert env.saved_instrument()["file_patterns"] == ["*.csv"]
        [(_, number, status, reason)] = env.results()
        assert (number, status) == (2, "rejected")
        assert "cannot watch" in reason
        assert sup.applied_revision is None


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

    def test_config_still_loads_with_a_missing_folder(self, env: _Env) -> None:
        from data_hub_watcher.config_io import load_config

        self._missing_cfg(env)

        cfg = load_config(env.config_path)

        assert cfg.instrument.watch_directory == (env.tmp_path / "later").resolve()


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

        def record_start(rt: Any, *, started_message: str) -> None:
            calls.append(("start", list(rt.monitor._patterns)))
            real_start(rt, started_message=started_message)

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

    def test_offline_conflict_won_by_web_finds_the_pending_revision(self, env: _Env) -> None:
        # The server kept the web revision (4) pending and stored the PC's
        # edit after it (5) as superseded.
        env.client.push_config.return_value = ConfigChecksumResponse(
            config_checksum="sha256:x", config_revision=5
        )
        env.client.get_latest_config_revision.return_value = _revision(
            5, _settings(env.watch_dir), status="superseded", source="pc"
        )
        web = _revision(4, _settings(env.watch_dir, file_patterns=["*.txt"]))
        env.client.list_config_revisions.return_value = [
            _revision(5, _settings(env.watch_dir), status="superseded", source="pc"),
            web,
        ]
        sup = env.supervisor()

        sup.start()

        assert sup.cfg.instrument.file_patterns == ["*.txt"]
        assert (WATCHER_ID, 4, "applied", None) in env.results()


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
            assert client.list_config_revisions("w-1") == []

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
