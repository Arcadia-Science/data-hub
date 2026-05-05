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
import threading
import time
from collections.abc import Callable
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


def _inline_executor(fn: Callable[[], None]) -> None:
    """Synchronous executor used by the test harness.

    Calling ``fn()`` inline (instead of spawning a daemon thread)
    keeps assertions that depend on subprocess outcomes deterministic
    without explicit thread joins.
    """
    fn()


def _make_updater(
    tmp_path: Path,
    *,
    cfg: WatcherConfig | None = None,
    client: MagicMock | None = None,
    upgrade_runner: Any = None,
    updater_cfg: UpdaterConfig | None = None,
    upgrade_executor: Callable[[Callable[[], None]], None] = _inline_executor,
) -> _UpdaterHarness:
    cfg = cfg or _make_config(tmp_path)
    client = client or MagicMock()
    reporter = MagicMock(spec=EventReporter)
    counters = WatcherCounters()
    state_db = MagicMock()
    state_db.last_run_reported_at.return_value = None
    request_restart = MagicMock()

    # Default to an inline (synchronous) upgrade executor so the
    # majority of tests can assert on subprocess outcomes without
    # threading. Tests that exercise the async dispatch path opt in
    # by passing the production threading executor explicitly.
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
        upgrade_executor=upgrade_executor,
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

    def test_update_check_failed_event_after_three_consecutive_failures(
        self, tmp_path: Path
    ) -> None:
        """A single API blip should not page anyone — but a sustained
        outage that blocks 3 consecutive hourly checks (~3h dark on
        the update channel) must be visible centrally so an admin can
        unblock mandatory rollouts."""
        h = _make_updater(
            tmp_path,
            updater_cfg=UpdaterConfig(
                idle_ticks_required=0,
                check_interval_ticks=1,  # fire on every tick
                min_run_age_seconds=0.0,
            ),
        )
        h.client.get_update_info.side_effect = ApiError("dead", status_code=502)
        h.counters.last_files_uploaded = 0

        h.updater.on_tick()  # failure 1 -> no event
        h.updater.on_tick()  # failure 2 -> no event
        # No throttled event yet.
        kinds_so_far = [c.args[0] for c in h.reporter.report_error.call_args_list]
        assert "update_check_failed" not in kinds_so_far

        h.updater.on_tick()  # failure 3 -> emits

        kinds_after = [c.args[0] for c in h.reporter.report_error.call_args_list]
        assert kinds_after.count("update_check_failed") == 1
        call = next(
            c for c in h.reporter.report_error.call_args_list if c.args[0] == "update_check_failed"
        )
        assert call.kwargs["consecutive_failures"] == 3
        assert "dead" in call.kwargs["error"]

    def test_update_check_failure_counter_resets_on_success(self, tmp_path: Path) -> None:
        h = _make_updater(
            tmp_path,
            updater_cfg=UpdaterConfig(
                idle_ticks_required=0,
                check_interval_ticks=1,
                min_run_age_seconds=0.0,
            ),
        )
        # 2 failures, then a success, then 2 more failures.
        h.client.get_update_info.side_effect = [
            ApiError("dead", status_code=502),
            ApiError("dead", status_code=502),
            _info(latest="0.0.0+unknown"),
            ApiError("dead", status_code=502),
            ApiError("dead", status_code=502),
        ]
        h.counters.last_files_uploaded = 0

        for _ in range(5):
            h.updater.on_tick()

        # The post-success burst is only 2 failures so no event yet —
        # the success in between resets the consecutive counter.
        kinds = [c.args[0] for c in h.reporter.report_error.call_args_list]
        assert "update_check_failed" not in kinds

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

    def test_subprocess_output_is_logged_at_info_even_on_success(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        # Defence in depth: a partial install can update some Python
        # files (fooling the post-restart marker comparison) while
        # uv exits with a non-zero code or prints a meaningful
        # warning to stderr. Even on the apparent-success path we
        # MUST mirror the captured output to ``watcher.log`` so an
        # operator can recover the actual installer transcript when
        # the dashboard event is misleading. Historically this gap
        # is what made the "Scripts directory locked" failure
        # invisible until someone ran the upgrade by hand.
        runner = MagicMock(
            return_value=subprocess.CompletedProcess(
                args=["uv"],
                returncode=0,
                stdout="Installed 17 packages\n+ data-hub-watcher==9.9.9",
                stderr="warning: index format is deprecated",
            )
        )
        h = _make_updater(tmp_path, upgrade_runner=runner)
        h.client.get_update_info.return_value = _info(latest="9.9.9")
        monkeypatch.setattr(
            "data_hub_watcher.updater.detect_install_method",
            lambda: InstallMethod.UV_TOOL,
        )

        h.counters.last_files_uploaded = 0
        with caplog.at_level("INFO", logger="data_hub_watcher.updater"):
            h.updater.on_tick()
            h.updater.on_tick()
            h.updater.on_tick()

        log_text = "\n".join(r.getMessage() for r in caplog.records)
        assert "Installed 17 packages" in log_text
        # stderr is logged separately so a regression that only
        # captured one stream surfaces here.
        assert "warning: index format is deprecated" in log_text
        # On success we still emit the "requesting service restart"
        # line — these tests are specifically that the output is
        # *also* logged.
        assert "requesting service restart" in log_text

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

    def test_upgrade_runner_raising_file_not_found_is_classified(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Reproduces the failure that prompted this change: on a Windows
        # LocalSystem service `subprocess.run(["uv", ...])` raises
        # FileNotFoundError because the service account's PATH doesn't
        # see the user's uv install. Previously this surfaced as the
        # opaque `subprocess raised: [WinError 2] ...` reason with no
        # argv or error class attached — now we classify the branch and
        # attach both so operators can diagnose from the dashboard
        # without needing to open `watcher.log` on the PC.
        winerror2 = FileNotFoundError("[WinError 2] The system cannot find the file specified")
        runner = MagicMock(side_effect=winerror2)
        h = _make_updater(tmp_path, upgrade_runner=runner)
        h.client.get_update_info.return_value = _info(latest="9.9.9")
        monkeypatch.setattr(
            "data_hub_watcher.updater.detect_install_method",
            lambda: InstallMethod.UV_TOOL,
        )
        # Force the command-build to succeed regardless of whether the
        # test host has `uv` on PATH, so we're testing the FileNotFound
        # branch from the subprocess call — not the pre-flight
        # UvExecutableNotFoundError branch (which is exercised in the
        # next test).
        monkeypatch.setattr(
            "data_hub_watcher.updater.build_upgrade_command",
            lambda method, target_version=None: [
                "/fake/bin/uv",
                "tool",
                "install",
                "--reinstall",
                "--index-url",
                "https://pypi.org/simple/",
                f"data-hub-watcher=={target_version}",
            ],
        )

        h.counters.last_files_uploaded = 0
        h.updater.on_tick()
        h.updater.on_tick()
        result = h.updater.on_tick()

        assert result is not None
        assert result.attempted is True
        assert result.succeeded is False
        h.request_restart.assert_not_called()

        emitted_events = [c.args[0] for c in h.reporter.queue_event.call_args_list]
        update_failed = [e for e in emitted_events if e.event_type is EventType.UPDATE_FAILED]
        assert len(update_failed) == 1
        details = update_failed[0].details
        # Reason must be classified (not the generic `subprocess raised:` prefix)
        # so the dashboard row is immediately diagnosable.
        assert details["reason"].startswith("upgrade command not executable:")
        assert details["error_class"] == "FileNotFoundError"
        assert details["command"][0] == "/fake/bin/uv"
        assert details["command"][1:4] == ["tool", "install", "--reinstall"]
        assert details["install_method"] == "uv-tool"

    def test_uv_not_found_refuses_before_update_started(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # When no `uv` binary is locatable we must fail fast: no
        # UPDATE_STARTED, no on-disk marker, just a single UPDATE_FAILED
        # carrying the paths we probed so the operator knows where to
        # drop a binary (or what PATH to fix) on the lab PC.
        from data_hub_watcher.self_update import UvExecutableNotFoundError

        runner = MagicMock()  # must not be called
        h = _make_updater(tmp_path, upgrade_runner=runner)
        h.client.get_update_info.return_value = _info(latest="9.9.9")
        monkeypatch.setattr(
            "data_hub_watcher.updater.detect_install_method",
            lambda: InstallMethod.UV_TOOL,
        )

        def _raise(method: Any, target_version: str | None = None) -> list[str]:
            raise UvExecutableNotFoundError(
                [r"C:\Users\lab\.local\bin\uv.exe", r"C:\ProgramData\uv\uv.exe"]
            )

        monkeypatch.setattr("data_hub_watcher.updater.build_upgrade_command", _raise)

        h.counters.last_files_uploaded = 0
        h.updater.on_tick()
        h.updater.on_tick()
        result = h.updater.on_tick()

        assert result is not None
        assert result.attempted is True
        assert result.succeeded is False
        runner.assert_not_called()
        h.request_restart.assert_not_called()
        # No marker: we refused before dispatching the subprocess, so
        # there's nothing for the next process startup to evaluate.
        assert not (tmp_path / ".data-hub" / UPGRADE_MARKER_FILENAME).exists()

        emitted_events = [c.args[0] for c in h.reporter.queue_event.call_args_list]
        types = [e.event_type for e in emitted_events]
        # Critical: no UPDATE_STARTED for a subprocess that never ran.
        assert EventType.UPDATE_STARTED not in types
        update_failed = [e for e in emitted_events if e.event_type is EventType.UPDATE_FAILED]
        assert len(update_failed) == 1
        details = update_failed[0].details
        assert details["reason"] == "uv executable not found"
        assert details["error_class"] == "UvExecutableNotFoundError"
        assert details["attempted_subprocess"] is False
        assert details["candidates_tried"] == [
            r"C:\Users\lab\.local\bin\uv.exe",
            r"C:\ProgramData\uv\uv.exe",
        ]

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
        # And the dashboard must still see *something* — otherwise an
        # admin pushing a (possibly mandatory) rollout has no signal
        # that this PC is stuck on a dev install. Exactly one
        # UPDATE_FAILED event with the install-method reason.
        emitted_events = [c.args[0] for c in h.reporter.queue_event.call_args_list]
        update_failed = [e for e in emitted_events if e.event_type is EventType.UPDATE_FAILED]
        assert len(update_failed) == 1
        evt = update_failed[0]
        assert evt.details["target_version"] == "9.9.9"
        assert evt.details["install_method"] == "editable"
        assert evt.details["attempted_subprocess"] is False
        assert "not eligible" in evt.details["reason"]

    def test_editable_refusal_throttled_to_one_event_per_target(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # An editable install will hit the refusal path on every
        # hourly tick for the whole life of the dev box. We must
        # still notify the dashboard once per *new* target version,
        # but not on every tick — that would drown the events stream
        # for the whole fleet of dev machines.
        h = _make_updater(tmp_path)
        monkeypatch.setattr(
            "data_hub_watcher.updater.detect_install_method",
            lambda: InstallMethod.EDITABLE,
        )

        h.client.get_update_info.return_value = _info(latest="9.9.9")
        h.counters.last_files_uploaded = 0
        # Drive enough ticks to pass the check interval *twice* so two
        # full /update-check calls land — emulating the hourly tick
        # firing across multiple hours with the same server target.
        for _ in range(6):
            h.updater.on_tick()

        # Both ticks called the API (so the throttle isn't hiding a
        # missed check) but only one UPDATE_FAILED reached the queue.
        assert h.client.get_update_info.call_count == 2
        emitted = [
            c.args[0]
            for c in h.reporter.queue_event.call_args_list
            if c.args[0].event_type is EventType.UPDATE_FAILED
        ]
        assert len(emitted) == 1

    def test_editable_refusal_re_emits_when_target_advances(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # When the server bumps `WATCHER_LATEST_VERSION` to a new
        # release, we *do* want to re-notify — the dashboard event for
        # the old target doesn't tell the admin this PC is missing the
        # new one. Throttling is per-target, not "fire at most once
        # ever".
        h = _make_updater(tmp_path)
        monkeypatch.setattr(
            "data_hub_watcher.updater.detect_install_method",
            lambda: InstallMethod.UNKNOWN,
        )

        h.counters.last_files_uploaded = 0
        # First rollout target.
        h.client.get_update_info.return_value = _info(latest="9.9.9")
        for _ in range(3):
            h.updater.on_tick()
        # Server bumps the target.
        h.client.get_update_info.return_value = _info(latest="9.9.10")
        for _ in range(3):
            h.updater.on_tick()

        emitted = [
            c.args[0]
            for c in h.reporter.queue_event.call_args_list
            if c.args[0].event_type is EventType.UPDATE_FAILED
        ]
        assert [e.details["target_version"] for e in emitted] == ["9.9.9", "9.9.10"]
        # Both events must carry the install_method so the dashboard
        # can render the "stuck on dev install" filter.
        assert all(e.details["install_method"] == "unknown" for e in emitted)


class TestUpdaterAsyncDispatch:
    """The upgrade subprocess runs off the heartbeat thread.

    Locks in the contract added to keep heartbeats flowing during a
    slow ``uv tool install`` (which can take 30–60 s and would
    otherwise wedge the heartbeat loop long enough for the dashboard
    to flag the watcher as stale).
    """

    def test_on_tick_returns_immediately_while_subprocess_runs(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A runner that blocks until the test releases it. Using the
        # real threading executor (not the inline test default) so the
        # subprocess is on a worker thread and `on_tick` doesn't wait.
        release = threading.Event()
        finished = threading.Event()

        def slow_runner(method: Any, *, target_version: str) -> Any:
            release.wait(timeout=5.0)
            finished.set()
            return _success_completed_process()

        h = _make_updater(
            tmp_path,
            upgrade_runner=slow_runner,
            upgrade_executor=lambda fn: threading.Thread(
                target=fn, daemon=True, name="upgrade-worker-test"
            ).start(),
        )
        h.client.get_update_info.return_value = _info(latest="9.9.9")
        monkeypatch.setattr(
            "data_hub_watcher.updater.detect_install_method",
            lambda: InstallMethod.UV_TOOL,
        )

        h.counters.last_files_uploaded = 0
        h.updater.on_tick()
        h.updater.on_tick()

        # The blocking subprocess must not delay this call. We cap the
        # wall-clock cost at well under the 5 s upper bound of the
        # blocked runner, so a regression that ran the subprocess
        # synchronously would fail this assertion loudly rather than
        # passing on a fast machine.
        start = time.monotonic()
        result = h.updater.on_tick()
        elapsed = time.monotonic() - start
        assert elapsed < 1.0, f"on_tick took {elapsed:.2f}s — subprocess must run off-thread"

        # The dispatched-but-not-finished placeholder.
        assert result is not None
        assert result.attempted is True
        assert result.succeeded is None
        assert "dispatched" in result.reason
        assert result.target_version == "9.9.9"
        # Marker is on disk pre-dispatch (so a crashed-mid-upgrade
        # process still leaves a trail for the next startup).
        assert (tmp_path / ".data-hub" / UPGRADE_MARKER_FILENAME).exists()

        # Now let the worker complete and verify the post-conditions.
        release.set()
        assert finished.wait(timeout=5.0)
        # Wait for the worker to drop the in-progress flag and call
        # request_restart — request_restart is the runtime-side hook
        # whose call signals the heartbeat loop to exit.
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            if h.request_restart.call_count == 1:
                break
            time.sleep(0.01)
        h.request_restart.assert_called_once_with("9.9.9")

    def test_concurrent_tick_during_upgrade_is_a_noop(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # While an upgrade is in flight, a follow-up tick must not
        # spawn a second subprocess or hit /update-check again.
        release = threading.Event()
        runner_calls = 0

        def slow_runner(method: Any, *, target_version: str) -> Any:
            nonlocal runner_calls
            runner_calls += 1
            release.wait(timeout=5.0)
            return _success_completed_process()

        h = _make_updater(
            tmp_path,
            upgrade_runner=slow_runner,
            upgrade_executor=lambda fn: threading.Thread(
                target=fn, daemon=True, name="upgrade-worker-test"
            ).start(),
        )
        h.client.get_update_info.return_value = _info(latest="9.9.9")
        monkeypatch.setattr(
            "data_hub_watcher.updater.detect_install_method",
            lambda: InstallMethod.UV_TOOL,
        )

        h.counters.last_files_uploaded = 0
        h.updater.on_tick()
        h.updater.on_tick()
        first = h.updater.on_tick()
        assert first is not None
        assert first.succeeded is None

        # Wait briefly for the worker to flip _upgrade_in_progress=True
        # before the next tick (the worker reaches the runner
        # immediately, the flag is set on the dispatch path).
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            if h.updater._upgrade_in_progress:
                break
            time.sleep(0.01)

        second = h.updater.on_tick()
        assert second is not None
        assert second.attempted is False
        assert "in progress" in second.reason
        # Critical: no second API call, no second subprocess.
        assert h.client.get_update_info.call_count == 1
        assert runner_calls == 1

        release.set()

    def test_default_executor_is_threading_based(self, tmp_path: Path) -> None:
        # Smoke check that the production default actually offloads to
        # a background thread named for log-readability. Catches a
        # regression where someone might "simplify" the default back
        # to inline execution.
        from data_hub_watcher.updater import _default_upgrade_executor

        seen_threads: list[str] = []
        done = threading.Event()

        def record() -> None:
            seen_threads.append(threading.current_thread().name)
            done.set()

        _default_upgrade_executor(record)
        assert done.wait(timeout=2.0)
        assert seen_threads == ["upgrade-worker"]
        assert seen_threads[0] != threading.current_thread().name


# ---------------------------------------------------------------------------
# Updater worker-dispatch branch (Windows uv-tool)
# ---------------------------------------------------------------------------


class TestUpdaterWorkerDispatch:
    """On Windows uv-tool installs ``_apply`` routes through the worker.

    Locks in the contract: the in-process subprocess path must NOT
    fire (it would just re-hit the ``Scripts\\python.exe`` lock issue
    that motivated this whole change), the request sentinel must
    land on disk with the right pkg_spec, and ``schtasks /Run``
    failures must surface as ``UPDATE_FAILED`` rather than a silent
    no-op.
    """

    def _force_windows_uv_tool(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("data_hub_watcher.updater.sys.platform", "win32")
        monkeypatch.setattr(
            "data_hub_watcher.updater.detect_install_method",
            lambda: InstallMethod.UV_TOOL,
        )
        monkeypatch.setattr(
            "data_hub_watcher.updater._resolve_uv_executable",
            lambda override=None, prefix=None: ("/fake/bin/uv.exe", ["/fake/bin/uv.exe"]),
        )
        # Pretend pywin32 is installed so the extras detection picks
        # up the [windows-service] extra, exercising the regression
        # where pywin32 used to silently disappear after a reinstall.
        # The function is imported into the ``updater`` namespace, so
        # we patch it there rather than at the source module.
        monkeypatch.setattr(
            "data_hub_watcher.updater.detect_installed_extras",
            lambda: ["windows-service"],
        )

    def test_writes_request_sentinel_and_triggers_task(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from data_hub_watcher.upgrade_worker import (
            read_upgrade_request,
        )

        runner = MagicMock()  # must not be called on the worker path
        h = _make_updater(tmp_path, upgrade_runner=runner)
        h.client.get_update_info.return_value = _info(latest="9.9.9")

        self._force_windows_uv_tool(monkeypatch)

        trigger_calls: list[None] = []
        monkeypatch.setattr(
            "data_hub_watcher.scheduled_task.trigger_upgrade_task",
            lambda **_kw: trigger_calls.append(None),
        )

        h.counters.last_files_uploaded = 0
        h.updater.on_tick()
        h.updater.on_tick()
        result = h.updater.on_tick()

        assert result is not None
        assert result.attempted is True
        # Worker dispatch leaves succeeded=None; the real outcome is
        # surfaced from the post-restart event evaluation, not here.
        assert result.succeeded is None
        assert result.extra.get("via_worker") is True

        # Request sentinel must be on disk with the right spec.
        req = read_upgrade_request(tmp_path / ".data-hub")
        assert req is not None
        assert req.target_version == "9.9.9"
        assert req.pkg_spec == "data-hub-watcher[windows-service]==9.9.9"
        assert req.uv_executable == "/fake/bin/uv.exe"
        assert req.install_method == "uv-tool"

        # Marker is also on disk so the post-restart evaluation can
        # tell whether the new version actually loaded.
        assert (tmp_path / ".data-hub" / UPGRADE_MARKER_FILENAME).exists()
        # schtasks /Run was triggered exactly once.
        assert trigger_calls == [None]
        # Critical: the in-process subprocess path must NOT fire on
        # Windows uv-tool — that would re-hit the lock issue the
        # whole change is designed to avoid.
        runner.assert_not_called()
        h.request_restart.assert_not_called()

        # UPDATE_STARTED must have been queued so the dashboard shows
        # the dispatch even if the worker takes the service down
        # before the next heartbeat would normally flush.
        emitted = [c.args[0] for c in h.reporter.queue_event.call_args_list]
        types = [e.event_type for e in emitted]
        assert EventType.UPDATE_STARTED in types
        # The success / final-failure event is deferred to the
        # post-restart marker evaluation, never emitted from here.
        assert EventType.UPDATE_SUCCEEDED not in types

    def test_uv_not_found_surfaces_update_failed_without_started(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Same invariant as the in-process path: a missing uv binary
        # must NOT emit UPDATE_STARTED, must NOT write the marker,
        # and must surface a single UPDATE_FAILED with the candidates
        # we probed so the operator can drop a binary in the right
        # place.
        h = _make_updater(tmp_path)
        h.client.get_update_info.return_value = _info(latest="9.9.9")

        monkeypatch.setattr("data_hub_watcher.updater.sys.platform", "win32")
        monkeypatch.setattr(
            "data_hub_watcher.updater.detect_install_method",
            lambda: InstallMethod.UV_TOOL,
        )
        monkeypatch.setattr(
            "data_hub_watcher.updater._resolve_uv_executable",
            lambda override=None, prefix=None: (None, [r"C:\Users\lab\.local\bin\uv.exe"]),
        )

        trigger_calls: list[None] = []
        monkeypatch.setattr(
            "data_hub_watcher.scheduled_task.trigger_upgrade_task",
            lambda **_kw: trigger_calls.append(None),
        )

        h.counters.last_files_uploaded = 0
        h.updater.on_tick()
        h.updater.on_tick()
        result = h.updater.on_tick()

        assert result is not None
        assert result.attempted is True
        assert result.succeeded is False
        assert trigger_calls == []
        assert not (tmp_path / ".data-hub" / UPGRADE_MARKER_FILENAME).exists()

        emitted = [c.args[0] for c in h.reporter.queue_event.call_args_list]
        types = [e.event_type for e in emitted]
        assert EventType.UPDATE_STARTED not in types
        update_failed = [e for e in emitted if e.event_type is EventType.UPDATE_FAILED]
        assert len(update_failed) == 1
        details = update_failed[0].details
        assert details["reason"] == "uv executable not found"
        assert details["attempted_subprocess"] is False
        assert details["via_worker"] is True
        assert details["candidates_tried"] == [r"C:\Users\lab\.local\bin\uv.exe"]

    def test_schtasks_failure_clears_sentinels_and_emits_update_failed(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Most likely cause: the scheduled task isn't registered (a
        # fleet PC that auto-updated into worker-aware code without
        # re-running ``service install``). The dispatch must:
        #   1. Clear its own request sentinel + marker so the next
        #      tick can try again from a clean slate.
        #   2. Surface UPDATE_FAILED with a reason that points at
        #      the recovery command.
        #   3. NOT call request_restart (the worker is what stops
        #      the service; without it firing we must stay alive).
        from data_hub_watcher.scheduled_task import ScheduledTaskError
        from data_hub_watcher.upgrade_worker import (
            UPGRADE_REQUEST_FILENAME,
            UPGRADE_RESULT_FILENAME,
        )

        h = _make_updater(tmp_path)
        h.client.get_update_info.return_value = _info(latest="9.9.9")
        self._force_windows_uv_tool(monkeypatch)

        def boom(**_kw: Any) -> None:
            raise ScheduledTaskError(
                "schtasks /Run failed for 'DataHubWatcherUpgrade'",
                argv=["schtasks.exe", "/Run", "/TN", "DataHubWatcherUpgrade"],
                stderr="ERROR: The system cannot find the file specified.",
                returncode=1,
            )

        monkeypatch.setattr("data_hub_watcher.scheduled_task.trigger_upgrade_task", boom)

        h.counters.last_files_uploaded = 0
        h.updater.on_tick()
        h.updater.on_tick()
        result = h.updater.on_tick()

        assert result is not None
        assert result.attempted is True
        assert result.succeeded is False
        assert "scheduled task" in result.reason
        # Sentinels must be cleared so the next tick isn't gated on
        # a stale request file from a failed dispatch.
        assert not (tmp_path / ".data-hub" / UPGRADE_REQUEST_FILENAME).exists()
        assert not (tmp_path / ".data-hub" / UPGRADE_MARKER_FILENAME).exists()
        # And of course there's no result sentinel — the worker
        # never ran.
        assert not (tmp_path / ".data-hub" / UPGRADE_RESULT_FILENAME).exists()

        h.request_restart.assert_not_called()

        emitted = [c.args[0] for c in h.reporter.queue_event.call_args_list]
        update_failed = [e for e in emitted if e.event_type is EventType.UPDATE_FAILED]
        assert len(update_failed) == 1
        details = update_failed[0].details
        assert details["via_worker"] is True
        assert details["attempted_subprocess"] is False
        assert "schtasks_stderr" in details
        assert details["schtasks_returncode"] == 1
        assert "service reinstall" in details["reason"]

    def test_posix_uv_tool_still_uses_in_process_path(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The worker dispatch is gated on Windows specifically. POSIX
        # uv-tool installs continue to use the inline subprocess
        # because they don't have the file-lock issue and the inline
        # path gives the dashboard live UPDATE_STARTED -> succeeded
        # event pairing without an extra hop.
        runner = MagicMock(return_value=_success_completed_process())
        h = _make_updater(tmp_path, upgrade_runner=runner)
        h.client.get_update_info.return_value = _info(latest="9.9.9")

        monkeypatch.setattr("data_hub_watcher.updater.sys.platform", "linux")
        monkeypatch.setattr(
            "data_hub_watcher.updater.detect_install_method",
            lambda: InstallMethod.UV_TOOL,
        )
        # If anything tried to dispatch through the worker, this
        # would explode loudly rather than passing silently.
        monkeypatch.setattr(
            "data_hub_watcher.scheduled_task.trigger_upgrade_task",
            lambda **_kw: pytest.fail("POSIX uv-tool must not route through the worker"),
        )

        h.counters.last_files_uploaded = 0
        h.updater.on_tick()
        h.updater.on_tick()
        result = h.updater.on_tick()

        assert result is not None
        assert result.attempted is True
        assert result.succeeded is True
        runner.assert_called_once()
        h.request_restart.assert_called_once_with("9.9.9")

    def test_windows_pip_install_still_uses_in_process_path(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Windows pip-installed watchers don't have the lock issue
        # because pip rewrites individual files in site-packages
        # rather than recreating Scripts\\. They keep using the
        # inline subprocess path.
        runner = MagicMock(return_value=_success_completed_process())
        h = _make_updater(tmp_path, upgrade_runner=runner)
        h.client.get_update_info.return_value = _info(latest="9.9.9")

        monkeypatch.setattr("data_hub_watcher.updater.sys.platform", "win32")
        monkeypatch.setattr(
            "data_hub_watcher.updater.detect_install_method",
            lambda: InstallMethod.PIP,
        )
        monkeypatch.setattr(
            "data_hub_watcher.scheduled_task.trigger_upgrade_task",
            lambda **_kw: pytest.fail("Windows pip installs must not route through the worker"),
        )

        h.counters.last_files_uploaded = 0
        h.updater.on_tick()
        h.updater.on_tick()
        result = h.updater.on_tick()

        assert result is not None
        assert result.succeeded is True
        runner.assert_called_once()
