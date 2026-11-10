"""Unit tests for the shared ffmpeg helpers."""

from __future__ import annotations
import shutil
from pathlib import Path

import pytest

from data_hub_lambda.video import MIN_PLAYBACK_FPS, ffmpeg_rate, playback_fps, resolve_ffmpeg


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is not on PATH")
def test_resolve_ffmpeg_finds_binary() -> None:
    assert Path(resolve_ffmpeg()).name.startswith("ffmpeg")


def test_ffmpeg_rate_avoids_scientific_notation() -> None:
    assert "e" not in ffmpeg_rate(1e-5).lower()
    assert ffmpeg_rate(10.0) == "10"
    assert ffmpeg_rate(0.95) == "0.95"


def test_playback_fps_floors_slow_captures() -> None:
    assert playback_fps(0.0167) == MIN_PLAYBACK_FPS
    assert playback_fps(24.0) == 24.0
