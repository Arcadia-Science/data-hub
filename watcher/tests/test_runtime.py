"""Unit tests for `data_hub_watcher.runtime.build_runtime` wiring invariants.

The CLI `watch` command and the Windows-service entrypoint both delegate
to `build_runtime` to assemble the long-lived object graph. A silent
regression previously broke manual-mode uploads because the service path
forgot to wire `on_tick` on the `HeartbeatLoop`. These tests lock in the
wiring contract per `upload_mode` so any future drift fails loudly:

* auto mode    -> `detector._upload_cb` is `uploader.upload_files`,
                  `heartbeat._on_tick` ticks the auto-updater only, and
                  `rt.upload_worker` is `None`
* manual mode  -> `detector._upload_cb` is `None`, `heartbeat._on_tick`
                  ticks the auto-updater only (uploads now run on the
                  dedicated `UploadQueueWorker` thread, not the heartbeat),
                  and `rt.upload_worker` is set
"""

from __future__ import annotations
import json
from pathlib import Path
from typing import Any, Literal
from unittest.mock import MagicMock

import pytest

from data_hub_watcher.constants import HEARTBEAT_INTERVAL_SECONDS
from data_hub_watcher.events import EventType
from data_hub_watcher.heartbeat import HeartbeatLoop, WatcherCounters
from data_hub_watcher.models import InstrumentConfig, RunDetectionConfig, WatcherConfig
from data_hub_watcher.monitor import FileMonitor
from data_hub_watcher.run_detector import RunDetector
from data_hub_watcher.runtime import (
    ShutdownReason,
    WatcherRuntime,
    _summarize_worker_failure,
    build_runtime,
    classify_shutdown,
    start_runtime,
    stop_runtime,
)
from data_hub_watcher.state import StateDB
from data_hub_watcher.updater import Updater, write_upgrade_marker
from data_hub_watcher.upgrade_worker import (
    UpgradeResult,
    upgrade_result_path,
)
from data_hub_watcher.uploader import Uploader


def _make_config(
    tmp_path: Path,
    *,
    upload_mode: Literal["auto", "manual"],
    watcher_id: str | None = "w-test",
) -> WatcherConfig:
    """Build a minimal valid `WatcherConfig` rooted in *tmp_path*."""
    watch_dir = tmp_path / "data"
    watch_dir.mkdir()
    # Give the watch dir one matching file so `WatcherConfig` doesn't
    # emit the "no files match" warning during validation.
    (watch_dir / "RUN001_sample.csv").write_text("a,b\n1,2\n")
    instrument = InstrumentConfig(
        id="test-instrument",
        watch_directory=watch_dir,
        file_patterns=["*.csv"],
        upload_mode=upload_mode,
        run_detection=RunDetectionConfig(pattern=r"^([^_]+)", recursive=False),
    )
    return WatcherConfig(
        version=1,
        environment="staging",
        watcher_ids={"staging": watcher_id} if watcher_id else {},
        instrument=instrument,
    )


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "state.sqlite"


class TestBuildRuntimeAutoMode:
    """Auto mode: detector drives uploads, heartbeat does not poll."""

    def test_detector_upload_callback_is_uploader_upload_files(
        self, tmp_path: Path, db_path: Path
    ) -> None:
        cfg = _make_config(tmp_path, upload_mode="auto")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)

        try:
            # The detector must call Uploader.upload_files (bound method)
            # after reporting a run so auto-mode uploads actually fire.
            # Bound-method identity (`is`) fails because Python synthesizes
            # a fresh bound-method object on each attribute access, so
            # compare the underlying function and bound instance instead.
            cb = rt.detector._upload_cb
            assert cb is not None
            assert cb.__func__ is Uploader.upload_files  # type: ignore[union-attr]
            assert cb.__self__ is rt.uploader  # type: ignore[union-attr]
        finally:
            rt.state_db.close()

    def test_heartbeat_on_tick_only_drives_updater(self, tmp_path: Path, db_path: Path) -> None:
        cfg = _make_config(tmp_path, upload_mode="auto")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)

        try:
            # Auto mode has no server-driven upload queue to poll, but
            # the in-process updater still needs a tick on every
            # heartbeat — it gates auto-updates on the cumulative idle
            # window across many heartbeats. So the hook is non-None
            # and ticking it must not call `poll_upload_queue`.
            assert rt.heartbeat._on_tick is not None
            rt.uploader.poll_upload_queue = MagicMock()  # type: ignore[method-assign]
            rt.updater.on_tick = MagicMock(return_value=None)  # type: ignore[method-assign]
            rt.heartbeat._on_tick()
            rt.uploader.poll_upload_queue.assert_not_called()
            rt.updater.on_tick.assert_called_once_with()
        finally:
            rt.state_db.close()

    def test_auto_mode_has_no_upload_worker(self, tmp_path: Path, db_path: Path) -> None:
        cfg = _make_config(tmp_path, upload_mode="auto")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)

        try:
            # Auto-mode uploads run on the monitor's stability-checker thread
            # via the detector callback, so there is no upload-queue worker.
            assert rt.upload_worker is None
        finally:
            rt.state_db.close()


