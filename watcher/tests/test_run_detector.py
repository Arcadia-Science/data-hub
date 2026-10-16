"""Unit tests for run-ID extraction across all presets and path styles.

Tests the core ``_extract_run_id`` logic by constructing a minimal
``RunDetector`` with stubbed-out dependencies and calling
``_extract_run_id`` directly.

Cross-platform coverage is achieved by testing both forward-slash
(POSIX) and backslash (Windows) relative paths. Since ``Path`` on a
non-Windows host is always ``PosixPath``, the Windows tests verify
the POSIX-normalization step in isolation using ``PureWindowsPath``.
"""

from __future__ import annotations
import re
import sqlite3
from pathlib import Path, PureWindowsPath
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
import requests

from data_hub_watcher import run_detector
from data_hub_watcher.api_client import ApiError
from data_hub_watcher.constants import (
    RUN_DETECTION_PRESETS,
    RUN_REPORT_RETRY_BASE_DELAY_SECONDS,
    RUN_REPORT_RETRY_MAX_DELAY_SECONDS,
)
from data_hub_watcher.heartbeat import WatcherCounters
from data_hub_watcher.run_detector import RunDetector


def _make_detector(
    pattern: str,
    watch_directory: Path,
    *,
    client: MagicMock | None = None,
    reporter: MagicMock | None = None,
    counters: WatcherCounters | MagicMock | None = None,
    state_db: MagicMock | None = None,
) -> RunDetector:
    """Build a ``RunDetector`` with stubbed dependencies unless the caller passes its own."""
    return RunDetector(
        pattern=pattern,
        instrument_id="test-instrument",
        watcher_id="w-test",
        client=client or MagicMock(),
        state_db=state_db or MagicMock(),
        event_reporter=reporter or MagicMock(),
        counters=counters or MagicMock(),
        watch_directory=watch_directory,
    )


def _preset_pattern(key: str) -> str:
    """Look up a preset pattern by its key."""
    for k, _desc, pat, _rec in RUN_DETECTION_PRESETS:
        if k == key:
            return pat
    raise KeyError(key)


# ------------------------------------------------------------------
# Helper: simulate Windows-path normalization
# ------------------------------------------------------------------


def _extract_from_windows_path(pattern: str, watch_dir_str: str, file_path_str: str) -> str | None:
    """Replicate ``_extract_run_id`` using ``PureWindowsPath`` to verify
    that backslash normalization via ``.as_posix()`` works correctly.
    """
    watch_dir = PureWindowsPath(watch_dir_str)
    file_path = PureWindowsPath(file_path_str)
    rel = file_path.relative_to(watch_dir).as_posix()
    m = re.compile(pattern).search(rel)
    if m and m.group(1):
        return m.group(1)
    return None


# ==================================================================
# POSIX path tests (use real Path objects via tmp_path)
# ==================================================================


