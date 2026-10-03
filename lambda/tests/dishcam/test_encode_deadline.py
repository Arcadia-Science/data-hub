"""The DishCam encode stops before the Lambda time limit."""

from __future__ import annotations
from pathlib import Path

import numpy as np
import pytest
import tifffile

from data_hub_lambda.deadline import ProcessingDeadlineError, set_deadline_from_remaining_ms
from data_hub_lambda.dishcam.encode_video import encode_tiff_stack


def _two_page_tiff(path: Path) -> None:
    frame = np.zeros((8, 8, 3), dtype=np.uint8)
    with tifffile.TiffWriter(path) as writer:
        writer.write(frame, photometric="rgb")
        writer.write(frame, photometric="rgb")


def test_encode_stops_before_the_first_frame(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    tiff = tmp_path / "stack.tif"
    _two_page_tiff(tiff)
    monkeypatch.setattr("data_hub_lambda.dishcam.encode_video.resolve_ffmpeg", lambda: "ffmpeg")
    set_deadline_from_remaining_ms(0)

    with pytest.raises(ProcessingDeadlineError, match=r"0 of 2 frames done"):
        encode_tiff_stack(tiff, tmp_path / "out.mp4", tmp_path / "out.jpg", 1.0)


def test_encode_stops_between_frames(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    tiff = tmp_path / "stack.tif"
    _two_page_tiff(tiff)
    calls: list[str] = []

    def _check(step: str) -> None:
        calls.append(step)
        if len(calls) == 2:
            raise ProcessingDeadlineError(step)

    monkeypatch.setattr("data_hub_lambda.dishcam.encode_video.check_deadline", _check)
    monkeypatch.setattr("data_hub_lambda.dishcam.encode_video.resolve_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr("data_hub_lambda.dishcam.encode_video._write_jpeg", lambda *_a, **_k: None)
    monkeypatch.setattr(
        "data_hub_lambda.dishcam.encode_video._pipe_ffmpeg",
        lambda _cmd, chunks: list(chunks),
    )

    with pytest.raises(ProcessingDeadlineError, match=r"1 of 2 frames done"):
        encode_tiff_stack(tiff, tmp_path / "out.mp4", tmp_path / "out.jpg", 1.0)

    assert calls == [
        "encoding (0 of 2 frames done)",
        "encoding (1 of 2 frames done)",
    ]