class TestBuildRuntimeManualMode:
    """Manual mode: a dedicated worker polls the upload queue off the heartbeat."""

    def test_detector_upload_callback_is_none(self, tmp_path: Path, db_path: Path) -> None:
        cfg = _make_config(tmp_path, upload_mode="manual")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)

        try:
            # In manual mode the server decides what to upload, so the
            # detector must not eagerly hand files to the uploader.
            assert rt.detector._upload_cb is None
        finally:
            rt.state_db.close()

    def test_heartbeat_on_tick_does_not_poll_upload_queue(
        self, tmp_path: Path, db_path: Path
    ) -> None:
        cfg = _make_config(tmp_path, upload_mode="manual")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)

        try:
            # Uploads moved off the heartbeat thread onto the worker, so the
            # tick must only feed the updater — a slow upload can no longer
            # delay a heartbeat and make a busy watcher look offline.
            assert rt.heartbeat._on_tick is not None
            rt.uploader.poll_upload_queue = MagicMock()  # type: ignore[method-assign]
            rt.updater.on_tick = MagicMock(return_value=None)  # type: ignore[method-assign]
            rt.heartbeat._on_tick()
            rt.uploader.poll_upload_queue.assert_not_called()
            rt.updater.on_tick.assert_called_once_with()
        finally:
            rt.state_db.close()

    def test_manual_mode_builds_upload_worker_sharing_stop_event(
        self, tmp_path: Path, db_path: Path
    ) -> None:
        cfg = _make_config(tmp_path, upload_mode="manual")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)

        try:
            # The worker must wrap this runtime's uploader and share its stop
            # event so a shutdown can interrupt an in-flight upload.
            assert rt.upload_worker is not None
            assert rt.upload_worker._uploader is rt.uploader
            assert rt.upload_worker._stop_event is rt.uploader._stop_event
        finally:
            rt.state_db.close()

    def test_on_tick_swallows_updater_exceptions(self, tmp_path: Path, db_path: Path) -> None:
        """Same containment guarantee for the updater half of the hook:
        a buggy update check must not kill the heartbeat thread."""
        cfg = _make_config(tmp_path, upload_mode="auto")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)

        try:
            rt.updater.on_tick = MagicMock(  # type: ignore[method-assign]
                side_effect=RuntimeError("update broke")
            )
            assert rt.heartbeat._on_tick is not None
            rt.heartbeat._on_tick()
            rt.updater.on_tick.assert_called_once_with()
        finally:
            rt.state_db.close()


class TestStopRuntimeUploadWorkerOrdering:
    """`stop_runtime` must stop the upload worker before closing the state DB.

    Regression guard for the prod "Cannot operate on a closed database" race:
    a still-running upload wrote to the DB after `close()` because teardown
    didn't wait for the upload thread.
    """

    @staticmethod
    def _runtime_with_mocks(state_db: MagicMock, upload_worker: Any) -> WatcherRuntime:
        return WatcherRuntime(
            state_db=state_db,
            counters=MagicMock(),
            reporter=MagicMock(),
            uploader=MagicMock(),
            detector=MagicMock(),
            monitor=MagicMock(),
            heartbeat=MagicMock(),
            updater=MagicMock(),
            config_dir=Path("/tmp"),
            upload_worker=upload_worker,
        )

    def test_closes_db_when_worker_stops_cleanly(self) -> None:
        state_db = MagicMock()
        worker = MagicMock()
        worker.stop.return_value = True
        rt = self._runtime_with_mocks(state_db, worker)

        stop_runtime(rt, stopped_message="Watcher stopped")

        worker.stop.assert_called_once()
        state_db.close.assert_called_once_with()

    def test_skips_close_when_worker_still_running(self) -> None:
        # A large PUT outliving the join must not have the DB yanked out from
        # under it; teardown leaves the connection open and lets the OS reap it.
        state_db = MagicMock()
        worker = MagicMock()
        worker.stop.return_value = False
        rt = self._runtime_with_mocks(state_db, worker)

        stop_runtime(rt, stopped_message="Watcher stopped")

        worker.stop.assert_called_once()
        state_db.close.assert_not_called()

    def test_closes_db_in_auto_mode_without_worker(self) -> None:
        state_db = MagicMock()
        rt = self._runtime_with_mocks(state_db, None)

        stop_runtime(rt, stopped_message="Watcher stopped")

        state_db.close.assert_called_once_with()