class TestRunIdExtractionPosix:
    """Run-ID extraction on POSIX paths (real ``Path`` objects)."""

    def test_filename_prefix(self, tmp_path: Path) -> None:
        pat = _preset_pattern("filename_prefix")
        d = _make_detector(pat, tmp_path)

        assert d._extract_run_id(tmp_path / "RUN001_data.csv") == "RUN001"
        assert d._extract_run_id(tmp_path / "BATCH-A_results.xlsx") == "BATCH-A"

    def test_filename_prefix_no_underscore(self, tmp_path: Path) -> None:
        pat = _preset_pattern("filename_prefix")
        d = _make_detector(pat, tmp_path)
        assert d._extract_run_id(tmp_path / "noprefix.csv") == "noprefix.csv"

    def test_top_subdirectory(self, tmp_path: Path) -> None:
        pat = _preset_pattern("top_subdirectory")
        d = _make_detector(pat, tmp_path)

        assert d._extract_run_id(tmp_path / "RUN001" / "data.csv") == "RUN001"
        assert d._extract_run_id(tmp_path / "RUN001" / "sub" / "data.csv") == "RUN001"

    def test_top_subdirectory_file_in_root(self, tmp_path: Path) -> None:
        pat = _preset_pattern("top_subdirectory")
        d = _make_detector(pat, tmp_path)
        assert d._extract_run_id(tmp_path / "orphan.csv") is None

    def test_deepest_subdirectory(self, tmp_path: Path) -> None:
        pat = _preset_pattern("deepest_subdirectory")
        d = _make_detector(pat, tmp_path)

        assert d._extract_run_id(tmp_path / "plate-a" / "well-b" / "data.csv") == "well-b"
        assert d._extract_run_id(tmp_path / "RUN001" / "data.csv") == "RUN001"

    def test_deepest_subdirectory_file_in_root(self, tmp_path: Path) -> None:
        pat = _preset_pattern("deepest_subdirectory")
        d = _make_detector(pat, tmp_path)
        assert d._extract_run_id(tmp_path / "orphan.csv") is None

    def test_timestamp_subdirectory(self, tmp_path: Path) -> None:
        pat = _preset_pattern("timestamp_subdirectory")
        d = _make_detector(pat, tmp_path)

        assert (
            d._extract_run_id(tmp_path / "20260402_103919_624" / "file.png")
            == "20260402_103919_624"
        )

    def test_timestamp_subdirectory_nested(self, tmp_path: Path) -> None:
        pat = _preset_pattern("timestamp_subdirectory")
        d = _make_detector(pat, tmp_path)

        assert (
            d._extract_run_id(tmp_path / "extra" / "nested" / "20260402_103919_624" / "file.png")
            == "20260402_103919_624"
        )

    def test_timestamp_subdirectory_no_match(self, tmp_path: Path) -> None:
        pat = _preset_pattern("timestamp_subdirectory")
        d = _make_detector(pat, tmp_path)
        assert d._extract_run_id(tmp_path / "not-a-timestamp" / "file.png") is None

    def test_filename_stem(self, tmp_path: Path) -> None:
        pat = _preset_pattern("filename_stem")
        d = _make_detector(pat, tmp_path)

        assert d._extract_run_id(tmp_path / "sample.csv") == "sample"
        assert d._extract_run_id(tmp_path / "sample.ome.tiff") == "sample.ome"

    def test_filename_stem_in_subdir(self, tmp_path: Path) -> None:
        pat = _preset_pattern("filename_stem")
        d = _make_detector(pat, tmp_path)
        assert d._extract_run_id(tmp_path / "subdir" / "sample.csv") == "sample"

    def test_file_outside_watch_dir(self, tmp_path: Path) -> None:
        d = _make_detector(r"^([^_]+)", tmp_path / "watch")
        assert d._extract_run_id(tmp_path / "elsewhere" / "file.csv") is None

    def test_non_matching_file_returns_none(self, tmp_path: Path) -> None:
        d = _make_detector(r"^(MAGIC_\d+)", tmp_path)
        assert d._extract_run_id(tmp_path / "nomatch.csv") is None


# ==================================================================
# Windows path tests (use PureWindowsPath strings, no real FS)
# ==================================================================


