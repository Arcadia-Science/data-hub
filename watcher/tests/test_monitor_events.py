"""Unit tests for FileMonitor's structured event emissions.

Two anomalies that previously only logged locally now surface as
``EventType.ERROR`` events:

* ``kind=stability_timeout`` -- a file kept changing past
  ``MAX_STABILITY_WAIT_SECONDS`` and was abandoned.
* ``kind=stable_callback_failed`` -- the on-stable-file callback raised.

Tests drive ``_check_pending`` directly (with monkey-patched ``time``
and a forced-out-of-window ``first_seen``) so we don't have to wait
the real 5-minute stability window in unit tests.
"""

from __future__ import annotations
import time
from collections.abc import Generator
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from data_hub_watcher.events import EventReporter
from data_hub_watcher.monitor import FileMonitor, _PendingFile
from data_hub_watcher.state import StateDB


@pytest.fixture()
def state_db(tmp_path: Path) -> Generator[StateDB, None, None]:
    db = StateDB(tmp_path / "state.db")
    yield db
    db.close()


@pytest.fixture()
def watch_dir(tmp_path: Path) -> Path:
    d = tmp_path / "watch"
    d.mkdir()
    return d


def _make_monitor(
    watch_dir: Path,
    state_db: StateDB,
    *,
    on_stable_file: MagicMock | None = None,
    reporter: MagicMock | None = None,
) -> FileMonitor:
    return FileMonitor(
        watch_directory=watch_dir,
        file_patterns=["*.csv"],
        stability_period=1,
        on_stable_file=on_stable_file or MagicMock(),
        state_db=state_db,
        recursive=False,
        event_reporter=reporter,
    )


class TestStabilityTimeout:
    def test_emits_event_for_abandoned_file(self, watch_dir: Path, state_db: StateDB) -> None:
        from data_hub_watcher.constants import MAX_STABILITY_WAIT_SECONDS

        reporter = MagicMock(spec=EventReporter)
        monitor = _make_monitor(watch_dir, state_db, reporter=reporter)

        f = watch_dir / "growing.csv"
        f.write_text("a")
        st = f.stat()

        # Manually plant a pending entry whose first_seen is older than
        # MAX_STABILITY_WAIT_SECONDS so _check_pending classifies it as
        # timed out without waiting 5 minutes in the test.
        now = time.monotonic()
        monitor._pending[f] = _PendingFile(
            path=f,
            size=st.st_size,
            mtime=st.st_mtime,
            first_seen=now - MAX_STABILITY_WAIT_SECONDS - 1,
            last_changed=now,
        )

        monitor._check_pending()

        # The pending entry was discarded.
        assert f not in monitor._pending
        # And a structured event was emitted with the correct schema.
        assert reporter.report_error.call_count == 1
        call = reporter.report_error.call_args
        assert call.args[0] == "stability_timeout"
        assert call.kwargs["path"] == str(f)
        assert call.kwargs["max_wait_seconds"] == MAX_STABILITY_WAIT_SECONDS

    def test_no_reporter_does_not_crash(self, watch_dir: Path, state_db: StateDB) -> None:
        """A FileMonitor built without a reporter must still function.

        Tests that build FileMonitor in isolation pass reporter=None.
        The timeout path used to log only; it should keep doing so
        without raising when the reporter is absent.
        """
        from data_hub_watcher.constants import MAX_STABILITY_WAIT_SECONDS

        monitor = _make_monitor(watch_dir, state_db, reporter=None)
        f = watch_dir / "growing.csv"
        f.write_text("a")
        st = f.stat()
        now = time.monotonic()
        monitor._pending[f] = _PendingFile(
            path=f,
            size=st.st_size,
            mtime=st.st_mtime,
            first_seen=now - MAX_STABILITY_WAIT_SECONDS - 1,
            last_changed=now,
        )

        monitor._check_pending()  # must not raise

        assert f not in monitor._pending


class TestStableCallbackFailure:
    def test_callback_exception_emits_event(self, watch_dir: Path, state_db: StateDB) -> None:
        reporter = MagicMock(spec=EventReporter)
        on_stable = MagicMock(side_effect=RuntimeError("downstream blew up"))
        monitor = _make_monitor(
            watch_dir,
            state_db,
            on_stable_file=on_stable,
            reporter=reporter,
        )

        f = watch_dir / "ready.csv"
        f.write_text("hello")
        st = f.stat()
        now = time.monotonic()
        monitor._pending[f] = _PendingFile(
            path=f,
            size=st.st_size,
            mtime=st.st_mtime,
            first_seen=now - 5,
            last_changed=now - 5,  # already past the 1 s stability period
        )

        monitor._check_pending()

        on_stable.assert_called_once_with(f)
        assert reporter.report_error.call_count == 1
        call = reporter.report_error.call_args
        assert call.args[0] == "stable_callback_failed"
        assert call.kwargs["path"] == str(f)
        assert "downstream blew up" in call.kwargs["error"]