class TestBuildRuntimeSharedDependencies:
    """Cross-object wiring invariants that apply to both upload modes."""

    @pytest.mark.parametrize("upload_mode", ["auto", "manual"])
    def test_runtime_fields_have_expected_types(
        self, tmp_path: Path, db_path: Path, upload_mode: Literal["auto", "manual"]
    ) -> None:
        cfg = _make_config(tmp_path, upload_mode=upload_mode)
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)

        try:
            assert isinstance(rt.state_db, StateDB)
            assert isinstance(rt.counters, WatcherCounters)
            assert isinstance(rt.uploader, Uploader)
            assert isinstance(rt.detector, RunDetector)
            assert isinstance(rt.monitor, FileMonitor)
            assert isinstance(rt.heartbeat, HeartbeatLoop)
            assert isinstance(rt.updater, Updater)
        finally:
            rt.state_db.close()

    @pytest.mark.parametrize("upload_mode", ["auto", "manual"])
    def test_counters_are_shared_across_components(
        self, tmp_path: Path, db_path: Path, upload_mode: Literal["auto", "manual"]
    ) -> None:
        """Uploader, detector, and heartbeat must share a single
        `WatcherCounters` so the heartbeat actually sees increments."""
        cfg = _make_config(tmp_path, upload_mode=upload_mode)
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)

        try:
            assert rt.uploader._counters is rt.counters
            assert rt.detector._counters is rt.counters
            assert rt.heartbeat.counters is rt.counters
        finally:
            rt.state_db.close()

    @pytest.mark.parametrize("upload_mode", ["auto", "manual"])
    def test_heartbeat_reflects_upload_mode(
        self, tmp_path: Path, db_path: Path, upload_mode: Literal["auto", "manual"]
    ) -> None:
        cfg = _make_config(tmp_path, upload_mode=upload_mode)
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)

        try:
            assert rt.heartbeat._upload_mode == upload_mode
            assert rt.heartbeat._interval == HEARTBEAT_INTERVAL_SECONDS
            assert rt.heartbeat._watcher_id == "w-test"
            assert rt.heartbeat._instrument_id == cfg.instrument.id
        finally:
            rt.state_db.close()


class TestBuildRuntimeErrors:
    def test_missing_watcher_id_raises(self, tmp_path: Path, db_path: Path) -> None:
        cfg = _make_config(tmp_path, upload_mode="auto", watcher_id=None)
        with pytest.raises(ValueError, match="watcher_id"):
            build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)


class TestBuildRuntimeBaselineSeeding:
    """Baseline seeding gating: only `new-only` envs with no history seed."""

    def _cfg(
        self,
        tmp_path: Path,
        *,
        environment: str,
        initial_scan: Literal["full", "new-only"] | None = None,
    ) -> WatcherConfig:
        watch_dir = tmp_path / "data"
        watch_dir.mkdir(exist_ok=True)
        (watch_dir / "RUN001_sample.csv").write_text("a,b\n1,2\n")
        return WatcherConfig(
            version=1,
            environment=environment,  # type: ignore[arg-type]
            api_base_url="https://x.example/api/v1" if environment == "preview" else None,
            watcher_ids={environment: "w-test"},
            initial_scan=initial_scan,
            instrument=InstrumentConfig(
                id="test-instrument",
                watch_directory=watch_dir,
                file_patterns=["*.csv"],
                run_detection=RunDetectionConfig(pattern=r"^([^_]+)", recursive=False),
            ),
        )

    def test_new_only_env_enables_baseline_seeding(self, tmp_path: Path, db_path: Path) -> None:
        # Seeding itself happens in the monitor's initial scan; `build_runtime`
        # only decides whether to arm it. The scan effect is covered by
        # `test_monitor_initial_scan.TestSeedBaselineScan`.
        cfg = self._cfg(tmp_path, environment="staging")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)
        try:
            assert rt.monitor._seed_baseline is True
        finally:
            rt.state_db.close()

    def test_production_does_not_seed_baseline(self, tmp_path: Path, db_path: Path) -> None:
        cfg = self._cfg(tmp_path, environment="production")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)
        try:
            assert rt.monitor._seed_baseline is False
        finally:
            rt.state_db.close()

    def test_does_not_reseed_when_history_exists(self, tmp_path: Path, db_path: Path) -> None:
        # An existing upload row means this environment already has real
        # state; reseeding would wrongly mark genuinely-new files as backlog.
        pre = StateDB(db_path)
        pre.record_upload(
            "old.csv", "sha", "s3/old.csv", relative_path="old.csv", size_bytes=1, mtime=1.0
        )
        pre.close()

        cfg = self._cfg(tmp_path, environment="staging")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)
        try:
            assert rt.monitor._seed_baseline is False
        finally:
            rt.state_db.close()

    def test_explicit_full_override_skips_seeding(self, tmp_path: Path, db_path: Path) -> None:
        cfg = self._cfg(tmp_path, environment="staging", initial_scan="full")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)
        try:
            assert rt.monitor._seed_baseline is False
        finally:
            rt.state_db.close()

    def test_seeded_history_disarms_seeding_on_next_build(
        self, tmp_path: Path, db_path: Path
    ) -> None:
        # First start seeds (and marks the sentinel) via the monitor scan; a
        # later `build_runtime` against the same DB must not re-arm seeding,
        # even for an empty dir where the sentinel is the only signal.
        cfg = self._cfg(tmp_path, environment="staging")
        (tmp_path / "data" / "RUN001_sample.csv").unlink()

        first = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)
        try:
            assert first.monitor._seed_baseline is True
            first.monitor._initial_scan()
            assert first.state_db.baseline_established() is True
        finally:
            first.state_db.close()

        second = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)
        try:
            assert second.monitor._seed_baseline is False
        finally:
            second.state_db.close()