class TestRunIdExtractionWindows:
    """Verify that backslash paths are POSIX-normalized before matching."""

    WATCH_DIR = r"D:\InstrumentData\JOBS_2023 Projects\Backup"

    def test_filename_prefix(self) -> None:
        pat = _preset_pattern("filename_prefix")
        result = _extract_from_windows_path(
            pat,
            self.WATCH_DIR,
            rf"{self.WATCH_DIR}\RUN001_data.csv",
        )
        assert result == "RUN001"

    def test_top_subdirectory(self) -> None:
        pat = _preset_pattern("top_subdirectory")
        result = _extract_from_windows_path(
            pat,
            self.WATCH_DIR,
            rf"{self.WATCH_DIR}\RUN001\data.csv",
        )
        assert result == "RUN001"

    def test_top_subdirectory_file_in_root(self) -> None:
        pat = _preset_pattern("top_subdirectory")
        result = _extract_from_windows_path(
            pat,
            self.WATCH_DIR,
            rf"{self.WATCH_DIR}\orphan.csv",
        )
        assert result is None

    def test_deepest_subdirectory(self) -> None:
        pat = _preset_pattern("deepest_subdirectory")
        result = _extract_from_windows_path(
            pat,
            self.WATCH_DIR,
            rf"{self.WATCH_DIR}\plate-a\well-b\data.csv",
        )
        assert result == "well-b"

    def test_timestamp_subdirectory(self) -> None:
        pat = _preset_pattern("timestamp_subdirectory")
        result = _extract_from_windows_path(
            pat,
            self.WATCH_DIR,
            rf"{self.WATCH_DIR}\20260402_103919_624\file.png",
        )
        assert result == "20260402_103919_624"

    def test_timestamp_subdirectory_deeply_nested(self) -> None:
        pat = _preset_pattern("timestamp_subdirectory")
        result = _extract_from_windows_path(
            pat,
            self.WATCH_DIR,
            rf"{self.WATCH_DIR}\yeast (1)\grid_w_AutoFocus\20260402_103919_624\file.png",
        )
        assert result == "20260402_103919_624"

    def test_filename_stem(self) -> None:
        pat = _preset_pattern("filename_stem")
        result = _extract_from_windows_path(
            pat,
            self.WATCH_DIR,
            rf"{self.WATCH_DIR}\sample.ome.tiff",
        )
        assert result == "sample.ome"

    def test_filename_stem_in_subdir(self) -> None:
        pat = _preset_pattern("filename_stem")
        result = _extract_from_windows_path(
            pat,
            self.WATCH_DIR,
            rf"{self.WATCH_DIR}\subdir\sample.csv",
        )
        assert result == "sample"

    def test_file_outside_watch_dir(self) -> None:
        pat = _preset_pattern("filename_prefix")
        with pytest.raises(ValueError):
            _extract_from_windows_path(
                pat,
                self.WATCH_DIR,
                r"C:\Other\file.csv",
            )


# ==================================================================
# Pattern-mismatch event throttling
# ==================================================================


class TestPatternMismatchThrottling:
    """A misconfigured pattern shouldn't flood the event queue.

    The detector reports at most one ``kind=pattern_mismatch`` event per
    parent directory per process lifetime. Two files in the same
    directory must coalesce to a single event; two files in different
    directories must each emit.
    """

    def test_emits_once_per_directory(self, tmp_path: Path) -> None:
        from unittest.mock import MagicMock

        from data_hub_watcher.events import EventReporter

        reporter = MagicMock(spec=EventReporter)
        d = RunDetector(
            pattern=r"^MAGIC_(\d+)",  # nothing in tmp_path matches
            instrument_id="i",
            watcher_id="w",
            client=MagicMock(),
            state_db=MagicMock(),
            event_reporter=reporter,
            counters=MagicMock(),
            watch_directory=tmp_path,
        )

        # Two files in the same parent directory.
        d._extract_run_id(tmp_path / "subdir" / "a.csv")
        d._extract_run_id(tmp_path / "subdir" / "b.csv")
        # And one in a different directory.
        d._extract_run_id(tmp_path / "other" / "c.csv")

        kinds = [call.args[0] for call in reporter.report_error.call_args_list]
        assert kinds.count("pattern_mismatch") == 2  # one per parent dir


# ==================================================================
# Run-report API failures emit kind=run_report_failed
# ==================================================================


