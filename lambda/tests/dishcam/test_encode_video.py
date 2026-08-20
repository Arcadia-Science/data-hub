"""Unit tests for DishCam ffmpeg encode (skipped when ffmpeg is missing)."""

from __future__ import annotations
import shutil
from pathlib import Path

import numpy as np
import pytest
import tifffile

from data_hub_lambda.dishcam.encode_video import encode_tiff_stack, resolve_ffmpeg

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is not on PATH")


def _write_stack(path: Path, frames: int = 4) -> Path:
    pages = []
    for i in range(frames):
        img = np.zeros((48, 64, 3), dtype=np.uint8)
        img[..., 0] = 30 + i * 15
        img[..., 1] = 90
        img[..., 2] = 180
        pages.append(img)
    tifffile.imwrite(path, np.stack(pages), photometric="rgb")
    return path


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


def test_resolve_ffmpeg_finds_binary() -> None:
    assert Path(resolve_ffmpeg()).name.startswith("ffmpeg")
