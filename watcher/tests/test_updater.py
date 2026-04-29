"""Unit tests for `data_hub_watcher.updater`.

The updater drives unattended self-updates from inside the running
service, so a wrong decision here can take a fleet of lab PCs down at
the wrong moment. These tests pin the activity-window decision matrix,
the on-disk marker round-trip, and the `Updater.on_tick` orchestration
without spinning up a real heartbeat loop or hitting the network.
"""

from __future__ import annotations
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from data_hub_watcher.api_client import ApiError
from data_hub_watcher.events import EventReporter, EventType
from data_hub_watcher.heartbeat import WatcherCounters
from data_hub_watcher.models import (
    InstrumentConfig,
    RunDetectionConfig,
    WatcherConfig,
    WatcherUpdateInfoResponse,
)
from data_hub_watcher.self_update import InstallMethod
from data_hub_watcher.updater import (
    UPGRADE_MARKER_FILENAME,
    Updater,
    UpdaterConfig,
    UpgradeMarkerOutcome,
    clear_upgrade_marker,
    evaluate_upgrade_marker,
    should_attempt_update,
    upgrade_marker_path,
    write_upgrade_marker,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _info(
    *,
    latest: str | None = "0.3.0",
    mandatory: bool = False,
) -> WatcherUpdateInfoResponse:
    return WatcherUpdateInfoResponse(
        latest_version=latest,
        channel="stable",
        mandatory=mandatory,
    )


def _make_config(
    tmp_path: Path,
    *,
    environment: str = "staging",
    stability_period_seconds: int = 5,
) -> WatcherConfig:
    watch_dir = tmp_path / "data"
    watch_dir.mkdir()
    (watch_dir / "RUN001_sample.csv").write_text("a,b\n1,2\n")
    instrument = InstrumentConfig(
        id="test-instrument",
        watch_directory=watch_dir,
        file_patterns=["*.csv"],
        upload_mode="auto",
        stability_period_seconds=stability_period_seconds,
        run_detection=RunDetectionConfig(pattern=r"^([^_]+)", recursive=False),
    )
    return WatcherConfig(
        version=1,
        environment=environment,  # type: ignore[arg-type]
        api_base_url="https://example.test/api/v1" if environment == "preview" else None,
        watcher_id="w-test",
        instrument=instrument,
    )


@dataclass
class _UpdaterHarness:
    """Bundle of mocks returned from `_make_updater`.

    Returning a dataclass (rather than a tuple) keeps the call sites
    readable when a test only cares about a subset of the collaborators
    and lets pyright see each field as `MagicMock` so `return_value` /
    `side_effect` assignments type-check cleanly.
    """

    updater: Updater
    client: MagicMock
    reporter: MagicMock
    state_db: MagicMock
    counters: WatcherCounters
    request_restart: MagicMock


def _make_updater(
    tmp_path: Path,
    *,
    cfg: WatcherConfig | None = None,
    client: MagicMock | None = None,
    upgrade_runner: Any = None,
    updater_cfg: UpdaterConfig | None = None,
) -> _UpdaterHarness:
    cfg = cfg or _make_config(tmp_path)
    client = client or MagicMock()
    reporter = MagicMock(spec=EventReporter)
    counters = WatcherCounters()
    state_db = MagicMock()
    state_db.last_run_reported_at.return_value = None
    request_restart = MagicMock()

    updater = Updater(
        client=client,
        reporter=reporter,
        counters=counters,
        state_db=state_db,
        cfg=cfg,
        config_dir=tmp_path / ".data-hub",
        request_upgrade_restart=request_restart,
        updater_cfg=updater_cfg
        or UpdaterConfig(
            idle_ticks_required=2,
            check_interval_ticks=3,
            min_run_age_seconds=10.0,
        ),
        upgrade_runner=upgrade_runner,
    )
    return _UpdaterHarness(
        updater=updater,
        client=client,
        reporter=reporter,
        state_db=state_db,
        counters=counters,
        request_restart=request_restart,
    )


def _success_completed_process() -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(
        args=["uv", "tool", "install", "--reinstall", "data-hub-watcher==0.3.0"],
        returncode=0,
        stdout="ok",
        stderr="",
    )


# ---------------------------------------------------------------------------
# should_attempt_update
# ---------------------------------------------------------------------------


class TestShouldAttemptUpdate:
    def test_no_target_means_no_update(self) -> None:
        ok, reason = should_attempt_update(
            _info(latest=None),
            current_version="0.1.0",
            idle_ticks=10,
            idle_ticks_required=2,
            last_run_age_seconds=None,
            min_run_age_seconds=10.0,
        )
        assert ok is False
        assert "no release info" in reason

    def test_already_at_target_means_no_update(self) -> None:
        ok, reason = should_attempt_update(
            _info(latest="0.1.0"),
            current_version="0.1.0",
            idle_ticks=10,
            idle_ticks_required=2,
            last_run_age_seconds=None,
            min_run_age_seconds=10.0,
        )
        assert ok is False
        assert "ahead of target" in reason

    def test_idle_window_required(self) -> None:
        ok, reason = should_attempt_update(
            _info(latest="0.3.0"),
            current_version="0.1.0",
            idle_ticks=1,
            idle_ticks_required=3,
            last_run_age_seconds=None,
            min_run_age_seconds=10.0,
        )
        assert ok is False
        assert "idle ticks" in reason

    def test_recent_run_blocks_update(self) -> None:
        ok, reason = should_attempt_update(
            _info(latest="0.3.0"),
            current_version="0.1.0",
            idle_ticks=10,
            idle_ticks_required=2,
            last_run_age_seconds=5.0,
            min_run_age_seconds=10.0,
        )
        assert ok is False
        assert "recent run" in reason

    def test_idle_and_quiet_triggers_update(self) -> None:
        ok, reason = should_attempt_update(
            _info(latest="0.3.0"),
            current_version="0.1.0",
            idle_ticks=10,
            idle_ticks_required=2,
            last_run_age_seconds=300.0,
            min_run_age_seconds=10.0,
        )
        assert ok is True
        assert "newer version" in reason

    def test_mandatory_overrides_activity_window(self) -> None:
        # A mandatory rollout fires even when uploads happened recently
        # and a run was reported a moment ago — the cost of a brief
        # outage is lower than running known-bad code.
        ok, reason = should_attempt_update(
            _info(latest="0.3.0", mandatory=True),
            current_version="0.1.0",
            idle_ticks=0,
            idle_ticks_required=2,
            last_run_age_seconds=1.0,
            min_run_age_seconds=10.0,
        )
        assert ok is True
        assert "mandatory" in reason

    def test_no_run_history_does_not_block(self) -> None:
        # `last_run_age_seconds=None` means the local state DB has never
        # recorded a run — the activity check should pass.
        ok, _reason = should_attempt_update(
            _info(latest="0.3.0"),
            current_version="0.1.0",
            idle_ticks=10,
            idle_ticks_required=2,
            last_run_age_seconds=None,
            min_run_age_seconds=10.0,
        )
        assert ok is True


# ---------------------------------------------------------------------------
# Marker round-trip
# ---------------------------------------------------------------------------


class TestUpgradeMarker:
    def test_round_trip_success(self, tmp_path: Path) -> None:
        write_upgrade_marker(tmp_path, target_version="0.3.0", previous_version="0.1.0")
        outcome = evaluate_upgrade_marker(tmp_path, current_version="0.3.0")
        assert outcome == UpgradeMarkerOutcome(
            found=True,
            succeeded=True,
            target_version="0.3.0",
            previous_version="0.1.0",
            reason="restarted into target version",
        )
        # Marker is consumed on read so a single failure isn't reported
        # over and over on each restart.
        assert not upgrade_marker_path(tmp_path).exists()

    def test_round_trip_failure(self, tmp_path: Path) -> None:
        write_upgrade_marker(tmp_path, target_version="0.3.0", previous_version="0.1.0")
        outcome = evaluate_upgrade_marker(tmp_path, current_version="0.1.0")
        assert outcome.found is True
        assert outcome.succeeded is False
        assert outcome.target_version == "0.3.0"
        assert outcome.previous_version == "0.1.0"
        assert "expected" in outcome.reason

    def test_no_marker_returns_no_op(self, tmp_path: Path) -> None:
        outcome = evaluate_upgrade_marker(tmp_path, current_version="0.1.0")
        assert outcome.found is False
        assert outcome.succeeded is None

    def test_corrupt_marker_classified_as_failure(self, tmp_path: Path) -> None:
        marker = upgrade_marker_path(tmp_path)
        tmp_path.mkdir(parents=True, exist_ok=True)
        marker.write_text("not-json", encoding="utf-8")
        outcome = evaluate_upgrade_marker(tmp_path, current_version="0.1.0")
        assert outcome.found is True
        assert outcome.succeeded is False
        assert "unreadable" in outcome.reason
        assert not marker.exists()

    def test_clear_is_idempotent(self, tmp_path: Path) -> None:
        clear_upgrade_marker(tmp_path)
        clear_upgrade_marker(tmp_path)


# ---------------------------------------------------------------------------
# Updater.on_tick
# ---------------------------------------------------------------------------


class TestUpdaterOnTick:
    def test_preview_environment_is_no_op(self, tmp_path: Path) -> None:
        cfg = _make_config(tmp_path, environment="preview")
        h = _make_updater(tmp_path, cfg=cfg)
        for _ in range(20):
            assert h.updater.on_tick() is None
        h.request_restart.assert_not_called()
        h.reporter.queue_event.assert_not_called()

    def test_first_ticks_are_no_op_until_check_interval(self, tmp_path: Path) -> None:
        h = _make_updater(tmp_path)
        # Below check_interval_ticks=3 we should not call the API at all.
        h.counters.last_files_uploaded = 0
        assert h.updater.on_tick() is None
        assert h.updater.on_tick() is None
        h.client.get_update_info.return_value = _info(latest="0.0.0+unknown")
        result = h.updater.on_tick()
        assert result is not None

    def test_busy_interval_resets_idle_counter(self, tmp_path: Path) -> None:
        h = _make_updater(
            tmp_path,
            updater_cfg=UpdaterConfig(
                idle_ticks_required=2,
                check_interval_ticks=2,
                min_run_age_seconds=1.0,
            ),
        )
        h.client.get_update_info.return_value = _info(latest="9.9.9")

        # Simulate: tick 1 idle, tick 2 busy (uploads happened).
        h.counters.last_files_uploaded = 0
        h.updater.on_tick()
        h.counters.last_files_uploaded = 5
        result = h.updater.on_tick()
        assert result is not None
        # idle_ticks (1) is below the required 2 because of the busy
        # interval, so the update must be deferred.
        assert result.attempted is False
        assert "idle ticks" in result.reason

    def test_api_error_is_reported_but_not_raised(self, tmp_path: Path) -> None:
        h = _make_updater(tmp_path)
        h.client.get_update_info.side_effect = ApiError("boom", status_code=500)
        h.counters.last_files_uploaded = 0
        for _ in range(2):
            h.updater.on_tick()
        # The 3rd tick triggers the API call which fails.
        result = h.updater.on_tick()
        assert result is not None
        assert result.attempted is False
        assert result.succeeded is False
        assert "API error" in result.reason

    def test_successful_upgrade_writes_marker_and_requests_restart(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        runner = MagicMock(return_value=_success_completed_process())
        h = _make_updater(tmp_path, upgrade_runner=runner)
        h.client.get_update_info.return_value = _info(latest="9.9.9")
        h.state_db.last_run_reported_at.return_value = None

        # detect_install_method should report a clean uv-tool install so
        # the upgrade is eligible.
        monkeypatch.setattr(
            "data_hub_watcher.updater.detect_install_method",
            lambda: InstallMethod.UV_TOOL,
        )

        # Burn the first two ticks to satisfy idle + check interval.
        h.counters.last_files_uploaded = 0
        h.updater.on_tick()
        h.updater.on_tick()
        result = h.updater.on_tick()

        assert result is not None
        assert result.attempted is True
        assert result.succeeded is True
        assert result.target_version == "9.9.9"
        runner.assert_called_once()
        h.request_restart.assert_called_once_with("9.9.9")

        # The marker must be on disk so the next process startup can
        # detect whether the upgrade actually took.
        marker = tmp_path / ".data-hub" / UPGRADE_MARKER_FILENAME
        assert marker.exists()
        data = json.loads(marker.read_text(encoding="utf-8"))
        assert data["target_version"] == "9.9.9"

        # An UPDATE_STARTED event must have been queued before the
        # subprocess ran so the dashboard sees the start even if the
        # subprocess hangs.
        emitted = [c.args[0].event_type for c in h.reporter.queue_event.call_args_list]
        assert EventType.UPDATE_STARTED in emitted
        # UPDATE_SUCCEEDED is intentionally deferred to the post-restart
        # marker evaluation, not emitted here.
        assert EventType.UPDATE_SUCCEEDED not in emitted

    def test_failed_upgrade_subprocess_emits_update_failed(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        runner = MagicMock(
            return_value=subprocess.CompletedProcess(
                args=["x"], returncode=1, stdout="", stderr="kaboom"
            )
        )
        h = _make_updater(tmp_path, upgrade_runner=runner)
        h.client.get_update_info.return_value = _info(latest="9.9.9")
        monkeypatch.setattr(
            "data_hub_watcher.updater.detect_install_method",
            lambda: InstallMethod.UV_TOOL,
        )

        h.counters.last_files_uploaded = 0
        h.updater.on_tick()
        h.updater.on_tick()
        result = h.updater.on_tick()

        assert result is not None
        assert result.attempted is True
        assert result.succeeded is False
        h.request_restart.assert_not_called()
        # The marker is cleared on a known-failed in-process upgrade so
        # the next startup doesn't double-report it.
        assert not (tmp_path / ".data-hub" / UPGRADE_MARKER_FILENAME).exists()
        emitted = [c.args[0].event_type for c in h.reporter.queue_event.call_args_list]
        assert EventType.UPDATE_FAILED in emitted

    def test_editable_install_refuses_auto_update(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        runner = MagicMock(return_value=_success_completed_process())
        h = _make_updater(tmp_path, upgrade_runner=runner)
        h.client.get_update_info.return_value = _info(latest="9.9.9")
        monkeypatch.setattr(
            "data_hub_watcher.updater.detect_install_method",
            lambda: InstallMethod.EDITABLE,
        )

        h.counters.last_files_uploaded = 0
        h.updater.on_tick()
        h.updater.on_tick()
        result = h.updater.on_tick()

        assert result is not None
        assert result.attempted is True
        assert result.succeeded is False
        # An editable checkout must not be silently overwritten by an
        # index build.
        runner.assert_not_called()
        h.request_restart.assert_not_called()
