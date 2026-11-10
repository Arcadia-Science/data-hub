"""Stream a DishCam TIFF stack through ffmpeg into an HTML5 MP4 + JPEG poster."""

from __future__ import annotations
import logging
from collections.abc import Iterator
from pathlib import Path

import numpy as np
import tifffile
from numpy.typing import NDArray

from data_hub_lambda.deadline import check_deadline
from data_hub_lambda.video import (
    FFMPEG_QUIET,
    SCALE_FILTER,
    encode_rgb24,
    pipe_ffmpeg,
    resolve_ffmpeg,
)

logger = logging.getLogger(__name__)


def _as_rgb24(frame: NDArray) -> NDArray:  # type: ignore[type-arg]
    """Return a C-contiguous uint8 RGB frame for rawvideo stdin.

    DishCam writes uint8. A later camera with a wider type needs an
    explicit converter — do not guess 12-bit from a uint16 peak.
    """
    if frame.ndim == 2:
        frame = np.stack([frame, frame, frame], axis=-1)
    elif frame.ndim == 3 and frame.shape[-1] == 4:
        frame = frame[..., :3]
    elif frame.ndim != 3 or frame.shape[-1] != 3:
        raise ValueError(f"Unsupported TIFF page shape: {frame.shape}")
    if frame.dtype != np.uint8:
        raise ValueError(f"Expected uint8 RGB pages, got {frame.dtype}")
    return np.ascontiguousarray(frame)


def _write_jpeg(ffmpeg: str, frame: NDArray, dest: Path) -> None:  # type: ignore[type-arg]
    height, width = frame.shape[:2]
    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg,
        "-y",
        *FFMPEG_QUIET,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s:v",
        f"{width}x{height}",
        "-i",
        "pipe:0",
        "-vf",
        SCALE_FILTER,
        "-frames:v",
        "1",
        "-q:v",
        "3",
        str(dest),
    ]
    pipe_ffmpeg(cmd, iter((frame.tobytes(),)))


def encode_tiff_stack(
    tiff_path: Path,
    mp4_path: Path,
    poster_path: Path,
    fps: float,
) -> None:
    """Decode pages one at a time and pipe RGB24 into ffmpeg.

    Loading the full stack would be ~35 MB per 12 MP frame; real runs can
    be hundreds of frames.
    """
    ffmpeg = resolve_ffmpeg()

    with tifffile.TiffFile(tiff_path) as tif:
        if not tif.pages:
            raise ValueError(f"{tiff_path.name} has no TIFF pages")

        total = len(tif.pages)
        done = 0
        # Stop between frames rather than at the Lambda timeout. A timed-out
        # invocation is retried twice from the start, and the file looks
        # stalled while those retries run.
        check_deadline(f"encoding ({done} of {total} frames done)")
        first = _as_rgb24(tif.pages[0].asarray())
        done = 1
        height, width = first.shape[:2]
        _write_jpeg(ffmpeg, first, poster_path)

        logger.info(
            "Encoding %s (%dx%d, %s fps) → %s",
            tiff_path.name,
            width,
            height,
            fps,
            mp4_path.name,
        )

        def _chunks() -> Iterator[bytes]:
            nonlocal done
            yield first.tobytes()
            for index in range(1, total):
                check_deadline(f"encoding ({done} of {total} frames done)")
                done += 1
                yield _as_rgb24(tif.pages[index].asarray()).tobytes()

        encode_rgb24(
            _chunks(),
            width=width,
            height=height,
            fps=fps,
            mp4_path=mp4_path,
            ffmpeg=ffmpeg,
        )
