"""Encode RGB frames into the browser-friendly MP4 previews DishCam and Hina share."""

from __future__ import annotations
import shutil
import subprocess
import tempfile
from collections.abc import Iterable
from pathlib import Path

# Width cap keeps the preview inside H.264 Level 5.2 / browser limits
# (a 3040x4056 stack will not play in Safari). `h=-2` keeps height even
# and aspect; the trunc expression makes width even for yuv420p.
SCALE_FILTER = "scale=w='trunc(min(1920,iw)/2)*2':h=-2"

# Progress lines would fill the stderr pipe (~64 KB) and deadlock a
# long encode. Failures still land in the temp-file capture below.
FFMPEG_QUIET = ("-nostats", "-loglevel", "error")

# Slow captures can land well below 1 fps. The in-app player is a
# preview, so floor the encode rate rather than playing in real time.
MIN_PLAYBACK_FPS = 10.0


def playback_fps(capture_fps: float) -> float:
    """Return the fps used for the MP4 preview, not the stored metadata."""
    return max(capture_fps, MIN_PLAYBACK_FPS)


def resolve_ffmpeg() -> str:
    path = shutil.which("ffmpeg")
    if path is None:
        raise RuntimeError("ffmpeg is not on PATH")
    return path


def ffmpeg_rate(fps: float) -> str:
    """Fixed-point rate. ffmpeg rejects scientific notation like `1e-05`."""
    return f"{fps:.6f}".rstrip("0").rstrip(".")


def pipe_ffmpeg(cmd: list[str], chunks: Iterable[bytes]) -> None:
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


def encode_rgb24(
    chunks: Iterable[bytes],
    *,
    width: int,
    height: int,
    fps: float,
    mp4_path: Path,
    ffmpeg: str | None = None,
) -> None:
    """Encode raw uint8 RGB frames of *width* x *height* into an H.264 MP4.

    Each chunk is one frame's bytes. The caller yields them one at a time,
    so memory holds a single frame however long the video is.
    """
    mp4_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg or resolve_ffmpeg(),
        "-y",
        *FFMPEG_QUIET,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s:v",
        f"{width}x{height}",
        "-r",
        ffmpeg_rate(fps),
        "-i",
        "pipe:0",
        "-vf",
        SCALE_FILTER,
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
    pipe_ffmpeg(cmd, chunks)
