"""Unit tests for ``RunDetectionConfig`` validation.

Also covers the ``InstrumentConfig.upload_parallelism`` field added
alongside the parallel-upload optimisation -- it lives here rather
than in its own file because the existing ``RunDetectionConfig``
suite is the closest neighbour and the field is a small additive
concern.
"""

from __future__ import annotations
from pathlib import Path

import pytest
from pydantic import ValidationError

from data_hub_watcher.models import InstrumentConfig, RunDetectionConfig


class TestRunDetectionConfigValidation:
    def test_valid_pattern_with_one_group(self) -> None:
        cfg = RunDetectionConfig(pattern=r"^([^_]+)")
        assert cfg.pattern == r"^([^_]+)"

    def test_recursive_defaults_to_true(self) -> None:
        cfg = RunDetectionConfig(pattern=r"^([^/]+)/")
        assert cfg.recursive is True

    def test_explicit_recursive_false(self) -> None:
        cfg = RunDetectionConfig(pattern=r"^([^_]+)", recursive=False)
        assert cfg.recursive is False

    def test_zero_capture_groups_rejected(self) -> None:
        with pytest.raises(ValidationError, match="exactly 1 capture group, got 0"):
            RunDetectionConfig(pattern=r"^[^_]+")

    def test_two_capture_groups_rejected(self) -> None:
        with pytest.raises(ValidationError, match="exactly 1 capture group, got 2"):
            RunDetectionConfig(pattern=r"^([^_]+)_(.+)")

    def test_three_capture_groups_rejected(self) -> None:
        with pytest.raises(ValidationError, match="exactly 1 capture group, got 3"):
            RunDetectionConfig(pattern=r"^(a)(b)(c)")

    def test_invalid_regex_rejected(self) -> None:
        with pytest.raises(ValidationError, match="Invalid run_detection.pattern regex"):
            RunDetectionConfig(pattern="[")

    def test_non_capturing_groups_do_not_count(self) -> None:
        cfg = RunDetectionConfig(pattern=r"(?:^|/)(\d{8}_\d{6}_\d{3})/")
        assert cfg.pattern == r"(?:^|/)(\d{8}_\d{6}_\d{3})/"


def _make_instrument(
    tmp_path: Path,
    *,
    upload_parallelism: int | None = None,
) -> InstrumentConfig:
    watch_dir = tmp_path / "data"
    watch_dir.mkdir()
    (watch_dir / "RUN001_sample.csv").write_text("a,b\n1,2\n")
    kwargs: dict[str, object] = {
        "id": "test-instrument",
        "watch_directory": watch_dir,
        "file_patterns": ["*.csv"],
        "run_detection": RunDetectionConfig(pattern=r"^([^_]+)", recursive=False),
    }
    if upload_parallelism is not None:
        kwargs["upload_parallelism"] = upload_parallelism
    return InstrumentConfig(**kwargs)  # type: ignore[arg-type]


class TestUploadParallelism:
    """Validation rules for ``InstrumentConfig.upload_parallelism``.

    Defaulted so existing config YAMLs (which won't mention the
    field) keep working unchanged. Bounded to a sensible range so a
    typo can't accidentally spawn 10 000 worker threads on a lab PC.
    """

    def test_defaults_to_four(self, tmp_path: Path) -> None:
        cfg = _make_instrument(tmp_path)
        assert cfg.upload_parallelism == 4

    def test_explicit_minimum_of_one(self, tmp_path: Path) -> None:
        cfg = _make_instrument(tmp_path, upload_parallelism=1)
        assert cfg.upload_parallelism == 1

    def test_explicit_maximum_of_thirty_two(self, tmp_path: Path) -> None:
        cfg = _make_instrument(tmp_path, upload_parallelism=32)
        assert cfg.upload_parallelism == 32

    def test_zero_rejected(self, tmp_path: Path) -> None:
        with pytest.raises(ValidationError, match="greater than or equal to 1"):
            _make_instrument(tmp_path, upload_parallelism=0)

    def test_negative_rejected(self, tmp_path: Path) -> None:
        with pytest.raises(ValidationError, match="greater than or equal to 1"):
            _make_instrument(tmp_path, upload_parallelism=-3)

    def test_above_cap_rejected(self, tmp_path: Path) -> None:
        with pytest.raises(ValidationError, match="less than or equal to 32"):
            _make_instrument(tmp_path, upload_parallelism=64)
