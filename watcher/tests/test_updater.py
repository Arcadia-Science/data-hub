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
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from data_hub_watcher.api_client import ApiError
from data_hub_watcher.constants import (
    DEFAULT_CHECK_INTERVAL_TICKS,
    DEFAULT_IDLE_TICKS_REQUIRED,
    DEFAULT_INDEX_URL,
    UPGRADE_HANDOFF_TIMEOUT_SECONDS,
)
from data_hub_watcher.events import EventReporter, EventType
from data_hub_watcher.heartbeat import WatcherCounters
from data_hub_watcher.models import (
    InstrumentConfig,
    RunDetectionConfig,
    WatcherConfig,
    WatcherUpdateInfoResponse,
)
from data_hub_watcher.self_update import InstallMethod, run_upgrade
from data_hub_watcher.updater import (
    UPGRADE_MARKER_FILENAME,
    Updater,
    UpdaterConfig,
    UpgradeHandoff,
    UpgradeMarkerOutcome,
    clear_upgrade_marker,
    evaluate_upgrade_marker,
    should_attempt_update,
    updater_config_from_overrides,
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
        api_base_urls={environment: "https://example.test/api/v1"}
        if environment == "preview"
        else {},
        watcher_ids={environment: "w-test"},
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
    handoff: UpgradeHandoff | None = None,
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
            # Opt out of the production-default "fire /update-check
            # on the very first tick" fast path so the existing
            # ``for _ in range(N): on_tick(); then trigger on the
            # (N+1)th tick`` cadence assertions throughout this file
            # keep working unchanged. The on-start fast path has its
            # own dedicated test class below — pinning the default-on
            # behaviour separately keeps each test focused on the
            # specific behaviour it's exercising.
            check_on_start=False,
        ),
        upgrade_runner=upgrade_runner,
        upgrade_executor=upgrade_executor,
        handoff=handoff,
    )
    return _UpdaterHarness(
        updater=updater,
        client=client,
        reporter=reporter,
        state_db=state_db,
        counters=counters,
        request_restart=request_restart,
    )


class _FakeClock:
    """A clock the test moves, for the window after an upgrade is handed to the worker."""

    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


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

    def test_first_ticks_are_no_op_until_check_interval_when_check_on_start_disabled(
        self, tmp_path: Path
    ) -> None:
        # The default test helper opts out of the on-start fast path
        # (see comment in ``_make_updater``) so this still pins the
        # cadence-only behaviour: with ``check_interval_ticks=3``,
        # ticks 1 and 2 are no-ops and tick 3 fires the API call.
        # The on-start fast path's effect on this same shape is
        # pinned in ``TestUpdaterChecksOnStart`` below.
        h = _make_updater(tmp_path)
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
                # See helper-level comment in ``_make_updater`` for
                # why cadence-focused tests opt out of the on-start
                # fast path.
                check_on_start=False,
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
                # ``check_interval_ticks=1`` already fires on every
                # tick so the on-start fast path would be a no-op
                # here anyway, but pin the opt-out so the test's
                # "exactly 3 invocations → exactly 3 failures"
                # arithmetic stays explicit.
                check_on_start=False,
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
                # See sibling test for why we pin the opt-out even
                # though check_interval_ticks=1 makes the on-start
                # fast path effectively a no-op here.
                check_on_start=False,
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
        # When the server advertises a new release (via the admin-only
        # /settings/watchers page), we *do* want to re-notify —
        # the dashboard event for
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


