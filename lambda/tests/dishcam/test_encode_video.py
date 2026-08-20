"""Unit tests for DishCam ffmpeg encode."""

from __future__ import annotations
import shutil
from pathlib import Path

import numpy as np
import pytest
import tifffile

from data_hub_lambda.dishcam.encode_video import (
    _ffmpeg_rate,
    encode_tiff_stack,
    resolve_ffmpeg,
)

requires_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is not on PATH")


def _write_stack(path: Path, frames: int = 4, width: int = 64, height: int = 48) -> Path:
    pages = []
    for i in range(frames):
        img = np.zeros((height, width, 3), dtype=np.uint8)
        img[..., 0] = 30 + i * 15
        img[..., 1] = 90
        img[..., 2] = 180
        pages.append(img)
    tifffile.imwrite(path, np.stack(pages), photometric="rgb")
    return path


@requires_ffmpeg
def test_encode_writes_mp4_and_poster(tmp_path: Path) -> None:
    tiff = _write_stack(tmp_path / "stack.tif")
    mp4 = tmp_path / "stack.mp4"
    poster = tmp_path / "stack.jpg"

    encode_tiff_stack(tiff, mp4, poster, fps=1.0)

    assert mp4.is_file()
    assert mp4.stat().st_size > 0
    assert poster.is_file()
    assert poster.read_bytes()[:2] == b"\xff\xd8"
    # ISO BMFF / MP4 brand
    assert b"ftyp" in mp4.read_bytes()[:32]


@requires_ffmpeg
def test_encode_odd_width_stack(tmp_path: Path) -> None:
    tiff = _write_stack(tmp_path / "odd.tif", frames=2, width=47, height=48)
    mp4 = tmp_path / "odd.mp4"
    poster = tmp_path / "odd.jpg"

    encode_tiff_stack(tiff, mp4, poster, fps=10.0)

    assert mp4.is_file()
    assert mp4.stat().st_size > 0
    assert poster.is_file()


@requires_ffmpeg
def test_resolve_ffmpeg_finds_binary() -> None:
    assert Path(resolve_ffmpeg()).name.startswith("ffmpeg")


def test_ffmpeg_rate_avoids_scientific_notation() -> None:
    assert "e" not in _ffmpeg_rate(1e-5).lower()
    assert _ffmpeg_rate(10.0) == "10"
    assert _ffmpeg_rate(0.95) == "0.95"
