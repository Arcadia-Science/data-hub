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
from pathlib import Path, PureWindowsPath
from unittest.mock import MagicMock

import pytest

from data_hub_watcher.constants import RUN_DETECTION_PRESETS
from data_hub_watcher.run_detector import RunDetector


def _make_detector(pattern: str, watch_directory: Path) -> RunDetector:
    """Build a ``RunDetector`` with only the fields needed for run-ID extraction."""
    return RunDetector(
        pattern=pattern,
        instrument_id="test-instrument",
        watcher_id="w-test",
        client=MagicMock(),
        state_db=MagicMock(),
        event_reporter=MagicMock(),
        counters=MagicMock(),
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

    WATCH_DIR = r"D:\ArcadiaJOBS2023\JOBS_2023 Projects\Backup"

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
