"""Unit tests for `data_hub_watcher.runtime.build_runtime` wiring invariants.

The CLI `watch` command and the Windows-service entrypoint both delegate
to `build_runtime` to assemble the long-lived object graph. A silent
regression previously broke manual-mode uploads because the service path
forgot to wire `on_tick` on the `HeartbeatLoop`. These tests lock in the
wiring contract per `upload_mode` so any future drift fails loudly:

* auto mode    -> `detector._upload_cb` is `uploader.upload_files`
                  and `heartbeat._on_tick` ticks the auto-updater only
* manual mode  -> `detector._upload_cb` is `None`
                  and `heartbeat._on_tick` polls `uploader.poll_upload_queue`
                  *and* ticks the auto-updater
"""

from __future__ import annotations
from pathlib import Path
from typing import Literal
from unittest.mock import MagicMock

import pytest

from data_hub_watcher.constants import HEARTBEAT_INTERVAL_SECONDS
from data_hub_watcher.heartbeat import HeartbeatLoop, WatcherCounters
from data_hub_watcher.models import InstrumentConfig, RunDetectionConfig, WatcherConfig
from data_hub_watcher.monitor import FileMonitor
from data_hub_watcher.run_detector import RunDetector
from data_hub_watcher.runtime import build_runtime
from data_hub_watcher.state import StateDB
from data_hub_watcher.updater import Updater
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
        watcher_id=watcher_id,
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


class TestBuildRuntimeManualMode:
    """Manual mode: heartbeat polls the upload queue, detector does not upload."""

    def test_detector_upload_callback_is_none(self, tmp_path: Path, db_path: Path) -> None:
        cfg = _make_config(tmp_path, upload_mode="manual")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)

        try:
            # In manual mode the server decides what to upload, so the
            # detector must not eagerly hand files to the uploader.
            assert rt.detector._upload_cb is None
        finally:
            rt.state_db.close()

    def test_heartbeat_on_tick_polls_upload_queue(self, tmp_path: Path, db_path: Path) -> None:
        cfg = _make_config(tmp_path, upload_mode="manual")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)

        try:
            # The heartbeat must call `uploader.poll_upload_queue` on every
            # tick — this is the bug the runtime extraction was fixing.
            assert rt.heartbeat._on_tick is not None

            rt.uploader.poll_upload_queue = MagicMock()  # type: ignore[method-assign]
            rt.updater.on_tick = MagicMock(return_value=None)  # type: ignore[method-assign]
            rt.heartbeat._on_tick()
            rt.uploader.poll_upload_queue.assert_called_once_with()
            # The same hook must also feed the auto-updater so its idle
            # counter advances regardless of upload_mode.
            rt.updater.on_tick.assert_called_once_with()
        finally:
            rt.state_db.close()

    def test_on_tick_swallows_poll_exceptions(self, tmp_path: Path, db_path: Path) -> None:
        """Polling errors must not propagate out of the heartbeat tick,
        otherwise one transient server blip kills the heartbeat thread
        and the watcher goes silent until restart."""
        cfg = _make_config(tmp_path, upload_mode="manual")
        rt = build_runtime(client=MagicMock(), cfg=cfg, db_path=db_path)

        try:
            rt.uploader.poll_upload_queue = MagicMock(  # type: ignore[method-assign]
                side_effect=RuntimeError("boom")
            )
            rt.updater.on_tick = MagicMock(return_value=None)  # type: ignore[method-assign]
            assert rt.heartbeat._on_tick is not None
            rt.heartbeat._on_tick()
            rt.uploader.poll_upload_queue.assert_called_once_with()
            # Updater must still tick even when the upload-queue poll
            # blew up, otherwise a permanently-failing manual-mode
            # poll would also disable auto-updates.
            rt.updater.on_tick.assert_called_once_with()
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
