"""Two smoke tests that prove the end-to-end plumbing against the real server.

They run the real ``data-hub-watcher`` from a ``uv tool`` install, and check what the server
and the S3 stand-in end up with. The scenario files test each state machine in depth; these
two only show that a PC can be set up, started, watched and stopped, and that a run folder
reaches the stand-in. This file belongs to the foundation, not to a scenario owner.
"""

from __future__ import annotations
from pathlib import Path

import pytest

from data_hub_shared.testing_proxy import FaultProxy
from e2e_support.drivers import (
    DEFAULT_TIMER_OVERRIDES,
    InitAnswers,
    RunDetection,
)
from e2e_support.factory import WatcherFactory
from e2e_support.server import ServerView

pytestmark = pytest.mark.e2e


@pytest.mark.covers(
    "init.prompts->config_saved",
    "watcher.none->registered",
    "startup.stopped->watching",
    "watcher.registered->watching",
    "watcher.watching->stopped",
    "process.stop->clean_exit",
    "event.watcher_started->emitted",
    "event.watcher_stopped->emitted",
)
def test_init_start_and_graceful_stop(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    watch_dir: Path,
    watcher_token: str,
) -> None:
    pc = watcher(configure=False)

    # The real wizard, with its answers piped in.
    result = pc.init_interactive(
        InitAnswers(
            environment=pc.environment,
            api_base_url=f"{proxy.base_url}/api/v1",
            api_key=watcher_token,
            watch_directory=watch_dir,
            instrument=1,
            existing_instruments=1,
            file_patterns=["*.csv"],
            run_detection=RunDetection.TOP_SUBDIRECTORY,
            recursive=True,
            stability_period_seconds=1,
            upload_mode="auto",
        )
    )
    assert result.returncode == 0, result.output
    assert "Setup complete" in result.stdout

    # It registered the watcher, saved the config and the key, and pushed the config.
    config = pc.load_config()
    assert config.watcher_id == pc.watcher_id
    assert config.instrument.watch_directory == watch_dir
    assert config.api_base_url == f"{proxy.base_url}/api/v1"
    assert watcher_token in pc.env_path.read_text()
    registered = server.watcher(pc.watcher_id)
    assert (registered.status, registered.last_heartbeat_at) == ("registered", None)
    assert registered.registered_by_token is not None
    assert registered.hostname
    assert registered.config_yaml is not None and "watch_directory" in registered.config_yaml
    assert server.effective_status(pc.watcher_id) == "registered"

    # Fast timers go into the env file next to the key that `init` saved.
    pc.write_env(overrides=DEFAULT_TIMER_OVERRIDES)
    assert watcher_token in pc.env_path.read_text()

    pc.start()
    row = server.wait_for_watcher_status(pc.watcher_id, "watching")
    assert row.last_heartbeat_at is not None
    assert row.watcher_version
    started = server.wait_for_event(pc.watcher_id, event_type="watcher_started")
    assert started.message.startswith("Watcher started on ")
    assert server.effective_status(pc.watcher_id) == "watching"
    assert pc.is_running()

    # A graceful stop: exit code 0, a final `stopped` heartbeat, and a watcher_stopped event.
    assert pc.stop() == 0
    server.wait_for_watcher_status(pc.watcher_id, "stopped")
    stopped = server.wait_for_event(pc.watcher_id, event_type="watcher_stopped")
    assert stopped.message == "Watcher stopped by user"
    assert [b.status for b in server.heartbeats(pc.watcher_id)][-1] == "stopped"
    assert server.effective_status(pc.watcher_id) == "stopped"
    assert not pc.is_running()


@pytest.mark.covers(
    "run.first_file->reported",
    "upload.stable->single_put_uploaded",
    "upload.stable->multipart_uploaded",
    "event.run_reported->emitted",
    "event.file_uploaded->emitted",
)
def test_auto_mode_uploads_a_small_and_a_large_file(
    watcher: WatcherFactory, server: ServerView, instrument_id: str, watch_dir: Path
) -> None:
    pc = watcher()
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")

    # One run folder with a file under 1 KB (a single PUT) and one over it (multipart).
    run = watch_dir / "RUN001"
    run.mkdir()
    small = run / "small.csv"
    large = run / "large.csv"
    small.write_bytes(b"well,od\nA1,0.42\n")
    large.write_bytes(bytes(i * 7 % 256 for i in range(5000)))

    server.wait_for_run(instrument_id, "RUN001")
    small_row = server.wait_for_uploaded(instrument_id, "RUN001", "RUN001/small.csv", content=small)
    large_row = server.wait_for_uploaded(instrument_id, "RUN001", "RUN001/large.csv", content=large)

    assert small_row.s3_key == f"{instrument_id}/RUN001/small.csv"
    assert large_row.s3_key == f"{instrument_id}/RUN001/large.csv"
    assert server.run_status(instrument_id, "RUN001") == "uploaded"

    reported = server.wait_for_event(pc.watcher_id, event_type="run_reported")
    assert reported.details["run_id"] == "RUN001"
    uploaded = {
        e.details["s3_key"]: e.details
        for e in server.wait_for_events(pc.watcher_id, event_type="file_uploaded", count=2)
    }
    assert uploaded[small_row.s3_key or ""]["part_count"] == 1
    assert uploaded[large_row.s3_key or ""]["part_count"] > 1
    assert uploaded[large_row.s3_key or ""]["size_bytes"] == 5000
