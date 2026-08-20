"""Parse DishCam sidecar `run.json` into run metadata and encode fps."""

from __future__ import annotations
import json
from pathlib import Path
from typing import Any

_METADATA_KEYS = (
    "fps",
    "measured_fps",
    "frames",
    "duration_seconds",
    "quality",
    "format",
    "started",
    "finished",
)


def parse_run_json(path: Path) -> dict[str, Any]:
    """Return the sidecar fields stored on the run.

    Raises `ValueError` when the file is not an object or has no usable fps.
    """
    try:
        payload = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid run.json: {exc}") from exc
    if not isinstance(payload, dict):
        raise ValueError("run.json must be a JSON object")

    metadata = {
        key: payload[key] for key in _METADATA_KEYS if key in payload and payload[key] is not None
    }
    encode_fps(metadata)
    return metadata


def encode_fps(metadata: dict[str, Any]) -> float:
    """Prefer measured fps when present; otherwise use the planned fps."""
    raw = metadata.get("measured_fps")
    if raw is None:
        raw = metadata.get("fps")
    if raw is None:
        raise ValueError("run.json is missing fps and measured_fps")
    try:
        fps = float(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"run.json fps is not a number: {raw!r}") from exc
    if fps <= 0:
        raise ValueError(f"run.json fps must be positive, got {fps}")
    return fps


# Multi-day captures can land well below 1 fps. The in-app player is a
# preview, so floor the encode rate rather than playing in real time.
MIN_PLAYBACK_FPS = 10.0


def playback_fps(capture_fps: float) -> float:
    """Return the fps used for the MP4 preview, not the stored metadata."""
    return max(capture_fps, MIN_PLAYBACK_FPS)
