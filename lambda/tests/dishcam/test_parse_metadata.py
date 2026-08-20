"""Unit tests for DishCam `run.json` parsing."""

from __future__ import annotations
import json
from pathlib import Path

import pytest

from data_hub_lambda.dishcam.parse_metadata import (
    MIN_PLAYBACK_FPS,
    encode_fps,
    parse_run_json,
    playback_fps,
)


def _write_json(path: Path, payload: object) -> Path:
    path.write_text(json.dumps(payload))
    return path


def test_prefers_measured_fps(tmp_path: Path) -> None:
    sidecar = _write_json(
        tmp_path / "run.json",
        {"fps": 1.0, "measured_fps": 0.95, "frames": 10, "quality": "High"},
    )
    metadata = parse_run_json(sidecar)
    assert encode_fps(metadata) == 0.95
    assert metadata["fps"] == 1.0
    assert metadata["frames"] == 10


def test_falls_back_to_planned_fps(tmp_path: Path) -> None:
    sidecar = _write_json(tmp_path / "run.json", {"fps": 2.5, "frames": 8})
    metadata = parse_run_json(sidecar)
    assert encode_fps(metadata) == 2.5


def test_rejects_missing_fps(tmp_path: Path) -> None:
    sidecar = _write_json(tmp_path / "run.json", {"frames": 8})
    with pytest.raises(ValueError, match="missing fps"):
        parse_run_json(sidecar)


def test_rejects_non_object(tmp_path: Path) -> None:
    sidecar = _write_json(tmp_path / "run.json", ["not", "an", "object"])
    with pytest.raises(ValueError, match="JSON object"):
        parse_run_json(sidecar)


def test_omits_missing_and_null_keys(tmp_path: Path) -> None:
    sidecar = _write_json(tmp_path / "run.json", {"fps": 1.0, "quality": None})
    metadata = parse_run_json(sidecar)
    assert "duration_seconds" not in metadata
    assert "quality" not in metadata
    assert metadata["fps"] == 1.0


def test_playback_fps_floors_slow_captures() -> None:
    assert playback_fps(0.0167) == MIN_PLAYBACK_FPS
    assert playback_fps(24.0) == 24.0
