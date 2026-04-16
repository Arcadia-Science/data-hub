"""Unit tests for ``RunDetectionConfig`` validation."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from data_hub_watcher.models import RunDetectionConfig


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
