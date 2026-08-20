"""Stream a DishCam TIFF stack through ffmpeg into an HTML5 MP4 + JPEG poster."""

from __future__ import annotations
import logging
import shutil
import subprocess
from pathlib import Path

import numpy as np
import tifffile
from numpy.typing import NDArray

logger = logging.getLogger(__name__)

# Long-edge cap: 3040x4056 is above H.264 Level 5.2, so full-res will not
# play in Safari / Windows browsers. Keep even dimensions (`h=-2`).
_SCALE_FILTER = "scale=w='min(1920,iw)':h=-2"


def resolve_ffmpeg() -> str:
    path = shutil.which("ffmpeg")
    if path is None:
        raise RuntimeError("ffmpeg is not on PATH")
    return path


def _as_rgb24(frame: NDArray) -> NDArray:  # type: ignore[type-arg]
    """Return a C-contiguous uint8 RGB frame for rawvideo stdin."""
    if frame.ndim == 2:
        frame = np.stack([frame, frame, frame], axis=-1)
    elif frame.ndim == 3 and frame.shape[-1] == 4:
        frame = frame[..., :3]
    elif frame.ndim != 3 or frame.shape[-1] != 3:
        raise ValueError(f"Unsupported TIFF page shape: {frame.shape}")
    if frame.dtype != np.uint8:
        if np.issubdtype(frame.dtype, np.integer):
            max_val = float(np.iinfo(frame.dtype).max)
        else:
            max_val = float(frame.max() or 1)
        frame = np.clip(frame.astype(np.float32) * (255.0 / max_val), 0, 255).astype(np.uint8)
    return np.ascontiguousarray(frame)


def _write_jpeg(ffmpeg: str, frame: NDArray, dest: Path) -> None:  # type: ignore[type-arg]
    height, width = frame.shape[:2]
    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg,
        "-y",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s:v",
        f"{width}x{height}",
        "-i",
        "pipe:0",
        "-frames:v",
        "1",
        "-q:v",
        "3",
        str(dest),
    ]
    result = subprocess.run(cmd, input=frame.tobytes(), capture_output=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg poster encode failed: {result.stderr.decode(errors='replace')}")


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
    mp4_path.parent.mkdir(parents=True, exist_ok=True)

    with tifffile.TiffFile(tiff_path) as tif:
        if not tif.pages:
            raise ValueError(f"{tiff_path.name} has no TIFF pages")

        first = _as_rgb24(tif.pages[0].asarray())
        height, width = first.shape[:2]
        _write_jpeg(ffmpeg, first, poster_path)

        cmd = [
            ffmpeg,
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-s:v",
            f"{width}x{height}",
            "-r",
            str(fps),
            "-i",
            "pipe:0",
            "-vf",
            _SCALE_FILTER,
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-crf",
            "23",
            "-preset",
            "veryfast",
            "-movflags",
            "+faststart",
            "-g",
            "1",
            "-an",
            str(mp4_path),
        ]
        logger.info(
            "Encoding %s (%dx%d, %s fps) → %s",
            tiff_path.name,
            width,
            height,
            fps,
            mp4_path.name,
        )
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        assert proc.stdin is not None
        try:
            proc.stdin.write(first.tobytes())
            for page in tif.pages[1:]:
                proc.stdin.write(_as_rgb24(page.asarray()).tobytes())
            proc.stdin.close()
        except BrokenPipeError:
            pass
        _stdout, stderr = proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg MP4 encode failed: {stderr.decode(errors='replace')}")