class TestUpdaterChecksOnStart:
    """Pin the production-default ``check_on_start=True`` behaviour.

    Why this matters: lab PCs only run ``/update-check`` once an hour
    by default, so a fresh ``service install`` / ``service reinstall``
    / boot would otherwise wait up to 60 minutes before noticing a
    pending release. That latency is fine in steady state but
    disastrous during fix-forward iteration on the auto-update path
    itself: the operator pushes a release, manually reinstalls the
    watcher, then twiddles their thumbs for an hour to see if the
    next auto-update tick works. Seeding ``_ticks_since_check`` to
    ``check_interval_ticks`` at construction collapses that wait to
    one heartbeat (~60 s) without disturbing the steady-state
    cadence — and without bypassing the activity-window safety
    gates, which still defer the actual upgrade dispatch as designed.
    """

    def _make_updater_with_on_start(
        self,
        tmp_path: Path,
        *,
        idle_ticks_required: int = 0,
        check_interval_ticks: int = 60,
        last_run_age_seconds: float | None = None,
    ) -> _UpdaterHarness:
        # ``check_on_start=True`` is the production default but the
        # default helper opts out, so build directly here. Tests in
        # this class want the production wiring exactly.
        h = _make_updater(
            tmp_path,
            updater_cfg=UpdaterConfig(
                idle_ticks_required=idle_ticks_required,
                check_interval_ticks=check_interval_ticks,
                min_run_age_seconds=10.0,
                check_on_start=True,
            ),
        )
        if last_run_age_seconds is not None:
            from datetime import datetime, timedelta, timezone

            # ``state_db.last_run_reported_at`` returns an ISO-8601
            # string (it's a SQLite TEXT column), not a datetime —
            # ``_last_run_age_seconds`` parses it via ``fromisoformat``.
            past = datetime.now(timezone.utc) - timedelta(seconds=last_run_age_seconds)
            h.state_db.last_run_reported_at.return_value = past.isoformat()
        return h

    def test_default_config_enables_check_on_start(self) -> None:
        # Pin the production default explicitly so a future refactor
        # that flips the default to False (and only updates the
        # docstring) trips here rather than silently regressing the
        # cold-start latency back to ~60 minutes.
        cfg = UpdaterConfig()
        assert cfg.check_on_start is True

    def test_first_tick_fires_update_check_immediately(self, tmp_path: Path) -> None:
        # The headline behaviour: with the production-default
        # ``check_on_start=True`` and the production-default
        # ``check_interval_ticks=60``, the very first tick after
        # construction calls ``/update-check`` rather than waiting 59
        # more ticks. Without this, an operator who just ran
        # ``service reinstall`` to apply a fix-forward release would
        # have to wait up to an hour to confirm whether the fix
        # actually unblocked the auto-update path.
        h = self._make_updater_with_on_start(tmp_path)
        h.client.get_update_info.return_value = _info(latest="0.0.0+unknown")
        h.counters.last_files_uploaded = 0

        result = h.updater.on_tick()

        assert result is not None, (
            "first tick must call /update-check when check_on_start=True; "
            "got None which means we waited for the cadence window"
        )
        h.client.get_update_info.assert_called_once()

    def test_subsequent_ticks_resume_normal_cadence(self, tmp_path: Path) -> None:
        # The on-start fast path is one-shot: tick 1 fires, then
        # ticks 2..(check_interval_ticks) are no-ops, then the
        # check_interval_ticks+1-th tick fires again. Otherwise we'd
        # be calling /update-check every single heartbeat which
        # would 60x the load on the watcher-update endpoint.
        h = self._make_updater_with_on_start(tmp_path, check_interval_ticks=3)
        h.client.get_update_info.return_value = _info(latest="0.0.0+unknown")
        h.counters.last_files_uploaded = 0

        # Tick 1 — on-start fast path fires.
        assert h.updater.on_tick() is not None
        assert h.client.get_update_info.call_count == 1

        # Ticks 2 and 3 — within the cadence window after the reset.
        assert h.updater.on_tick() is None
        assert h.updater.on_tick() is None
        assert h.client.get_update_info.call_count == 1

        # Tick 4 — cadence window elapsed, fires again.
        assert h.updater.on_tick() is not None
        assert h.client.get_update_info.call_count == 2

    def test_opt_out_preserves_pre_existing_cadence(self, tmp_path: Path) -> None:
        # The opt-out path must produce exactly the historical
        # behaviour: ticks 1 and 2 are no-ops with check_interval=3,
        # tick 3 fires the API call. This is what every other test
        # class in this file relies on, so a regression here would
        # cascade into many false failures.
        h = _make_updater(
            tmp_path,
            updater_cfg=UpdaterConfig(
                idle_ticks_required=0,
                check_interval_ticks=3,
                min_run_age_seconds=10.0,
                check_on_start=False,
            ),
        )
        h.client.get_update_info.return_value = _info(latest="0.0.0+unknown")
        h.counters.last_files_uploaded = 0

        assert h.updater.on_tick() is None
        assert h.updater.on_tick() is None
        assert h.client.get_update_info.call_count == 0
        assert h.updater.on_tick() is not None
        assert h.client.get_update_info.call_count == 1

    def test_on_start_check_still_respects_idle_gate(self, tmp_path: Path) -> None:
        # Critical safety pin: the on-start fast path short-circuits
        # the *cadence* window, NOT the activity-window safety gate.
        # If the operator restarts the service while uploads are
        # actively flowing, the first tick should DO the API call
        # (we want the operator to see "yes, an upgrade is pending"
        # in the logs / dashboard immediately) but DEFER the actual
        # upgrade dispatch until the upload activity quiets down —
        # exactly as the steady-state cadence would. Without this
        # pin a future refactor could conflate the two and start
        # interrupting in-flight uploads on every restart.
        h = self._make_updater_with_on_start(
            tmp_path,
            idle_ticks_required=5,
            check_interval_ticks=60,
        )
        h.client.get_update_info.return_value = _info(latest="9.9.9")
        # Simulate active upload activity: the heartbeat reports
        # files uploaded on this tick.
        h.counters.last_files_uploaded = 3

        result = h.updater.on_tick()

        # API was called (the fast path's job)…
        h.client.get_update_info.assert_called_once()
        # …but the dispatch was deferred (the safety gate's job).
        assert result is not None
        assert result.attempted is False
        assert "idle ticks" in result.reason
        h.request_restart.assert_not_called()

    def test_on_start_check_still_respects_recent_run_gate(self, tmp_path: Path) -> None:
        # Same shape as the idle-gate pin above, but for the
        # ``last_run_age_seconds`` half of the activity-window
        # check. A run reported 5 seconds before service restart
        # (operator restarted mid-experiment to apply a fix) must
        # NOT trigger an immediate upgrade just because the on-start
        # fast path enabled the API call.
        h = self._make_updater_with_on_start(
            tmp_path,
            idle_ticks_required=0,  # Idle gate disabled.
            last_run_age_seconds=5.0,  # Recent run, gate active.
        )
        h.client.get_update_info.return_value = _info(latest="9.9.9")
        h.counters.last_files_uploaded = 0

        result = h.updater.on_tick()

        h.client.get_update_info.assert_called_once()
        assert result is not None
        assert result.attempted is False
        assert "recent run" in result.reason
        h.request_restart.assert_not_called()

    def test_on_start_check_dispatches_when_safety_gates_pass(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The flip side of the safety pins above: when nothing's
        # happening (clean restart on an idle host with no recent
        # runs and no pending uploads — the common case), the
        # on-start fast path SHOULD result in an immediate dispatch.
        # This is the behaviour the operator-facing testing-iteration
        # win actually depends on.
        runner = MagicMock(return_value=_success_completed_process())
        h = _make_updater(
            tmp_path,
            updater_cfg=UpdaterConfig(
                idle_ticks_required=0,
                check_interval_ticks=60,
                min_run_age_seconds=10.0,
                check_on_start=True,
            ),
            upgrade_runner=runner,
        )
        h.client.get_update_info.return_value = _info(latest="9.9.9")
        h.state_db.last_run_reported_at.return_value = None
        h.counters.last_files_uploaded = 0

        monkeypatch.setattr(
            "data_hub_watcher.updater.detect_install_method",
            lambda: InstallMethod.UV_TOOL,
        )

        result = h.updater.on_tick()

        h.request_restart.assert_called_once()
        assert result is not None
        assert result.attempted is True


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


class TestUpgradeHandoff:
    """The memory of an upgrade handed to the Windows worker, apart from any updater."""

    def test_a_hand_off_ends_only_in_take_expired_once_its_window_is_over(self) -> None:
        clock = _FakeClock()
        handoff = UpgradeHandoff(clock=clock)
        assert handoff.take_expired() is None

        handoff.record("9.9.9")
        clock.advance(UPGRADE_HANDOFF_TIMEOUT_SECONDS - 1)
        assert handoff.window_open() is True
        assert handoff.take_expired() is None

        clock.advance(1)
        assert handoff.window_open() is False
        # The window by the clock being over does not end it: only the call does.
        assert handoff.take_expired() == "9.9.9"
        assert handoff.take_expired() is None
        assert handoff.begin_stop() is False

    def test_a_stop_that_began_keeps_the_hand_off_from_being_ended(self) -> None:
        clock = _FakeClock()
        handoff = UpgradeHandoff(clock=clock)
        handoff.record("9.9.9")
        assert handoff.stopping is False
        assert handoff.begin_stop() is True
        assert handoff.stopping is True
        clock.advance(2 * UPGRADE_HANDOFF_TIMEOUT_SECONDS)

        assert handoff.take_expired() is None

        assert handoff.begin_stop() is True


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

    @pytest.mark.parametrize(
        ("override", "expected"),
        [
            (None, DEFAULT_INDEX_URL),
            ("http://127.0.0.1:8123/simple/", "http://127.0.0.1:8123/simple/"),
        ],
        ids=["pypi_by_default", "test_only_override"],
    )
    def test_request_sentinel_carries_the_index_url(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        override: str | None,
        expected: str,
    ) -> None:
        # The worker runs as another account with its own environment, so the
        # index it installs from travels in the request, read when the upgrade
        # is dispatched.
        from data_hub_watcher.upgrade_worker import read_upgrade_request

        h = _make_updater(tmp_path, upgrade_runner=MagicMock())
        h.client.get_update_info.return_value = _info(latest="9.9.9")
        self._force_windows_uv_tool(monkeypatch)
        monkeypatch.setattr(
            "data_hub_watcher.scheduled_task.trigger_upgrade_task", lambda **_kw: None
        )
        if override is not None:
            monkeypatch.setenv("DATA_HUB_WATCHER_INDEX_URL", override)

        h.counters.last_files_uploaded = 0
        h.updater.on_tick()
        h.updater.on_tick()
        h.updater.on_tick()

        req = read_upgrade_request(tmp_path / ".data-hub")
        assert req is not None
        assert req.index_url == expected

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

    def test_a_dispatched_upgrade_is_not_dispatched_again_while_the_worker_has_it(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The worker stops the service from outside, so nothing in this process says the
        # upgrade is under way. Without a memory of the hand-off, each later update check
        # dispatched the same upgrade again: a second request and `UPDATE_STARTED`, and a
        # second `schtasks /Run` for the worker to find the service already stopped.
        clock = _FakeClock()
        handoff = UpgradeHandoff(clock=clock)
        h = _make_updater(tmp_path, handoff=handoff)
        h.client.get_update_info.return_value = _info(latest="9.9.9")
        self._force_windows_uv_tool(monkeypatch)
        trigger_calls: list[None] = []
        monkeypatch.setattr(
            "data_hub_watcher.scheduled_task.trigger_upgrade_task",
            lambda **_kw: trigger_calls.append(None),
        )
        h.counters.last_files_uploaded = 0
        assert handoff.window_open() is False
        for _ in range(3):
            h.updater.on_tick()
        assert trigger_calls == [None]
        assert handoff.window_open() is True

        # Many more ticks, enough for several update checks, until just before the window ends.
        h.client.get_update_info.reset_mock()
        results = []
        for _ in range(12):
            clock.advance((UPGRADE_HANDOFF_TIMEOUT_SECONDS - 1) / 12)
            results.append(h.updater.on_tick())

        assert trigger_calls == [None]
        h.client.get_update_info.assert_not_called()
        assert all(
            r is not None and r.attempted is False and r.reason == "upgrade handed to the worker"
            for r in results
        )
        emitted = [c.args[0] for c in h.reporter.queue_event.call_args_list]
        assert [e.event_type for e in emitted] == [EventType.UPDATE_STARTED]
        assert handoff.window_open() is True

    def test_a_service_still_running_when_the_window_ends_reports_it_and_may_dispatch_again(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from data_hub_watcher.upgrade_worker import UPGRADE_REQUEST_FILENAME

        clock = _FakeClock()
        handoff = UpgradeHandoff(clock=clock)
        h = _make_updater(tmp_path, handoff=handoff)
        h.client.get_update_info.return_value = _info(latest="9.9.9")
        self._force_windows_uv_tool(monkeypatch)
        trigger_calls: list[None] = []
        monkeypatch.setattr(
            "data_hub_watcher.scheduled_task.trigger_upgrade_task",
            lambda **_kw: trigger_calls.append(None),
        )
        h.counters.last_files_uploaded = 0
        for _ in range(3):
            h.updater.on_tick()
        assert trigger_calls == [None]
        config_dir = tmp_path / ".data-hub"
        assert (config_dir / UPGRADE_REQUEST_FILENAME).exists()
        assert (config_dir / UPGRADE_MARKER_FILENAME).exists()
        h.reporter.queue_event.reset_mock()

        # The window is over and this service was never stopped.
        clock.advance(UPGRADE_HANDOFF_TIMEOUT_SECONDS)
        assert handoff.window_open() is False
        h.updater.on_tick()

        emitted = [c.args[0] for c in h.reporter.queue_event.call_args_list]
        assert [e.event_type for e in emitted] == [EventType.UPDATE_FAILED]
        assert emitted[0].details["reason"] == "worker_did_not_stop_service"
        assert emitted[0].details["target_version"] == "9.9.9"
        assert emitted[0].details["via_worker"] is True
        # The message says where to look, and with no result from the worker there are
        # no details from it.
        assert "upgrade-worker.log" in emitted[0].message
        assert not [key for key in emitted[0].details if key.startswith("worker_")]
        # What the hand-off wrote is cleared, as after a failed `schtasks /Run`.
        assert not (config_dir / UPGRADE_REQUEST_FILENAME).exists()
        assert not (config_dir / UPGRADE_MARKER_FILENAME).exists()
        h.reporter.flush.assert_called()

        # The hand-off is forgotten, so checks go on as usual: the next one that is due
        # dispatches again. That is a hand-off with a window of its own, and the failure
        # is not reported a second time.
        h.client.get_update_info.reset_mock()
        h.updater.on_tick()
        h.updater.on_tick()
        h.client.get_update_info.assert_called_once()
        assert trigger_calls == [None, None]
        assert handoff.window_open() is True
        types = [c.args[0].event_type for c in h.reporter.queue_event.call_args_list]
        assert types == [EventType.UPDATE_FAILED, EventType.UPDATE_STARTED]

    def test_a_schtasks_failure_hands_nothing_over(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The upgrade never reached the worker, so the next update check may try it
        # again, and a stop meanwhile is not an update stop.
        from data_hub_watcher.scheduled_task import ScheduledTaskError

        handoff = UpgradeHandoff()
        h = _make_updater(tmp_path, handoff=handoff)
        h.client.get_update_info.return_value = _info(latest="9.9.9")
        self._force_windows_uv_tool(monkeypatch)
        attempts: list[None] = []

        def refuse(**_kw: Any) -> None:
            attempts.append(None)
            raise ScheduledTaskError(
                "schtasks /Run failed",
                argv=["schtasks.exe", "/Run"],
                stderr="ERROR",
                returncode=1,
            )

        monkeypatch.setattr("data_hub_watcher.scheduled_task.trigger_upgrade_task", refuse)
        h.counters.last_files_uploaded = 0
        for _ in range(3):
            h.updater.on_tick()
        assert attempts == [None]
        assert handoff.window_open() is False

        results = [h.updater.on_tick() for _ in range(3)]

        assert attempts == [None, None]
        assert results[-1] is not None and results[-1].reason == "scheduled task trigger failed"
        types = [c.args[0].event_type for c in h.reporter.queue_event.call_args_list]
        assert types.count(EventType.UPDATE_FAILED) == 2

    def test_a_refused_dispatch_hands_nothing_over(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        handoff = UpgradeHandoff()
        h = _make_updater(tmp_path, handoff=handoff)
        h.client.get_update_info.return_value = _info(latest="9.9.9")
        self._force_windows_uv_tool(monkeypatch)
        monkeypatch.setattr(
            "data_hub_watcher.updater._resolve_uv_executable",
            lambda override=None, prefix=None: (None, [r"C:\uv.exe"]),
        )
        monkeypatch.setattr(
            "data_hub_watcher.scheduled_task.trigger_upgrade_task",
            lambda **_kw: pytest.fail("a refused dispatch must not trigger the task"),
        )
        h.counters.last_files_uploaded = 0

        for _ in range(3):
            h.updater.on_tick()

        assert handoff.window_open() is False

    def test_an_in_process_upgrade_is_not_a_hand_off(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # That path has a flag of its own, and ends in `request_upgrade_restart`.
        runner = MagicMock(return_value=_success_completed_process())
        handoff = UpgradeHandoff()
        h = _make_updater(tmp_path, upgrade_runner=runner, handoff=handoff)
        h.client.get_update_info.return_value = _info(latest="9.9.9")
        monkeypatch.setattr("data_hub_watcher.updater.sys.platform", "linux")
        monkeypatch.setattr(
            "data_hub_watcher.updater.detect_install_method", lambda: InstallMethod.UV_TOOL
        )
        h.counters.last_files_uploaded = 0

        for _ in range(3):
            h.updater.on_tick()

        runner.assert_called_once()
        h.request_restart.assert_called_once_with("9.9.9")
        assert handoff.window_open() is False

    def _hand_off_an_upgrade(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> tuple[_UpdaterHarness, UpgradeHandoff, _FakeClock, list[None]]:
        """An updater that has just handed an upgrade to the worker.

        Returns it with its hand-off, the clock the hand-off reads, and the list that
        gets an item for every `schtasks /Run`.
        """
        clock = _FakeClock()
        handoff = UpgradeHandoff(clock=clock)
        h = _make_updater(tmp_path, handoff=handoff)
        h.client.get_update_info.return_value = _info(latest="9.9.9")
        self._force_windows_uv_tool(monkeypatch)
        trigger_calls: list[None] = []
        monkeypatch.setattr(
            "data_hub_watcher.scheduled_task.trigger_upgrade_task",
            lambda **_kw: trigger_calls.append(None),
        )
        h.counters.last_files_uploaded = 0
        for _ in range(3):
            h.updater.on_tick()
        assert trigger_calls == [None]
        assert handoff.window_open() is True
        h.client.get_update_info.reset_mock()
        h.reporter.queue_event.reset_mock()
        return h, handoff, clock, trigger_calls

    def test_a_stop_that_begins_after_the_window_but_before_the_expiry_tick_keeps_the_hand_off(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from data_hub_watcher.upgrade_worker import UPGRADE_REQUEST_FILENAME

        # A late worker calls `Stop-Service` just before the window ends. The service loop
        # notices the stop up to a second later, with the window over by the clock but no
        # tick yet to have ended the hand-off.
        h, handoff, clock, trigger_calls = self._hand_off_an_upgrade(tmp_path, monkeypatch)
        clock.advance(UPGRADE_HANDOFF_TIMEOUT_SECONDS + 0.3)
        assert handoff.window_open() is False

        # The stop is the worker's, and it freezes the updater.
        assert handoff.begin_stop() is True

        # The tick that would have ended the hand-off runs while the stop is under way, and
        # leaves it alone: no failure, and the request and the marker the worker needs stay.
        assert h.updater.on_tick() is None
        h.reporter.queue_event.assert_not_called()
        config_dir = tmp_path / ".data-hub"
        assert (config_dir / UPGRADE_REQUEST_FILENAME).exists()
        assert (config_dir / UPGRADE_MARKER_FILENAME).exists()
        h.client.get_update_info.assert_not_called()
        assert trigger_calls == [None]

    def test_a_tick_during_a_stop_neither_ends_the_hand_off_nor_dispatches(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from data_hub_watcher.upgrade_worker import UPGRADE_REQUEST_FILENAME

        # The heartbeat loop keeps ticking for a while into a stop. This stop began inside
        # the window and chose its reason then; the window ends while it is still running.
        h, handoff, clock, trigger_calls = self._hand_off_an_upgrade(tmp_path, monkeypatch)
        clock.advance(100)
        assert handoff.begin_stop() is True
        clock.advance(2 * UPGRADE_HANDOFF_TIMEOUT_SECONDS)

        results = [h.updater.on_tick() for _ in range(2 * DEFAULT_CHECK_INTERVAL_TICKS)]

        # Ticks that would have ended the hand-off, and then checked for an update and
        # dispatched it again, did nothing.
        assert results == [None] * (2 * DEFAULT_CHECK_INTERVAL_TICKS)
        h.reporter.queue_event.assert_not_called()
        assert (tmp_path / ".data-hub" / UPGRADE_REQUEST_FILENAME).exists()
        assert (tmp_path / ".data-hub" / UPGRADE_MARKER_FILENAME).exists()
        h.client.get_update_info.assert_not_called()
        assert trigger_calls == [None]
        # And the stop still sees the hand-off.
        assert handoff.begin_stop() is True

    def test_a_stop_after_the_tick_that_ended_the_hand_off_is_not_the_workers(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        h, handoff, clock, _trigger_calls = self._hand_off_an_upgrade(tmp_path, monkeypatch)
        clock.advance(UPGRADE_HANDOFF_TIMEOUT_SECONDS)

        h.updater.on_tick()

        types = [c.args[0].event_type for c in h.reporter.queue_event.call_args_list]
        assert types == [EventType.UPDATE_FAILED]
        assert handoff.begin_stop() is False

    def test_an_update_check_that_ends_after_a_stop_began_dispatches_nothing(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        handoff = UpgradeHandoff()
        h = _make_updater(tmp_path, handoff=handoff)
        self._force_windows_uv_tool(monkeypatch)
        monkeypatch.setattr(
            "data_hub_watcher.scheduled_task.trigger_upgrade_task",
            lambda **_kw: pytest.fail("an update must not be dispatched during a stop"),
        )

        def stop_begins_during_the_check(_watcher_id: str) -> WatcherUpdateInfoResponse:
            handoff.begin_stop()
            return _info(latest="9.9.9")

        h.client.get_update_info.side_effect = stop_begins_during_the_check
        h.counters.last_files_uploaded = 0

        results = [h.updater.on_tick() for _ in range(3)]

        assert results[-1] is not None and results[-1].reason == "watcher is stopping"
        assert results[-1].attempted is False
        h.reporter.queue_event.assert_not_called()
        assert not (tmp_path / ".data-hub" / UPGRADE_MARKER_FILENAME).exists()

    def test_an_updater_given_the_same_hand_off_does_not_dispatch_it_again(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The runtime, and its updater with it, is built again in the same process, for a
        # config revision and on other switches. The new updater gets the supervisor's
        # hand-off, so the worker's upgrade is neither dispatched again nor forgotten.
        h, handoff, clock, trigger_calls = self._hand_off_an_upgrade(tmp_path, monkeypatch)
        rebuilt = _make_updater(
            tmp_path,
            cfg=h.updater._cfg,
            handoff=handoff,
            # The production default: the first tick checks for an update at once.
            updater_cfg=UpdaterConfig(
                idle_ticks_required=1, check_interval_ticks=1, check_on_start=True
            ),
        )
        rebuilt.client.get_update_info.return_value = _info(latest="9.9.9")
        rebuilt.counters.last_files_uploaded = 0

        clock.advance(UPGRADE_HANDOFF_TIMEOUT_SECONDS - 1)
        results = [rebuilt.updater.on_tick() for _ in range(3)]

        assert all(r is not None and r.reason == "upgrade handed to the worker" for r in results)
        rebuilt.client.get_update_info.assert_not_called()
        assert trigger_calls == [None]

        # The new updater ends the hand-off when its window is over, and the old one
        # doesn't report it a second time.
        clock.advance(1)
        rebuilt.updater.on_tick()
        h.updater.on_tick()
        types = [c.args[0].event_type for c in rebuilt.reporter.queue_event.call_args_list]
        assert types[0] == EventType.UPDATE_FAILED
        assert rebuilt.reporter.queue_event.call_args_list[0].args[0].details["reason"] == (
            "worker_did_not_stop_service"
        )
        h.reporter.queue_event.assert_not_called()

    def test_the_expiry_reports_what_the_worker_left_and_clears_it(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from data_hub_watcher.upgrade_worker import (
            UPGRADE_REQUEST_FILENAME,
            UpgradeResult,
            upgrade_result_path,
        )

        h, _handoff, clock, _trigger_calls = self._hand_off_an_upgrade(tmp_path, monkeypatch)
        config_dir = tmp_path / ".data-hub"
        # The worker ran but couldn't stop the service, so `uv` failed on the files the
        # running service holds. It wrote its result, and the service is still running.
        result = UpgradeResult(
            request_id="req-1",
            target_version="9.9.9",
            succeeded=False,
            returncode=2,
            stdout_tail="",
            stderr_tail="error: failed to remove directory: Access is denied",
            finished_at="2026-01-01T00:00:00+00:00",
            error=None,
        )
        upgrade_result_path(config_dir).write_text(json.dumps(result.to_dict()), encoding="utf-8")
        clock.advance(UPGRADE_HANDOFF_TIMEOUT_SECONDS)

        h.updater.on_tick()

        emitted = [c.args[0] for c in h.reporter.queue_event.call_args_list]
        assert [e.event_type for e in emitted] == [EventType.UPDATE_FAILED]
        details = emitted[0].details
        assert details["reason"] == "worker_did_not_stop_service"
        assert details["worker_returncode"] == 2
        assert details["worker_stderr_tail"] == result.stderr_tail
        assert details["worker_stdout_tail"] == ""
        assert details["worker_error"] is None
        assert details["worker_request_id"] == "req-1"
        # Cleared with the request and the marker, so a later upgrade isn't blamed for it.
        assert not upgrade_result_path(config_dir).exists()
        assert not (config_dir / UPGRADE_REQUEST_FILENAME).exists()
        assert not (config_dir / UPGRADE_MARKER_FILENAME).exists()

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


# ---------------------------------------------------------------------------
# Test-only overrides
# ---------------------------------------------------------------------------


class TestUpdaterConfigFromOverrides:
    def test_equals_the_default_config_when_nothing_is_set(self) -> None:
        # `Updater` falls back to `UpdaterConfig()`, so passing this instead
        # must not change anything in production.
        assert updater_config_from_overrides() == UpdaterConfig()
        assert updater_config_from_overrides().check_interval_ticks == DEFAULT_CHECK_INTERVAL_TICKS
        assert updater_config_from_overrides().idle_ticks_required == DEFAULT_IDLE_TICKS_REQUIRED

    def test_tick_overrides_are_applied_and_nothing_else_changes(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("DATA_HUB_WATCHER_UPDATE_CHECK_INTERVAL_TICKS", "4")
        monkeypatch.setenv("DATA_HUB_WATCHER_UPDATE_IDLE_TICKS", "2")

        assert updater_config_from_overrides() == UpdaterConfig(
            idle_ticks_required=2, check_interval_ticks=4
        )

    def test_bad_values_fall_back_to_the_defaults(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("DATA_HUB_WATCHER_UPDATE_CHECK_INTERVAL_TICKS", "0")
        monkeypatch.setenv("DATA_HUB_WATCHER_UPDATE_IDLE_TICKS", "many")

        assert updater_config_from_overrides() == UpdaterConfig()

    def test_updater_built_from_it_checks_on_the_overridden_cadence(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("DATA_HUB_WATCHER_UPDATE_CHECK_INTERVAL_TICKS", "2")
        h = _make_updater(
            tmp_path,
            updater_cfg=replace(
                updater_config_from_overrides(), check_on_start=False, min_run_age_seconds=10.0
            ),
        )
        h.client.get_update_info.return_value = _info(latest=None)

        assert h.updater.on_tick() is None
        assert h.updater.on_tick() is not None  # the second tick checks
        h.client.get_update_info.assert_called_once()

    def test_idle_override_lets_a_non_mandatory_update_through_sooner(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("DATA_HUB_WATCHER_UPDATE_CHECK_INTERVAL_TICKS", "1")
        monkeypatch.setenv("DATA_HUB_WATCHER_UPDATE_IDLE_TICKS", "1")
        monkeypatch.setattr(
            "data_hub_watcher.updater.detect_install_method", lambda: InstallMethod.PIP
        )
        runner = MagicMock(return_value=_success_completed_process())
        h = _make_updater(
            tmp_path,
            upgrade_runner=runner,
            updater_cfg=replace(updater_config_from_overrides(), check_on_start=False),
        )
        h.client.get_update_info.return_value = _info(latest="9.9.9")
        h.state_db.last_run_reported_at.return_value = None
        h.counters.last_files_uploaded = 0

        # With the default 5 idle ticks, the first tick could not install.
        result = h.updater.on_tick()

        assert result is not None
        assert result.succeeded is True
        runner.assert_called_once()


class TestInProcessUpgradeIndexUrl:
    """The in-process upgrade installs from the test-only index when one is set."""

    def _upgrade_and_capture_argv(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> list[list[str]]:
        argvs: list[list[str]] = []

        def fake_subprocess(cmd: list[str], **_kw: Any) -> subprocess.CompletedProcess[str]:
            argvs.append(cmd)
            return _success_completed_process()

        def upgrade_runner(method: InstallMethod, *, target_version: str) -> Any:
            # The real `run_upgrade`, with only the subprocess call replaced,
            # so the command is built exactly as production builds it.
            return run_upgrade(method, target_version=target_version, runner=fake_subprocess)

        monkeypatch.setattr(
            "data_hub_watcher.updater.detect_install_method", lambda: InstallMethod.PIP
        )
        h = _make_updater(tmp_path, upgrade_runner=upgrade_runner)
        h.client.get_update_info.return_value = _info(latest="9.9.9")
        h.counters.last_files_uploaded = 0
        h.updater.on_tick()
        h.updater.on_tick()
        result = h.updater.on_tick()
        assert result is not None
        assert result.succeeded is True
        return argvs

    def test_installs_from_pypi_by_default(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        assert self._upgrade_and_capture_argv(tmp_path, monkeypatch) == [
            [
                sys.executable,
                "-m",
                "pip",
                "install",
                "--upgrade",
                "--index-url",
                DEFAULT_INDEX_URL,
                "data-hub-watcher==9.9.9",
            ]
        ]

    def test_installs_from_the_test_only_index(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("DATA_HUB_WATCHER_INDEX_URL", "http://127.0.0.1:8123/simple/")

        assert self._upgrade_and_capture_argv(tmp_path, monkeypatch) == [
            [
                sys.executable,
                "-m",
                "pip",
                "install",
                "--upgrade",
                "--index-url",
                "http://127.0.0.1:8123/simple/",
                "data-hub-watcher==9.9.9",
            ]
        ]