class TestRunReportFailures:
    def _run_state_with_one_file(self, tmp_path: Path):  # type: ignore[no-untyped-def]
        from data_hub_watcher.run_detector import FileInfo, RunState

        f = tmp_path / "RUN-A.csv"
        f.write_text("x")
        st = f.stat()
        run = RunState(run_id="RUN-A")
        run.files = [
            FileInfo(
                path=f,
                filename=f.name,
                size_bytes=st.st_size,
                mtime=st.st_mtime,
                file_created_at=st.st_mtime,
            )
        ]
        return run

    def test_create_failure_emits_event(self, tmp_path: Path) -> None:
        from unittest.mock import MagicMock

        from data_hub_watcher.api_client import ApiError
        from data_hub_watcher.events import EventReporter

        client = MagicMock()
        client.report_run.side_effect = ApiError("boom", status_code=500)
        reporter = MagicMock(spec=EventReporter)
        d = RunDetector(
            pattern=r"^([^_.]+)",
            instrument_id="i",
            watcher_id="w",
            client=client,
            state_db=MagicMock(),
            event_reporter=reporter,
            counters=MagicMock(errors=0),
            watch_directory=tmp_path,
        )
        run = self._run_state_with_one_file(tmp_path)
        d._report_new_run(run)

        # report_error called once with the right kind + operation.
        assert reporter.report_error.call_count == 1
        call = reporter.report_error.call_args
        assert call.args[0] == "run_report_failed"
        assert call.kwargs["operation"] == "create"
        assert call.kwargs["status_code"] == 500
        assert call.kwargs["run_id"] == "RUN-A"
        assert call.kwargs["file_count"] == 1

    def test_update_failure_emits_event(self, tmp_path: Path) -> None:
        from unittest.mock import MagicMock

        from data_hub_watcher.api_client import ApiError
        from data_hub_watcher.events import EventReporter

        client = MagicMock()
        client.update_run.side_effect = ApiError("nope", status_code=409)
        reporter = MagicMock(spec=EventReporter)
        d = RunDetector(
            pattern=r"^([^_.]+)",
            instrument_id="i",
            watcher_id="w",
            client=client,
            state_db=MagicMock(),
            event_reporter=reporter,
            counters=MagicMock(errors=0),
            watch_directory=tmp_path,
        )
        run = self._run_state_with_one_file(tmp_path)
        d._update_run(run)

        assert reporter.report_error.call_count == 1
        call = reporter.report_error.call_args
        assert call.args[0] == "run_report_failed"
        assert call.kwargs["operation"] == "update"
        assert call.kwargs["status_code"] == 409


# ==================================================================
# Transient run-report failures retry without another file event
# ==================================================================


