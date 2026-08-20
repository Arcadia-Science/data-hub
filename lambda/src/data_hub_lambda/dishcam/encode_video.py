"""Stream a DishCam TIFF stack through ffmpeg into an HTML5 MP4 + JPEG poster."""

from __future__ import annotations
import logging
import shutil
import subprocess
import tempfile
from collections.abc import Iterator
from pathlib import Path

import numpy as np
import tifffile
from numpy.typing import NDArray

logger = logging.getLogger(__name__)

# Width cap keeps the preview inside H.264 Level 5.2 / browser limits
# (a 3040x4056 stack will not play in Safari). `h=-2` keeps height even
# and aspect; the trunc expression makes width even for yuv420p.
_SCALE_FILTER = "scale=w='trunc(min(1920,iw)/2)*2':h=-2"

# Progress lines would fill the stderr pipe (~64 KB) and deadlock a
# long encode. Failures still land in the temp-file capture below.
_FFMPEG_QUIET = ("-nostats", "-loglevel", "error")


def resolve_ffmpeg() -> str:
    path = shutil.which("ffmpeg")
    if path is None:
        raise RuntimeError("ffmpeg is not on PATH")
    return path


def _ffmpeg_rate(fps: float) -> str:
    """Fixed-point rate. ffmpeg rejects scientific notation like `1e-05`."""
    return f"{fps:.6f}".rstrip("0").rstrip(".")


def _rgb_scale(frame: NDArray) -> float:  # type: ignore[type-arg]
    """Value that maps to 255, reused for every page in the stack.

    12-bit cameras often write into uint16; scaling by the dtype max
    crushes the preview. Float frames use the first-page max so later
    pages do not flicker.
    """
    if frame.dtype == np.uint8:
        return 255.0
    if np.issubdtype(frame.dtype, np.integer):
        peak = int(np.max(frame)) if frame.size else 0
        type_max = int(np.iinfo(frame.dtype).max)
        if peak <= 0:
            return float(type_max)
        return float(min(type_max, 1 << peak.bit_length()))
    peak = float(np.max(frame)) if frame.size else 0.0
    return peak if peak > 0 else 1.0


def _as_rgb24(frame: NDArray, scale: float | None = None) -> NDArray:  # type: ignore[type-arg]
    """Return a C-contiguous uint8 RGB frame for rawvideo stdin."""
    if frame.ndim == 2:
        frame = np.stack([frame, frame, frame], axis=-1)
    elif frame.ndim == 3 and frame.shape[-1] == 4:
        frame = frame[..., :3]
    elif frame.ndim != 3 or frame.shape[-1] != 3:
        raise ValueError(f"Unsupported TIFF page shape: {frame.shape}")
    if frame.dtype != np.uint8:
        max_val = scale if scale is not None else _rgb_scale(frame)
        frame = np.clip(frame.astype(np.float32) * (255.0 / max_val), 0, 255).astype(np.uint8)
    return np.ascontiguousarray(frame)


def _pipe_ffmpeg(cmd: list[str], chunks: Iterator[bytes]) -> None:
    """Write raw frames to ffmpeg; kill the child if the parent fails.

    stderr goes to a temp file so a chatty encode cannot fill a pipe
    and deadlock against stdin.
    """
    with tempfile.NamedTemporaryFile() as err_file:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=err_file,
        )
        assert proc.stdin is not None
        try:
            try:
                for chunk in chunks:
                    proc.stdin.write(chunk)
                proc.stdin.close()
            except BrokenPipeError:
                pass
            proc.wait()
        except Exception:
            proc.kill()
            proc.wait()
            raise
        err_file.seek(0)
        stderr = err_file.read().decode(errors="replace")
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg encode failed: {stderr}")


def _write_jpeg(ffmpeg: str, frame: NDArray, dest: Path) -> None:  # type: ignore[type-arg]
    height, width = frame.shape[:2]
    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg,
        "-y",
        *_FFMPEG_QUIET,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s:v",
        f"{width}x{height}",
        "-i",
        "pipe:0",
        "-vf",
        _SCALE_FILTER,
        "-frames:v",
        "1",
        "-q:v",
        "3",
        str(dest),
    ]
    _pipe_ffmpeg(cmd, iter((frame.tobytes(),)))


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

        raw_first = tif.pages[0].asarray()
        scale = _rgb_scale(raw_first)
        first = _as_rgb24(raw_first, scale)
        height, width = first.shape[:2]
        _write_jpeg(ffmpeg, first, poster_path)

        cmd = [
            ffmpeg,
            "-y",
            *_FFMPEG_QUIET,
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-s:v",
            f"{width}x{height}",
            "-r",
            _ffmpeg_rate(fps),
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
            # Every frame is a keyframe so the in-app player can scrub
            # a short timelapse without waiting for the next GOP.
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

        def _chunks() -> Iterator[bytes]:
            yield first.tobytes()
            for page in tif.pages[1:]:
                yield _as_rgb24(page.asarray(), scale).tobytes()

        _pipe_ffmpeg(cmd, _chunks())