class TestBuildRuntimeConfigDir:
    """Plumbing of the explicit ``config_dir`` parameter through the runtime.

    Regression guard for the auto-update silent no-op on Windows: the
    Windows service runs as LocalSystem (so ``Path("~/.data-hub")``
    inside the service process resolves to the SYSTEM profile, not
    the operator's profile) but the upgrade worker has its sentinel
    paths baked in at install time under the operator's profile.
    Letting the running service fall back to ``DEFAULT_CONFIG_DIR``
    rather than the registry-resolved directory caused the service to
    write the request sentinel into a directory the worker never
    reads from, so every auto-update tick fired ``update_started``
    and the worker logged "no request sentinel" without doing
    anything.
    """

    def test_explicit_config_dir_overrides_default(
        self, tmp_path: Path, db_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Patch DEFAULT_CONFIG_DIR to a *different* path so we can
        # tell apart "fell back to the default" from "honoured the
        # explicit argument".
        import data_hub_watcher.runtime as rt_module

        wrong_dir = tmp_path / "system-profile"
        right_dir = tmp_path / "operator-profile"
        wrong_dir.mkdir()
        right_dir.mkdir()
        monkeypatch.setattr(rt_module, "DEFAULT_CONFIG_DIR", wrong_dir)

        cfg = _make_config(tmp_path, upload_mode="auto")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path, config_dir=right_dir)
        try:
            assert rt.config_dir == right_dir
            # The Updater MUST receive the same dir we passed in;
            # this is what makes ``write_upgrade_request`` land in
            # the directory the SYSTEM-owned worker reads from.
            assert rt.updater._config_dir == right_dir
        finally:
            rt.state_db.close()

    def test_omitted_config_dir_falls_back_to_module_default(
        self, tmp_path: Path, db_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The CLI ``watch`` command relies on this fallback: it runs
        # as the operator user, so ``DEFAULT_CONFIG_DIR`` resolves
        # correctly and the CLI doesn't need to thread the argument
        # through. Pin the behaviour so a future refactor doesn't
        # silently make the argument required.
        import data_hub_watcher.runtime as rt_module

        fake_default = tmp_path / "operator-profile"
        fake_default.mkdir()
        monkeypatch.setattr(rt_module, "DEFAULT_CONFIG_DIR", fake_default)

        cfg = _make_config(tmp_path, upload_mode="auto")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)
        try:
            assert rt.config_dir == fake_default
            assert rt.updater._config_dir == fake_default
        finally:
            rt.state_db.close()


class TestClassifyShutdown:
    """Pin the WATCHER_STOPPED message text shared by the CLI ``watch``
    command and the Windows service. Both call sites used to hard-code
    their own strings, which made the service path's WATCHER_STOPPED
    indistinguishable from a normal stop on auto-update restarts —
    breaking dashboard correlation with the matching ``update_started``
    event.
    """

    def test_normal_stop_uses_role_stopped(self, tmp_path: Path, db_path: Path) -> None:
        cfg = _make_config(tmp_path, upload_mode="auto")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)
        try:
            decision = classify_shutdown(rt, role="Watcher")
            assert decision == ShutdownReason(
                is_upgrade_restart=False,
                stopped_message="Watcher stopped",
            )
        finally:
            rt.state_db.close()

    def test_upgrade_restart_uses_role_specific_message(
        self, tmp_path: Path, db_path: Path
    ) -> None:
        cfg = _make_config(tmp_path, upload_mode="auto")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)
        try:
            rt.upgrade_restart_event.set()
            decision = classify_shutdown(rt, role="Service")
            assert decision.is_upgrade_restart is True
            # The message is keyed on the *role* so the CLI and the
            # service produce naturally-readable but distinct text in
            # the events stream — a single "Watcher restarting…" log
            # would look weird on Windows where the dashboard already
            # shows the watcher's host as a service.
            assert decision.stopped_message == "Service restarting for auto-update"
        finally:
            rt.state_db.close()

    def test_role_is_substituted_into_both_messages(self, tmp_path: Path, db_path: Path) -> None:
        cfg = _make_config(tmp_path, upload_mode="auto")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)
        try:
            assert classify_shutdown(rt, role="Watcher").stopped_message == "Watcher stopped"
            rt.upgrade_restart_event.set()
            assert (
                classify_shutdown(rt, role="Watcher").stopped_message
                == "Watcher restarting for auto-update"
            )
        finally:
            rt.state_db.close()


