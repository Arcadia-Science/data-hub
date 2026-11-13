"""A running or waiting watcher whose registration was deleted on Data Hub stops (watcher 1.4.3).

Runs a real `WatcherSupervisor` (real state DB, monitor and heartbeat loop) against a mocked
client. The heartbeat's tick is driven by hand, so the tests don't wait for the interval: a
tick sends one heartbeat, as the loop's thread does every minute. Only the server's
"deregistered" reply (a 404 with the code `WATCHER_DEREGISTERED`) counts. A plain `NOT_FOUND`
is a watcher ID the server has no row for, and it stops nothing.
"""

from __future__ import annotations
import threading
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from data_hub_watcher import runtime, testing_overrides
from data_hub_watcher.api_client import ApiError
from data_hub_watcher.config_io import save_config
from data_hub_watcher.constants import DEREGISTERED_HEARTBEAT_THRESHOLD
from data_hub_watcher.events import EventType, WatcherEvent
from data_hub_watcher.models import (
    ApiErrorDetail,
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


def _deregistered() -> ApiError:
    return ApiError(
        f"Watcher '{WATCHER_ID}' was deregistered",
        status_code=404,
        detail=ApiErrorDetail(
            code="WATCHER_DEREGISTERED", message=f"Watcher '{WATCHER_ID}' was deregistered"
        ),
    )


def _plain_not_found() -> ApiError:
    return ApiError(
        f"Watcher '{WATCHER_ID}' not found",
        status_code=404,
        detail=ApiErrorDetail(code="NOT_FOUND", message=f"Watcher '{WATCHER_ID}' not found"),
    )


def _revision(number: int, watch_dir: Path, **overrides: Any) -> ConfigRevisionResponse:
    """A pending web revision of the settings the test supervisor starts with."""
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
    return ConfigRevisionResponse(
        revision=number,
        source="web",
        status="pending",
        settings=settings,
        created_at=datetime.now(timezone.utc),
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
        self.client = MagicMock(name="DataHubClient")
        self.client.get_config_checksum.return_value = None
        self.client.push_config.return_value = ConfigChecksumResponse(config_checksum="sha256:x")
        self.client.get_latest_config_revision.return_value = None
        self.client.send_heartbeat.return_value = HeartbeatResponse(ok=True)
        self.supervisors: list[WatcherSupervisor] = []

    def supervisor(self) -> WatcherSupervisor:
        cfg = WatcherConfig(
            version=1,
            environment="staging",
            api_base_urls={"staging": "https://staging.example.test/api/v1"},
            watcher_ids={"staging": WATCHER_ID},
            # The file that is already there is baselined, so the test doesn't race an upload.
            initial_scan="new-only",
            instrument=InstrumentConfig(
                id="test-instrument",
                watch_directory=self.watch_dir,
                file_patterns=["*.csv"],
                upload_mode="auto",
                run_detection=RunDetectionConfig(pattern=r"^([^_]+)", recursive=False),
            ),
        )
        save_config(cfg, self.config_path)
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

    def heartbeat_statuses(self) -> list[str]:
        return [c.args[1]["status"] for c in self.client.send_heartbeat.call_args_list]

    def sent_event_types(self) -> list[str]:
        return [e["event_type"] for c in self.client.send_events.call_args_list for e in c.args[1]]


@pytest.fixture
def env(tmp_path: Path) -> Iterator[_Env]:
    e = _Env(tmp_path)
    try:
        yield e
    finally:
        for sup in e.supervisors:
            if sup.rt is not None or sup.waiting_reason is not None:
                sup.stop(stopped_message="test teardown")


def _tick(sup: WatcherSupervisor, times: int = 1) -> None:
    """Run the heartbeat tick of the running or waiting loop, as its thread does each interval."""
    for _ in range(times):
        if sup.rt is not None:
            sup.rt.heartbeat._tick()
        else:
            assert sup._waiting is not None
            sup._waiting.heartbeat._tick()


@pytest.fixture
def closes(monkeypatch: pytest.MonkeyPatch) -> list[StateDB]:
    """Every `StateDB` that was closed, in order."""
    closed: list[StateDB] = []
    original = StateDB.close

    def close(self: StateDB) -> None:
        closed.append(self)
        original(self)

    monkeypatch.setattr(StateDB, "close", close)
    return closed


class TestRunningWatcher:
    def test_three_deregistered_heartbeats_in_a_row_stop_it(self, env: _Env) -> None:
        sup = env.supervisor()
        sup.start()
        env.client.send_heartbeat.side_effect = _deregistered()

        _tick(sup, DEREGISTERED_HEARTBEAT_THRESHOLD - 1)
        assert sup.poll(timeout=0) is False
        assert not sup.deregistered_event.is_set()
        _tick(sup)

        assert sup.poll(timeout=0) is True
        assert sup.deregistered_event.is_set()
        decision = sup.classify_shutdown()
        assert decision.is_deregistered is True
        assert decision.is_upgrade_restart is False

    def test_two_deregistered_heartbeats_then_a_success_do_not_stop_it(self, env: _Env) -> None:
        sup = env.supervisor()
        sup.start()
        replies: list[Any] = [_deregistered(), _deregistered(), HeartbeatResponse(ok=True)]
        env.client.send_heartbeat.side_effect = replies

        _tick(sup, 3)
        env.client.send_heartbeat.side_effect = [_deregistered(), _deregistered()]
        _tick(sup, 2)

        assert sup.poll(timeout=0) is False
        assert not sup.deregistered_event.is_set()
        assert sup.classify_shutdown().is_deregistered is False

    def test_three_plain_not_found_heartbeats_in_a_row_do_not_stop_it(self, env: _Env) -> None:
        sup = env.supervisor()
        sup.start()
        assert sup.rt is not None
        uploader = sup.rt.uploader
        env.client.send_heartbeat.side_effect = _plain_not_found()

        # A watcher ID that the server has no row for, as after its database was restored to
        # an older point: the heartbeats fail, and the watcher keeps running.
        _tick(sup, DEREGISTERED_HEARTBEAT_THRESHOLD + 3)

        assert sup.poll(timeout=0) is False
        assert not sup.deregistered_event.is_set()
        assert not uploader._stop_requested()
        assert sup.classify_shutdown().is_deregistered is False

    def test_a_plain_not_found_in_the_run_starts_the_count_again(self, env: _Env) -> None:
        sup = env.supervisor()
        sup.start()
        replies: list[Any] = [
            _deregistered(),
            _deregistered(),
            _plain_not_found(),
            _deregistered(),
            _deregistered(),
        ]
        env.client.send_heartbeat.side_effect = replies

        _tick(sup, len(replies))

        assert sup.poll(timeout=0) is False
        assert not sup.deregistered_event.is_set()

    def test_uploads_are_stopped_as_soon_as_the_loop_knows(self, env: _Env) -> None:
        sup = env.supervisor()
        sup.start()
        assert sup.rt is not None
        uploader = sup.rt.uploader
        env.client.send_heartbeat.side_effect = _deregistered()

        _tick(sup, DEREGISTERED_HEARTBEAT_THRESHOLD - 1)
        assert not uploader._stop_requested()
        _tick(sup)

        # Before the main thread has polled or stopped anything.
        assert uploader._stop_requested()
        # Only a stop, not an abort that would cut off the uploads in progress: that is done by
        # the stop itself.
        assert not uploader._abort.is_set()

    @pytest.mark.parametrize(
        "stop_kwargs",
        [{}, {"operator_stop": True}, {"system_shutdown": True}],
        ids=["plain", "operator", "windows-shutdown"],
    )
    def test_its_stop_sends_no_event_and_no_stopped_heartbeat(
        self, env: _Env, stop_kwargs: dict[str, bool]
    ) -> None:
        sup = env.supervisor()
        sup.start()
        env.client.send_heartbeat.side_effect = _deregistered()
        _tick(sup, DEREGISTERED_HEARTBEAT_THRESHOLD)
        assert sup.poll(timeout=0) is True
        assert sup.rt is not None
        # An event that is waiting to be sent must not be flushed by the stop either.
        sup.reporter.queue_event(
            WatcherEvent(event_type=EventType.CONFIG_SYNCED, message="queued before the stop")
        )
        heartbeats = env.client.send_heartbeat.call_count
        events = env.client.send_events.call_count

        sup.stop(stopped_message="Watcher stopped: its registration was deleted", **stop_kwargs)

        # Not one request more: both would get the same 404.
        assert env.client.send_heartbeat.call_count == heartbeats
        assert env.client.send_events.call_count == events
        assert "stopped" not in env.heartbeat_statuses()
        assert EventType.WATCHER_STOPPED.value not in env.sent_event_types()
        assert sup.rt is None

    def test_the_tick_that_sees_the_third_reply_sends_no_events(self, env: _Env) -> None:
        sup = env.supervisor()
        sup.start()
        env.client.send_heartbeat.side_effect = _deregistered()
        _tick(sup, DEREGISTERED_HEARTBEAT_THRESHOLD - 1)
        events = env.client.send_events.call_count

        _tick(sup)

        # The first two ticks flushed, as ever. The third would only get the same 404.
        assert env.client.send_events.call_count == events

    def test_its_stop_closes_the_state_databases(self, env: _Env, closes: list[StateDB]) -> None:
        sup = env.supervisor()
        sup.start()
        assert sup.rt is not None
        runtime_state = sup.rt.state_db
        env.client.send_heartbeat.side_effect = _deregistered()
        _tick(sup, DEREGISTERED_HEARTBEAT_THRESHOLD)
        closes.clear()

        sup.stop(stopped_message="Watcher stopped: its registration was deleted")

        # The runtime's and the supervisor's own, which outlives the runtimes.
        assert runtime_state in closes
        assert sup._state in closes

    def test_its_stop_aborts_the_uploader(self, env: _Env) -> None:
        sup = env.supervisor()
        sup.start()
        assert sup.rt is not None
        uploader = sup.rt.uploader
        env.client.send_heartbeat.side_effect = _deregistered()
        _tick(sup, DEREGISTERED_HEARTBEAT_THRESHOLD)

        sup.stop(stopped_message="Watcher stopped: its registration was deleted")

        # The stop cut the uploads off, as one for a Windows shutdown does, instead of
        # waiting for the parts in flight to finish. (`Uploader.abort` is what bounds that
        # wait; its own tests cover how it cuts a PUT off.)
        assert uploader._abort.is_set()

    def test_a_watcher_that_is_not_deregistered_still_stops_with_both(self, env: _Env) -> None:
        sup = env.supervisor()
        sup.start()

        sup.stop(stopped_message="Watcher stopped")

        assert env.heartbeat_statuses()[-1] == "stopped"
        assert EventType.WATCHER_STOPPED.value in env.sent_event_types()


def _waiting_supervisor(env: _Env) -> WatcherSupervisor:
    """A supervisor in the waiting state: its watch folder is missing."""
    sup = env.supervisor()
    env.watch_dir.rename(env.tmp_path / "moved-away")
    sup.start()
    assert sup.rt is None
    assert sup.waiting_reason is not None
    return sup


def _bring_the_folder_back(env: _Env) -> None:
    (env.tmp_path / "moved-away").rename(env.watch_dir)


class TestWaitingWatcher:
    _waiting = staticmethod(_waiting_supervisor)

    def test_three_deregistered_heartbeats_in_a_row_stop_it_too(self, env: _Env) -> None:
        sup = self._waiting(env)
        env.client.send_heartbeat.side_effect = _deregistered()

        _tick(sup, DEREGISTERED_HEARTBEAT_THRESHOLD - 1)
        assert sup.poll(timeout=0) is False
        _tick(sup)

        assert sup.poll(timeout=0) is True
        assert sup.classify_shutdown().is_deregistered is True

    def test_two_deregistered_heartbeats_then_a_success_do_not_stop_it(self, env: _Env) -> None:
        sup = self._waiting(env)
        env.client.send_heartbeat.side_effect = [
            _deregistered(),
            _deregistered(),
            HeartbeatResponse(ok=True),
            _deregistered(),
            _deregistered(),
        ]

        _tick(sup, 5)

        assert sup.poll(timeout=0) is False
        assert sup.classify_shutdown().is_deregistered is False

    def test_three_plain_not_found_heartbeats_in_a_row_do_not_stop_it(self, env: _Env) -> None:
        sup = self._waiting(env)
        env.client.send_heartbeat.side_effect = _plain_not_found()

        _tick(sup, DEREGISTERED_HEARTBEAT_THRESHOLD + 3)

        assert sup.poll(timeout=0) is False
        assert sup.classify_shutdown().is_deregistered is False

    def test_its_stop_sends_no_event_and_no_stopped_heartbeat(
        self, env: _Env, closes: list[StateDB]
    ) -> None:
        sup = self._waiting(env)
        env.client.send_heartbeat.side_effect = _deregistered()
        _tick(sup, DEREGISTERED_HEARTBEAT_THRESHOLD)
        assert sup.poll(timeout=0) is True
        heartbeats = env.client.send_heartbeat.call_count
        events = env.client.send_events.call_count
        closes.clear()

        sup.stop(stopped_message="Watcher stopped: its registration was deleted")

        assert env.client.send_heartbeat.call_count == heartbeats
        assert env.client.send_events.call_count == events
        assert "stopped" not in env.heartbeat_statuses()
        assert sup.waiting_reason is None
        assert closes == [sup._state]

    def test_the_waiting_loop_ends_itself_and_logs_the_error_once(
        self, env: _Env, caplog: pytest.LogCaptureFixture
    ) -> None:
        sup = self._waiting(env)
        assert sup._waiting is not None
        heartbeat = sup._waiting.heartbeat
        env.client.send_heartbeat.side_effect = _deregistered()

        with caplog.at_level("ERROR"):
            _tick(sup, DEREGISTERED_HEARTBEAT_THRESHOLD + 2)

        assert heartbeat._stop_event.is_set()
        errors = [r.getMessage() for r in caplog.records if "deregistered" in r.getMessage()]
        assert len(errors) == 1
        assert "data-hub-watcher init" in errors[0]


@pytest.fixture
def builds(monkeypatch: pytest.MonkeyPatch) -> list[WatcherConfig]:
    """One entry for every runtime that `WatcherSupervisor` builds from now on."""
    built: list[WatcherConfig] = []
    original = runtime.build_runtime

    def spy(*args: Any, **kwargs: Any) -> Any:
        built.append(kwargs["cfg"])
        return original(*args, **kwargs)

    monkeypatch.setattr(runtime, "build_runtime", spy)
    return built


def _arrives_while_the_loops_stop(
    monkeypatch: pytest.MonkeyPatch, env: _Env, sup: WatcherSupervisor
) -> None:
    """Make the third "deregistered" reply arrive while `_teardown_for_rebuild` is running.

    A rebuild can wait up to 2 minutes for uploads to drain and the heartbeat loop to stop, and
    the loop is still ticking then.
    """
    original = sup._teardown_for_rebuild

    def teardown() -> None:
        env.client.send_heartbeat.side_effect = _deregistered()
        _tick(sup, DEREGISTERED_HEARTBEAT_THRESHOLD)
        original()

    monkeypatch.setattr(sup, "_teardown_for_rebuild", teardown)


class TestARebuildThatOverlapsIt:
    """The third reply comes in while a rebuild has stopped the old loops and is about to build.

    The watcher must then build nothing: a new runtime would retry its pending uploads and scan
    and upload the backlog while the watcher stops.
    """

    def test_a_config_rebuild_builds_no_runtime(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch, builds: list[WatcherConfig]
    ) -> None:
        sup = env.supervisor()
        sup.start()
        assert len(builds) == 1
        _arrives_while_the_loops_stop(monkeypatch, env, sup)
        pushes = env.client.push_config.call_count

        applied = sup._apply(_revision(1, env.watch_dir, stability_period_seconds=7))

        assert applied is False
        assert sup.deregistered_event.is_set()
        # No new runtime, and no waiting loop either.
        assert len(builds) == 1
        assert sup.rt is None
        assert sup._waiting is None
        # The revision is not recorded or reported as applied, and the config is not pushed:
        # nothing runs it, and the server would answer each with the same 404.
        assert sup.applied_revision is None
        env.client.report_config_revision_result.assert_not_called()
        assert env.client.push_config.call_count == pushes

    def test_the_watcher_then_stops_without_sending_anything(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        sup = env.supervisor()
        sup.start()
        _arrives_while_the_loops_stop(monkeypatch, env, sup)
        sup._apply(_revision(1, env.watch_dir, stability_period_seconds=7))
        assert sup.poll(timeout=0) is True
        heartbeats = env.client.send_heartbeat.call_count
        events = env.client.send_events.call_count

        sup.stop(stopped_message="Watcher stopped: its registration was deleted")

        assert env.client.send_heartbeat.call_count == heartbeats
        assert env.client.send_events.call_count == events
        assert "stopped" not in env.heartbeat_statuses()

    def test_a_waiting_watcher_whose_folder_came_back_builds_no_runtime(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch, builds: list[WatcherConfig]
    ) -> None:
        sup = _waiting_supervisor(env)
        _bring_the_folder_back(env)
        _arrives_while_the_loops_stop(monkeypatch, env, sup)

        sup._check_waiting_folder()

        assert sup.deregistered_event.is_set()
        assert builds == []
        assert sup.rt is None
        assert sup._waiting is None

    def test_a_failed_start_enters_no_waiting_loop(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        sup = env.supervisor()
        sup.start()
        sup._teardown_for_rebuild()
        heartbeats = env.client.send_heartbeat.call_count

        def start_that_fails_as_the_third_reply_arrives(**_kwargs: Any) -> None:
            sup.deregistered_event.set()
            raise RuntimeError("could not start")

        monkeypatch.setattr(
            sup, "_start_watching_or_wait", start_that_fails_as_the_third_reply_arrives
        )

        sup._start_or_wait_on_error(started_message="Watcher restarted")

        assert sup._waiting is None
        assert sup.rt is None
        # A waiting loop would have sent its first heartbeat at once.
        assert env.client.send_heartbeat.call_count == heartbeats

    def test_nothing_is_built_once_it_has_been_deregistered(
        self, env: _Env, builds: list[WatcherConfig]
    ) -> None:
        sup = env.supervisor()
        sup.start()
        sup._teardown_for_rebuild()
        built = len(builds)
        heartbeats = env.client.send_heartbeat.call_count
        sup.deregistered_event.set()

        sup._start_watching_or_wait(started_message="Watcher restarted")
        sup._enter_waiting("watch folder is missing", started_message="Watcher restarted")

        assert len(builds) == built
        assert sup.rt is None
        assert sup._waiting is None
        assert env.client.send_heartbeat.call_count == heartbeats

    def test_a_waiting_watcher_that_is_stopping_does_not_start_watching(
        self, env: _Env, builds: list[WatcherConfig]
    ) -> None:
        sup = _waiting_supervisor(env)
        env.client.send_heartbeat.side_effect = _deregistered()
        _tick(sup, DEREGISTERED_HEARTBEAT_THRESHOLD)
        _bring_the_folder_back(env)

        sup._check_waiting_folder()

        # Its loop is left for the stop, and no runtime is built.
        assert sup._waiting is not None
        assert builds == []


class TestTheCountSurvivesStateChanges:
    """Each switch builds a new heartbeat loop, and the run of replies goes on across them.

    A watcher that keeps changing state, or whose network share drops out every couple of
    minutes, would otherwise postpone its stop for good.
    """

    def test_a_waiting_watcher_that_starts_watching_keeps_the_count(self, env: _Env) -> None:
        sup = _waiting_supervisor(env)
        env.client.send_heartbeat.side_effect = _deregistered()
        _tick(sup, DEREGISTERED_HEARTBEAT_THRESHOLD - 1)
        assert not sup.deregistered_event.is_set()
        _bring_the_folder_back(env)

        # The new loop's first heartbeat is the third reply in a row.
        sup._check_waiting_folder()

        assert sup.deregistered_event.is_set()
        assert sup.poll(timeout=0) is True
        assert sup.classify_shutdown().is_deregistered is True

    def test_a_config_rebuild_keeps_the_count(self, env: _Env) -> None:
        sup = env.supervisor()
        sup.start()
        env.client.send_heartbeat.side_effect = _deregistered()
        _tick(sup, DEREGISTERED_HEARTBEAT_THRESHOLD - 1)
        assert not sup.deregistered_event.is_set()

        sup._apply(_revision(1, env.watch_dir, stability_period_seconds=7))

        assert sup.deregistered_event.is_set()
        assert sup.poll(timeout=0) is True

    def test_a_failed_start_that_falls_back_to_waiting_keeps_the_count(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        sup = env.supervisor()
        sup.start()
        env.client.send_heartbeat.side_effect = _deregistered()
        _tick(sup, DEREGISTERED_HEARTBEAT_THRESHOLD - 1)
        sup._teardown_for_rebuild()

        def failing_start(**_kwargs: Any) -> None:
            raise RuntimeError("could not start")

        monkeypatch.setattr(sup, "_start_watching_or_wait", failing_start)
        sup._start_or_wait_on_error(started_message="Watcher restarted")

        # The waiting loop's first heartbeat is the third reply in a row.
        assert sup.deregistered_event.is_set()
        assert sup.poll(timeout=0) is True

    def test_a_success_in_a_new_loop_starts_the_count_again(self, env: _Env) -> None:
        sup = _waiting_supervisor(env)
        env.client.send_heartbeat.side_effect = _deregistered()
        _tick(sup, DEREGISTERED_HEARTBEAT_THRESHOLD - 1)
        _bring_the_folder_back(env)
        env.client.send_heartbeat.side_effect = None
        env.client.send_heartbeat.return_value = HeartbeatResponse(ok=True)

        sup._check_waiting_folder()
        env.client.send_heartbeat.side_effect = _deregistered()
        _tick(sup, DEREGISTERED_HEARTBEAT_THRESHOLD - 1)

        assert not sup.deregistered_event.is_set()
        assert sup.poll(timeout=0) is False


class TestTheLoopThread:
    def test_the_loop_thread_stops_the_watcher_without_help(
        self, env: _Env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # With a real heartbeat thread and a short interval, as the end-to-end suite uses.
        monkeypatch.setenv(testing_overrides.HEARTBEAT_INTERVAL_ENV_VAR, "1")
        sup = env.supervisor()
        sup.start()
        env.client.send_heartbeat.side_effect = _deregistered()
        woke = threading.Event()

        def poll_until_stop() -> None:
            while not sup.poll(timeout=0.2):
                pass
            woke.set()

        thread = threading.Thread(target=poll_until_stop, daemon=True)
        thread.start()

        assert woke.wait(15), "the supervisor never saw the watcher stop"
        thread.join(5)
        assert sup.classify_shutdown().is_deregistered is True