class _Clock:
    """Stand-in for ``time.monotonic`` that only moves when a test says so."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance_to(self, seconds_from_start: float) -> None:
        self.now = 1000.0 + seconds_from_start


class TestRunReportRetries:
    @pytest.fixture()
    def clock(self, monkeypatch: pytest.MonkeyPatch) -> _Clock:
        clock = _Clock()
        # Replace the module's `time`, not `time.monotonic` itself, so pytest
        # and other threads keep the real clock.
        monkeypatch.setattr(run_detector, "time", SimpleNamespace(monotonic=clock))
        return clock

    @pytest.fixture()
    def client(self) -> MagicMock:
        return MagicMock()

    @pytest.fixture()
    def reporter(self) -> MagicMock:
        return MagicMock()

    @pytest.fixture()
    def counters(self) -> WatcherCounters:
        return WatcherCounters()

    @pytest.fixture()
    def detector(
        self,
        tmp_path: Path,
        client: MagicMock,
        reporter: MagicMock,
        counters: WatcherCounters,
        clock: _Clock,
    ) -> RunDetector:
        return _make_detector(
            r"^(R\d)_", tmp_path, client=client, reporter=reporter, counters=counters
        )

    @staticmethod
    def _file(tmp_path: Path, name: str) -> Path:
        path = tmp_path / name
        path.write_text(name)
        return path

    @staticmethod
    def _kinds(reporter: MagicMock) -> list[str]:
        return [call.args[0] for call in reporter.report_error.call_args_list]

    def test_transient_post_failure_retries_without_a_new_file(
        self, tmp_path: Path, detector: RunDetector, client: MagicMock, clock: _Clock
    ) -> None:
        client.report_run.side_effect = [ApiError("temporary", 503), SimpleNamespace(id="run")]
        path = self._file(tmp_path, "R1_a.csv")

        detector.on_stable_file(path)
        detector.on_stable_file(path)  # A duplicate callback sends nothing.
        assert client.report_run.call_count == 1

        clock.advance_to(RUN_REPORT_RETRY_BASE_DELAY_SECONDS - 1)
        detector.retry_failed_reports()
        assert client.report_run.call_count == 1

        clock.advance_to(RUN_REPORT_RETRY_BASE_DELAY_SECONDS)
        detector.retry_failed_reports()
        assert client.report_run.call_count == 2
        assert detector._runs["R1"].reported
        assert detector._retry_at == {}
        assert detector._runs["R1"].retry_attempts == 0

        clock.advance_to(10_000)
        detector.retry_failed_reports()
        assert client.report_run.call_count == 2

    def test_backoff_doubles_then_stays_at_the_cap(
        self, tmp_path: Path, detector: RunDetector, client: MagicMock, clock: _Clock
    ) -> None:
        client.report_run.side_effect = ApiError("down", 0)
        detector.on_stable_file(self._file(tmp_path, "R1_a.csv"))

        gaps: list[float] = []
        last_attempt_at = 0.0
        for second in range(1, 4000):
            clock.advance_to(second)
            before = client.report_run.call_count
            detector.retry_failed_reports()
            if client.report_run.call_count > before:
                gaps.append(second - last_attempt_at)
                last_attempt_at = second

        base = RUN_REPORT_RETRY_BASE_DELAY_SECONDS
        cap = RUN_REPORT_RETRY_MAX_DELAY_SECONDS
        expected = [min(base * 2**n, cap) for n in range(len(gaps))]
        assert gaps == expected
        assert gaps[:3] == [base, base * 2, base * 4]
        assert gaps[-5:] == [cap] * 5

    def test_keeps_retrying_through_a_long_outage_with_one_event(
        self,
        tmp_path: Path,
        detector: RunDetector,
        client: MagicMock,
        reporter: MagicMock,
        counters: WatcherCounters,
        clock: _Clock,
    ) -> None:
        client.report_run.side_effect = ApiError("down", 503)
        detector.on_stable_file(self._file(tmp_path, "R1_a.csv"))

        calls_at: dict[int, int] = {}
        for second in range(1, 3 * 3600 + 1):
            clock.advance_to(second)
            detector.retry_failed_reports()
            if second % 3600 == 0:
                calls_at[second] = client.report_run.call_count
        # In the third hour of the outage it still tries once per cap interval.
        cap = RUN_REPORT_RETRY_MAX_DELAY_SECONDS
        assert calls_at[3 * 3600] - calls_at[2 * 3600] == 3600 // cap
        failed_attempts = client.report_run.call_count

        client.report_run.side_effect = None
        client.report_run.return_value = SimpleNamespace(id="run")
        clock.now = detector._retry_at["R1"]
        detector.retry_failed_reports()

        assert detector._runs["R1"].reported
        assert detector._retry_at == {}
        assert self._kinds(reporter) == ["run_report_failed"]
        # The heartbeat error count still sees every failed attempt.
        assert counters.errors == failed_attempts

    @pytest.mark.parametrize("status", [400, 401, 404, 409, 429])
    def test_client_errors_are_not_retried(
        self,
        tmp_path: Path,
        detector: RunDetector,
        client: MagicMock,
        reporter: MagicMock,
        clock: _Clock,
        status: int,
    ) -> None:
        client.report_run.side_effect = ApiError("rejected", status)
        detector.on_stable_file(self._file(tmp_path, "R1_a.csv"))

        clock.advance_to(10_000)
        detector.retry_failed_reports()

        assert client.report_run.call_count == 1
        assert detector._retry_at == {}
        assert detector._runs["R1"].retry_attempts == 0
        assert self._kinds(reporter) == ["run_report_failed"]

    def test_client_error_during_retries_is_reported_and_ends_them(
        self,
        tmp_path: Path,
        detector: RunDetector,
        client: MagicMock,
        reporter: MagicMock,
        clock: _Clock,
    ) -> None:
        # The server comes back but now refuses the watcher's token.
        client.report_run.side_effect = [ApiError("down", 503), ApiError("revoked", 401)]
        detector.on_stable_file(self._file(tmp_path, "R1_a.csv"))

        clock.advance_to(RUN_REPORT_RETRY_BASE_DELAY_SECONDS)
        detector.retry_failed_reports()
        clock.advance_to(10_000)
        detector.retry_failed_reports()

        assert client.report_run.call_count == 2
        assert detector._retry_at == {}
        assert detector._runs["R1"].retry_attempts == 0
        statuses = [c.kwargs["status_code"] for c in reporter.report_error.call_args_list]
        assert statuses == [503, 401]

    def test_failed_patch_is_retried_with_the_backlog(
        self, tmp_path: Path, detector: RunDetector, client: MagicMock, clock: _Clock
    ) -> None:
        client.report_run.return_value = SimpleNamespace(id="run")
        client.update_run.side_effect = [ApiError("temporary", 503), MagicMock()]

        detector.on_stable_file(self._file(tmp_path, "R1_a.csv"))
        detector.on_stable_file(self._file(tmp_path, "R1_b.csv"))
        assert client.update_run.call_count == 1

        clock.advance_to(RUN_REPORT_RETRY_BASE_DELAY_SECONDS)
        detector.retry_failed_reports()

        assert client.update_run.call_count == 2
        sent = client.update_run.call_args.args[2]["detected_files"]
        assert [f["filename"] for f in sent] == ["R1_b.csv"]
        assert detector._runs["R1"].patched_file_count == 2
        assert detector._retry_at == {}

    def test_new_file_carries_the_backlog_and_cancels_the_pending_retry(
        self, tmp_path: Path, detector: RunDetector, client: MagicMock, clock: _Clock
    ) -> None:
        client.report_run.return_value = SimpleNamespace(id="run")
        client.update_run.side_effect = [ApiError("temporary", 503), MagicMock()]
        detector.on_stable_file(self._file(tmp_path, "R1_a.csv"))
        detector.on_stable_file(self._file(tmp_path, "R1_b.csv"))  # PATCH fails.

        detector.on_stable_file(self._file(tmp_path, "R1_c.csv"))  # PATCH succeeds.

        sent = client.update_run.call_args.args[2]["detected_files"]
        assert [f["filename"] for f in sent] == ["R1_b.csv", "R1_c.csv"]
        clock.advance_to(10_000)
        detector.retry_failed_reports()
        assert client.update_run.call_count == 2

    def test_new_files_during_an_outage_add_no_events_and_keep_the_backoff(
        self,
        tmp_path: Path,
        detector: RunDetector,
        client: MagicMock,
        reporter: MagicMock,
        clock: _Clock,
    ) -> None:
        client.report_run.side_effect = ApiError("down", 503)
        detector.on_stable_file(self._file(tmp_path, "R1_a.csv"))
        clock.advance_to(1)
        detector.on_stable_file(self._file(tmp_path, "R1_b.csv"))
        clock.advance_to(2)
        detector.on_stable_file(self._file(tmp_path, "R1_c.csv"))

        assert client.report_run.call_count == 3
        assert self._kinds(reporter) == ["run_report_failed"]
        run = detector._runs["R1"]
        base = RUN_REPORT_RETRY_BASE_DELAY_SECONDS
        assert run.retry_attempts == 3
        assert run.retry_delay == base * 4
        assert detector._retry_at["R1"] == clock.now + base * 4

        # The server is back by the next retry, which sends every file.
        client.report_run.side_effect = None
        client.report_run.return_value = SimpleNamespace(id="run")
        clock.advance_to(2 + base * 4)
        detector.retry_failed_reports()

        sent = client.report_run.call_args.args[1]["detected_files"]
        assert [f["filename"] for f in sent] == ["R1_a.csv", "R1_b.csv", "R1_c.csv"]
        assert run.reported
        assert run.retry_attempts == 0
        assert run.retry_delay == 0

    def test_failure_after_a_success_is_reported_again(
        self,
        tmp_path: Path,
        detector: RunDetector,
        client: MagicMock,
        reporter: MagicMock,
        clock: _Clock,
    ) -> None:
        client.report_run.side_effect = [ApiError("down", 503), SimpleNamespace(id="run")]
        client.update_run.side_effect = ApiError("down again", 503)
        detector.on_stable_file(self._file(tmp_path, "R1_a.csv"))
        clock.advance_to(RUN_REPORT_RETRY_BASE_DELAY_SECONDS)
        detector.retry_failed_reports()

        detector.on_stable_file(self._file(tmp_path, "R1_b.csv"))

        operations = [c.kwargs["operation"] for c in reporter.report_error.call_args_list]
        assert operations == ["create", "update"]
        assert detector._runs["R1"].retry_delay == RUN_REPORT_RETRY_BASE_DELAY_SECONDS

    def test_unexpected_error_on_the_first_attempt_is_retried(
        self,
        tmp_path: Path,
        detector: RunDetector,
        client: MagicMock,
        reporter: MagicMock,
        clock: _Clock,
    ) -> None:
        client.report_run.side_effect = [
            requests.exceptions.ChunkedEncodingError("connection dropped mid-response"),
            SimpleNamespace(id="run"),
        ]
        detector.on_stable_file(self._file(tmp_path, "R1_a.csv"))  # Must not raise.

        event = reporter.report_error.call_args
        assert event.args[0] == "run_report_failed"
        assert event.kwargs["status_code"] == 0
        assert event.kwargs["error"].startswith("ChunkedEncodingError")

        clock.advance_to(RUN_REPORT_RETRY_BASE_DELAY_SECONDS)
        detector.retry_failed_reports()
        assert detector._runs["R1"].reported

    def test_error_after_a_successful_report_is_not_retried(
        self, tmp_path: Path, client: MagicMock, reporter: MagicMock, clock: _Clock
    ) -> None:
        client.report_run.return_value = SimpleNamespace(id="run")
        state_db = MagicMock()
        state_db.record_run_reported.side_effect = sqlite3.OperationalError("disk full")
        detector = _make_detector(
            r"^(R\d)_", tmp_path, client=client, reporter=reporter, state_db=state_db
        )

        # The monitor records `stable_callback_failed` for this, as before retries existed.
        with pytest.raises(sqlite3.OperationalError):
            detector.on_stable_file(self._file(tmp_path, "R1_a.csv"))

        assert detector._runs["R1"].reported
        assert detector._retry_at == {}
        assert self._kinds(reporter) == []

    def test_unexpected_error_during_a_retry_counts_as_a_failed_attempt(
        self,
        tmp_path: Path,
        detector: RunDetector,
        client: MagicMock,
        counters: WatcherCounters,
        clock: _Clock,
    ) -> None:
        client.report_run.side_effect = [
            ApiError("temporary", 503),
            ValueError("response was not JSON"),
            SimpleNamespace(id="run"),
        ]
        detector.on_stable_file(self._file(tmp_path, "R1_a.csv"))

        clock.advance_to(RUN_REPORT_RETRY_BASE_DELAY_SECONDS)
        detector.retry_failed_reports()  # Must not raise.

        assert detector._runs["R1"].retry_attempts == 2
        assert "R1" in detector._retry_at
        assert counters.errors == 2

        clock.advance_to(10_000)
        detector.retry_failed_reports()
        assert detector._runs["R1"].reported

    def test_one_run_is_retried_per_call(
        self, tmp_path: Path, detector: RunDetector, client: MagicMock, clock: _Clock
    ) -> None:
        client.report_run.side_effect = ApiError("down", 0)
        for run in ("R1", "R2", "R3"):
            detector.on_stable_file(self._file(tmp_path, f"{run}_a.csv"))
        assert client.report_run.call_count == 3

        clock.advance_to(RUN_REPORT_RETRY_BASE_DELAY_SECONDS)
        for expected_calls in (4, 5, 6, 6):
            detector.retry_failed_reports()
            assert client.report_run.call_count == expected_calls