class TestStartRuntimePostUpgradeMerge:
    """Post-restart event evaluation merges the worker's result sentinel.

    The Windows uv-tool worker writes ``.upgrade-result.json`` with the
    captured ``uv`` stdout/stderr/returncode. ``start_runtime`` reads
    both the marker AND the result, merging the worker fields into the
    emitted ``UPDATE_SUCCEEDED`` / ``UPDATE_FAILED`` event so the
    dashboard sees the same level of detail it used to get from the
    in-process subprocess.
    """

    def _make_runtime_with_reporter(self, tmp_path: Path) -> tuple[Any, MagicMock]:
        cfg = _make_config(tmp_path, upload_mode="auto")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=tmp_path / "state.sqlite")
        # Replace the real reporter with a mock so we can inspect
        # which events were queued without round-tripping the API
        # client.
        mock_reporter = MagicMock()
        rt.reporter = mock_reporter
        # Stop monitor + heartbeat from really starting since this
        # test only cares about the pre-startup event evaluation.
        rt.monitor = MagicMock()
        rt.heartbeat = MagicMock()
        rt.detector = MagicMock()
        return rt, mock_reporter

    def _patch_default_config_dir(self, monkeypatch: pytest.MonkeyPatch, target: Path) -> None:
        import data_hub_watcher.runtime as rt_module

        monkeypatch.setattr(rt_module, "DEFAULT_CONFIG_DIR", target)

    def test_success_merges_worker_result_into_event(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Pretend we just restarted into the upgraded version:
        # write the marker, drop a successful result sentinel,
        # invoke start_runtime, and assert the emitted event
        # carries the worker fields.
        config_dir = tmp_path / ".data-hub"
        config_dir.mkdir()
        self._patch_default_config_dir(monkeypatch, config_dir)
        # Pretend we're on Windows so the "result missing" branch
        # behaves correctly even though that branch is exercised in
        # a separate test.
        monkeypatch.setattr("data_hub_watcher.runtime.sys.platform", "win32")

        # Marker says "we asked for 9.9.9". The current version
        # comes from importlib.metadata; pin both ends to the same
        # value so evaluate_upgrade_marker classifies it as success.
        from data_hub_watcher.constants import WATCHER_VERSION

        write_upgrade_marker(
            config_dir,
            target_version=WATCHER_VERSION,
            previous_version="0.1.4",
        )
        # Worker drops the result sentinel after `uv` exits.
        result = UpgradeResult(
            request_id="abcd-1234",
            target_version=WATCHER_VERSION,
            succeeded=True,
            returncode=0,
            stdout_tail="installed 17 packages",
            stderr_tail="",
            finished_at="2026-05-04T22:30:00+00:00",
            error=None,
        )
        upgrade_result_path(config_dir).write_text(json.dumps(result.to_dict()), encoding="utf-8")

        rt, mock_reporter = self._make_runtime_with_reporter(tmp_path)
        try:
            start_runtime(rt, started_message="Watcher started on test")

            queued = [c.args[0] for c in mock_reporter.queue_event.call_args_list]
            update_events = [e for e in queued if e.event_type is EventType.UPDATE_SUCCEEDED]
            assert len(update_events) == 1
            details = update_events[0].details
            assert details["target_version"] == WATCHER_VERSION
            assert details["previous_version"] == "0.1.4"
            assert details["via_worker"] is True
            assert details["worker_returncode"] == 0
            assert details["worker_stdout_tail"] == "installed 17 packages"
            assert details["worker_request_id"] == "abcd-1234"
        finally:
            rt.state_db.close()

        # Sentinel must have been consumed so the next restart
        # doesn't re-emit it.
        assert not upgrade_result_path(config_dir).exists()

    def test_failure_with_worker_result_carries_returncode_and_stderr(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        config_dir = tmp_path / ".data-hub"
        config_dir.mkdir()
        self._patch_default_config_dir(monkeypatch, config_dir)

        # Marker says we tried to install 99.99.99 but the running
        # version is whatever WATCHER_VERSION resolves to — that
        # mismatch is what makes evaluate_upgrade_marker classify
        # this as a failure.
        write_upgrade_marker(
            config_dir,
            target_version="99.99.99",
            previous_version="0.1.4",
        )
        result = UpgradeResult(
            request_id="abcd",
            target_version="99.99.99",
            succeeded=False,
            returncode=2,
            stdout_tail="",
            stderr_tail="error: Access is denied. (os error 5)",
            finished_at="2026-05-04T22:30:00+00:00",
            error=None,
        )
        upgrade_result_path(config_dir).write_text(json.dumps(result.to_dict()), encoding="utf-8")

        rt, mock_reporter = self._make_runtime_with_reporter(tmp_path)
        try:
            start_runtime(rt, started_message="Watcher started on test")

            queued = [c.args[0] for c in mock_reporter.queue_event.call_args_list]
            failures = [e for e in queued if e.event_type is EventType.UPDATE_FAILED]
            assert len(failures) == 1
            details = failures[0].details
            assert details["target_version"] == "99.99.99"
            assert details["worker_returncode"] == 2
            assert "Access is denied" in details["worker_stderr_tail"]
            assert details["via_worker"] is True
            # `worker_result_missing` must NOT be set when we have
            # a real result sentinel — that flag is only for the
            # "worker crashed before writing" case.
            assert "worker_result_missing" not in details
        finally:
            rt.state_db.close()

    def test_worker_failure_overrides_apparent_marker_success(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The most important regression guard: a partial install where
        # uv exits non-zero AFTER updating enough Python source to
        # fool the marker version comparison must STILL surface as
        # UPDATE_FAILED with the actual installer error. Historically
        # this masqueraded as success because we trusted the marker
        # version comparison alone.
        from data_hub_watcher.constants import WATCHER_VERSION

        config_dir = tmp_path / ".data-hub"
        config_dir.mkdir()
        self._patch_default_config_dir(monkeypatch, config_dir)

        # Marker says success (version comparison would match).
        write_upgrade_marker(
            config_dir,
            target_version=WATCHER_VERSION,
            previous_version="0.1.4",
        )
        # But the worker reports failure with a real uv error message.
        result = UpgradeResult(
            request_id="abcd",
            target_version=WATCHER_VERSION,
            succeeded=False,
            returncode=2,
            stdout_tail="Installed 17 packages",
            stderr_tail=(
                "error: failed to remove directory `C:\\...\\Scripts`: "
                "Access is denied. (os error 5)"
            ),
            finished_at="2026-05-04T22:30:00+00:00",
            error=None,
        )
        upgrade_result_path(config_dir).write_text(json.dumps(result.to_dict()), encoding="utf-8")

        rt, mock_reporter = self._make_runtime_with_reporter(tmp_path)
        try:
            start_runtime(rt, started_message="Watcher started on test")

            queued = [c.args[0] for c in mock_reporter.queue_event.call_args_list]
            # Must emit UPDATE_FAILED, NOT UPDATE_SUCCEEDED, even
            # though the version comparison would have said success.
            failures = [e for e in queued if e.event_type is EventType.UPDATE_FAILED]
            successes = [e for e in queued if e.event_type is EventType.UPDATE_SUCCEEDED]
            assert len(failures) == 1
            assert len(successes) == 0
            details = failures[0].details
            # The reason should be derived from the worker's
            # stderr — the actual uv error, not the generic marker
            # classification.
            assert "Access is denied" in details["reason"] or "denied" in details["reason"].lower()
            assert details["worker_returncode"] == 2
            assert "Access is denied" in details["worker_stderr_tail"]
            # The marker's own classification is preserved so the
            # dashboard can show both signals when they disagree.
            assert details["marker_succeeded"] is True
            assert "marker_reason" in details
        finally:
            rt.state_db.close()

    def test_worker_warning_flag_set_when_success_with_dirty_stderr(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # uv occasionally prints deprecation/info warnings to stderr
        # even on a clean install. The worker reports success in that
        # case but we still want the dashboard to flag the event so
        # an operator can investigate the warning text.
        from data_hub_watcher.constants import WATCHER_VERSION

        config_dir = tmp_path / ".data-hub"
        config_dir.mkdir()
        self._patch_default_config_dir(monkeypatch, config_dir)

        write_upgrade_marker(
            config_dir,
            target_version=WATCHER_VERSION,
            previous_version="0.1.4",
        )
        result = UpgradeResult(
            request_id="abcd",
            target_version=WATCHER_VERSION,
            succeeded=True,
            returncode=3,  # non-zero but worker overrode succeeded=True
            stdout_tail="installed",
            stderr_tail="warning: deprecated index format",
            finished_at="2026-05-04T22:30:00+00:00",
            error=None,
        )
        upgrade_result_path(config_dir).write_text(json.dumps(result.to_dict()), encoding="utf-8")

        rt, mock_reporter = self._make_runtime_with_reporter(tmp_path)
        try:
            start_runtime(rt, started_message="Watcher started on test")
            queued = [c.args[0] for c in mock_reporter.queue_event.call_args_list]
            successes = [e for e in queued if e.event_type is EventType.UPDATE_SUCCEEDED]
            assert len(successes) == 1
            details = successes[0].details
            # Soft warning flag so the dashboard can surface "look
            # at this even though it succeeded".
            assert details.get("worker_warning") is True
            assert "deprecated" in details["worker_stderr_tail"]
        finally:
            rt.state_db.close()

    def test_failure_without_worker_result_flags_missing_on_windows(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Worker crashed between Stop-Service and writing the result
        # sentinel — the marker is on disk but no result. On Windows
        # this should set `worker_result_missing=True` so the
        # operator knows to look at the upgrade-worker log, not at
        # the in-process subprocess output (which doesn't exist).
        config_dir = tmp_path / ".data-hub"
        config_dir.mkdir()
        self._patch_default_config_dir(monkeypatch, config_dir)
        monkeypatch.setattr("data_hub_watcher.runtime.sys.platform", "win32")

        write_upgrade_marker(
            config_dir,
            target_version="99.99.99",
            previous_version="0.1.4",
        )
        # No result sentinel.

        rt, mock_reporter = self._make_runtime_with_reporter(tmp_path)
        try:
            start_runtime(rt, started_message="Watcher started on test")

            queued = [c.args[0] for c in mock_reporter.queue_event.call_args_list]
            failures = [e for e in queued if e.event_type is EventType.UPDATE_FAILED]
            assert len(failures) == 1
            details = failures[0].details
            assert details.get("worker_result_missing") is True
            # No worker fields since there's no sentinel to merge from.
            assert "worker_returncode" not in details
        finally:
            rt.state_db.close()

    def test_post_restart_inspection_uses_runtime_config_dir_not_default(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Regression guard for the Windows-service silent no-op:
        # under LocalSystem ``DEFAULT_CONFIG_DIR`` resolves to the
        # SYSTEM profile, but the upgrade marker / result / request
        # all live in the operator's profile (where the worker reads
        # from). ``start_runtime`` MUST consult ``rt.config_dir`` —
        # not the module-level ``DEFAULT_CONFIG_DIR`` — so a service
        # that's been threaded the right directory at construction
        # time picks up its own marker.
        from data_hub_watcher.constants import WATCHER_VERSION

        wrong_dir = tmp_path / "system-profile-data-hub"
        right_dir = tmp_path / "operator-profile-data-hub"
        wrong_dir.mkdir()
        right_dir.mkdir()

        # Marker + result land in the *right* (registry-resolved)
        # directory, mirroring what the running service writes when
        # it calls ``write_upgrade_marker(rt.config_dir, ...)``.
        write_upgrade_marker(
            right_dir,
            target_version=WATCHER_VERSION,
            previous_version="0.1.4",
        )
        result = UpgradeResult(
            request_id="rid",
            target_version=WATCHER_VERSION,
            succeeded=True,
            returncode=0,
            stdout_tail="installed 17 packages",
            stderr_tail="",
            finished_at="2026-05-06T11:54:22+00:00",
            error=None,
        )
        upgrade_result_path(right_dir).write_text(json.dumps(result.to_dict()), encoding="utf-8")

        # Patch ``DEFAULT_CONFIG_DIR`` to the *wrong* directory so
        # an accidental fallback would silently miss the marker
        # and emit no UPDATE_SUCCEEDED event at all.
        self._patch_default_config_dir(monkeypatch, wrong_dir)
        monkeypatch.setattr("data_hub_watcher.runtime.sys.platform", "win32")

        cfg = _make_config(tmp_path, upload_mode="auto")
        rt = build_runtime(
            client=MagicMock(),
            cfg=cfg,
            db_path=tmp_path / "state.sqlite",
            config_dir=right_dir,
        )
        mock_reporter = MagicMock()
        rt.reporter = mock_reporter
        rt.monitor = MagicMock()
        rt.heartbeat = MagicMock()
        rt.detector = MagicMock()
        try:
            start_runtime(rt, started_message="Service started on test")

            queued = [c.args[0] for c in mock_reporter.queue_event.call_args_list]
            successes = [e for e in queued if e.event_type is EventType.UPDATE_SUCCEEDED]
            assert len(successes) == 1, (
                "start_runtime fell back to DEFAULT_CONFIG_DIR — the marker in "
                "the registry-resolved config_dir was missed entirely."
            )
            details = successes[0].details
            assert details["worker_request_id"] == "rid"
            assert details["worker_stdout_tail"] == "installed 17 packages"
        finally:
            rt.state_db.close()

        # Sentinel must be consumed from the *right* directory; the
        # wrong directory is irrelevant and unchanged.
        assert not upgrade_result_path(right_dir).exists()


class TestSummarizeWorkerFailure:
    """Direct coverage for the dashboard-headline picker.

    The full stderr_tail is always preserved on the event details, so
    this helper only chooses the one-liner reason. The selection
    priority is:

    1. The first ``error: <msg>`` (uv's own convention).
    2. The first stderr line containing ``error`` / ``failed`` /
       ``denied`` (covers tools that don't follow uv's convention,
       e.g. PowerShell traps echoed to stderr by the worker).
    3. The worker's PowerShell-trap ``error`` field.
    4. ``uv exited <N>`` if all we have is a non-zero returncode.
    """

    def _result(
        self,
        *,
        stderr: str = "",
        returncode: int | None = 1,
        error: str | None = None,
    ) -> UpgradeResult:
        return UpgradeResult(
            request_id="rid",
            target_version="9.9.9",
            succeeded=False,
            returncode=returncode,
            stdout_tail="",
            stderr_tail=stderr,
            finished_at="2026-05-04T22:30:00+00:00",
            error=error,
        )

    def test_picks_uv_error_prefix_line(self) -> None:
        # uv's actual headline lives behind the ``error:`` prefix.
        # We must surface it verbatim (truncated to 200) rather than
        # the surrounding informational chatter.
        result = self._result(
            stderr=(
                "Resolved 17 packages in 12ms\n"
                "Prepared 17 packages in 800ms\n"
                "error: failed to remove directory `C:\\...\\Scripts`: "
                "Access is denied. (os error 5)\n"
                "Suggestion: stop the service and retry.\n"
            )
        )
        assert _summarize_worker_failure(result) == (
            "error: failed to remove directory `C:\\...\\Scripts`: Access is denied. (os error 5)"
        )

    def test_uv_error_prefix_takes_priority_over_substring_match(self) -> None:
        # Without the prefix-anchoring, the historical substring
        # heuristic would pick "Resolution failed for 17 packages"
        # because it appears first and contains "failed". The
        # ``error:`` line further down is the actual diagnostic and
        # must win.
        result = self._result(
            stderr=(
                "Resolution failed for 17 packages (this is informational)\n"
                "error: HTTP 503 from upstream index\n"
            )
        )
        assert _summarize_worker_failure(result) == "error: HTTP 503 from upstream index"

    def test_falls_back_to_substring_when_no_uv_error_prefix(self) -> None:
        # Worker captured a PowerShell trap or Windows API error that
        # didn't go through uv's `error:` formatter. The historical
        # heuristic still fires so we don't fall through to the
        # generic "uv exited N" message.
        result = self._result(
            stderr="Stop-Service : Access is denied (CategoryInfo: PermissionDenied)\n"
        )
        assert _summarize_worker_failure(result).startswith("Stop-Service")
        assert "Access is denied" in _summarize_worker_failure(result)

    def test_skips_innocuous_substring_match_when_better_line_follows(self) -> None:
        # An informational line that mentions "no errors so far" must
        # NOT be picked as the headline when a real ``error:`` line
        # is also present. This is the regression the prefix-anchor
        # exists to prevent.
        result = self._result(
            stderr=("Pre-flight: no errors so far\nerror: PyPI returned 503 Service Unavailable\n")
        )
        assert _summarize_worker_failure(result) == ("error: PyPI returned 503 Service Unavailable")

    def test_caps_long_lines_at_200_chars(self) -> None:
        long_msg = "x" * 500
        result = self._result(stderr=f"error: {long_msg}\n")
        summary = _summarize_worker_failure(result)
        # Cap is enforced so the dashboard one-liner doesn't blow
        # up; the full 500-char tail is still on the event details.
        assert len(summary) == 200
        assert summary.startswith("error: ")

    def test_uses_worker_exception_field_when_stderr_empty(self) -> None:
        # PowerShell trapped before uv could even start (e.g. ENOENT
        # on the binary). The worker stamps the exception text into
        # `error` and we surface that as the headline.
        result = self._result(stderr="", error="Cannot find path 'uv.exe'")
        assert _summarize_worker_failure(result) == ("worker exception: Cannot find path 'uv.exe'")

    def test_falls_back_to_returncode_when_no_other_signal(self) -> None:
        result = self._result(stderr="", returncode=137)
        assert _summarize_worker_failure(result) == "uv exited 137"

    def test_returns_generic_text_when_all_signals_empty(self) -> None:
        # No stderr, no error, returncode is 0 (worker reported
        # failure with succeeded=False but no useful diagnostics).
        # We still need *some* string for the dashboard message.
        result = self._result(stderr="", returncode=0, error=None)
        assert _summarize_worker_failure(result) == "worker reported failure"

    def test_non_upgrade_result_returns_generic_text(self) -> None:
        # Defensive: callers shouldn't pass non-UpgradeResult values,
        # but the helper must not raise when they do.
        assert _summarize_worker_failure(object()) == "worker reported failure"
