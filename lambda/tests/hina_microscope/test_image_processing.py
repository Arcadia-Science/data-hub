"""Unit tests for `hina_microscope.image_processing`.

The helper tests need no ND2 file. The `ND2Processor` tests use the small
example files that ship with the locked `arcadia-microscopy-tools` package.
"""

from __future__ import annotations
import importlib.resources
import re
import shutil
import subprocess
from collections.abc import Iterable
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import nd2
import numpy as np
import pytest
from PIL import Image

from data_hub_lambda.deadline import ProcessingDeadlineError, set_deadline_from_remaining_ms
from data_hub_lambda.hina_microscope import image_processing
from data_hub_lambda.hina_microscope.image_processing import (
    PREVIEW_TOO_LARGE_MESSAGE,
    ND2Processor,
    _percentile_range,
    _rescale,
    frame_interval_ms,
)
from data_hub_lambda.hina_microscope.parse_metadata import parse_metadata

_EXAMPLES = Path(str(importlib.resources.files("arcadia_microscopy_tools"))) / "tests" / "data"


def _halved(planes: np.ndarray) -> np.ndarray:
    """Average 2 x 2 blocks of a `(C, Y, X)` stack, written without the code under test."""
    channels, height, width = planes.shape
    blocks = planes.reshape(channels, height // 2, 2, width // 2, 2)
    return np.rint(blocks.mean(axis=(2, 4))).astype(planes.dtype)


class TestContrast:
    def test_range_maps_to_0_1(self) -> None:
        arr = np.linspace(100, 200, 100, dtype=np.float64)

        out = _rescale(arr, _percentile_range(arr, (1, 99)))

        assert out.min() == pytest.approx(0.0, abs=1e-6)
        assert out.max() == pytest.approx(1.0, abs=1e-6)

    def test_constant_array_has_no_range_and_renders_as_zeros(self) -> None:
        arr = np.full((4, 4), 42.0, dtype=np.float64)

        assert _percentile_range(arr) is None
        np.testing.assert_array_equal(_rescale(arr, None), np.zeros_like(arr))

    def test_empty_array_has_no_range_and_stays_empty(self) -> None:
        arr = np.array([], dtype=np.float64)

        assert _percentile_range(arr) is None
        assert _rescale(arr, None).shape == (0,)

    def test_values_outside_a_fixed_range_are_clipped(self) -> None:
        arr = np.array([0.0, 100.0, 150.0, 200.0, 400.0])

        out = _rescale(arr, (100.0, 200.0))

        assert out.tolist() == [0.0, 0.0, 0.5, 1.0, 1.0]


def _loop(kind: str, **parameters: Any) -> SimpleNamespace:
    return SimpleNamespace(type=kind, parameters=SimpleNamespace(**parameters))


def _diff(avg: float) -> SimpleNamespace:
    return SimpleNamespace(avg=avg)


class TestFrameInterval:
    def test_time_loop_uses_the_measured_interval(self) -> None:
        loop = _loop("TimeLoop", periodMs=0.0, periodDiff=_diff(500.16))

        assert frame_interval_ms([loop]) == 500.16

    @pytest.mark.parametrize("diff", [None, _diff(0.0)], ids=["no-diff", "zero"])
    def test_time_loop_without_a_measured_interval_has_none(self, diff: object) -> None:
        assert frame_interval_ms([_loop("TimeLoop", periodMs=1000.0, periodDiff=diff)]) is None

    def test_nd_time_loop_weights_each_phase_by_its_frames(self) -> None:
        periods = [
            SimpleNamespace(count=3, periodDiff=_diff(100.0)),
            SimpleNamespace(count=1, periodDiff=_diff(500.0)),
            SimpleNamespace(count=5, periodDiff=None),
        ]

        assert frame_interval_ms([_loop("NETimeLoop", periods=periods)]) == 200.0

    def test_file_without_a_time_loop_has_none(self) -> None:
        assert frame_interval_ms([_loop("ZStackLoop")]) is None
        assert frame_interval_ms([]) is None


class TestExampleFiles:
    """Regression checks against `nd2`'s own whole-file read of each example."""

    def test_z_stack_preview_is_the_max_projection(self, tmp_path: Path) -> None:
        path = _EXAMPLES / "example-zstack.nd2"
        processor = ND2Processor(path)
        processor.load()

        assert parse_metadata(processor.image) == {
            "sizes": {"Z": 11, "Y": 128, "X": 128},
            "channels": [
                {"name": "FITC", "excitation_nm": 488, "emission_nm": 512, "color": "#07ff00"}
            ],
            "dimensions": ["Z_STACK"],
        }
        planes = processor._planes
        assert planes is not None
        np.testing.assert_array_equal(planes[0], np.asarray(nd2.imread(path)).max(axis=0))
        assert planes[0].dtype == np.uint16

        jpg = processor.export_jpg(output_dir=tmp_path)
        with Image.open(jpg) as image:
            assert image.mode == "RGB"
            assert image.size == (128, 128)

    def test_multichannel_preview_keeps_every_channel(self) -> None:
        path = _EXAMPLES / "example-multichannel.nd2"
        processor = ND2Processor(path)
        processor.load()

        assert [channel.name for channel in processor.image.channels] == [
            "BRIGHTFIELD",
            "DAPI",
            "FITC",
            "TRITC",
        ]
        planes = processor._planes
        assert planes is not None
        np.testing.assert_array_equal(np.stack(planes), np.asarray(nd2.imread(path)))

    def test_timelapse_preview_is_the_first_frame(self) -> None:
        path = _EXAMPLES / "example-timelapse.nd2"
        processor = ND2Processor(path)
        processor.load()

        planes = processor._planes
        assert planes is not None
        np.testing.assert_array_equal(planes[0], np.asarray(nd2.imread(path))[0])

    @pytest.mark.parametrize(
        ("name", "cap", "jpg_size"),
        [
            ("example-zstack.nd2", 1_000_000, (64, 64)),
            ("example-multichannel.nd2", 5_000_000, (128, 128)),
        ],
        ids=["z-stack", "multichannel"],
    )
    def test_image_over_the_cap_is_shrunk_and_still_renders(
        self,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
        name: str,
        cap: int,
        jpg_size: tuple[int, int],
    ) -> None:
        path = _EXAMPLES / name
        full = ND2Processor(path)
        full.load()
        assert image_processing.preview_bytes(full.image.sizes) > cap
        monkeypatch.setattr(image_processing, "MAX_PREVIEW_BYTES", cap)
        processor = ND2Processor(path)

        processor.load()

        planes = processor._planes
        assert planes is not None
        reference = np.asarray(nd2.imread(path))
        if "Z" in full.image.sizes:
            reference = reference.max(axis=0)
        reference = reference.reshape(-1, *reference.shape[-2:])
        np.testing.assert_array_equal(np.stack(planes), _halved(reference))
        assert all(plane.dtype == np.uint16 for plane in planes)
        assert processor.image.sizes == full.image.sizes
        assert parse_metadata(processor.image) == parse_metadata(full.image)
        with Image.open(processor.export_jpg(output_dir=tmp_path)) as image:
            assert image.mode == "RGB"
            assert image.size == jpg_size

    def test_image_whose_planes_do_not_fit_fails_before_reading_frames(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def _no_read(*_args: object) -> None:
            raise AssertionError("an oversized image should not be read")

        path = _EXAMPLES / "example-zstack.nd2"
        with nd2.ND2File(path) as nd2f:
            read_bytes = image_processing.read_peak_bytes(dict(nd2f.sizes), nd2f.dtype.itemsize)
        monkeypatch.setattr(image_processing, "MAX_PREVIEW_BYTES", read_bytes - 1)
        monkeypatch.setattr(image_processing, "_preview_planes", _no_read)
        processor = ND2Processor(path)

        with pytest.raises(ValueError, match="too large for a preview") as exc:
            processor.load()

        assert str(exc.value) == PREVIEW_TOO_LARGE_MESSAGE


_TIMELAPSE = _EXAMPLES / "example-timelapse.nd2"


def _frame_count_and_fps(mp4: Path) -> tuple[int, str]:
    """Decode *mp4* with ffmpeg, which prints the stream rate and the frames it read."""
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(mp4), "-f", "null", "-"],
        capture_output=True,
        text=True,
        check=True,
    )
    frames = re.findall(r"frame=\s*(\d+)", result.stderr)
    fps = re.search(r"(\d+(?:\.\d+)?) fps", result.stderr)
    assert frames
    assert fps is not None
    return int(frames[-1]), fps.group(1)


class TestTimelapseVideo:
    @pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is not on PATH")
    def test_every_time_point_is_one_frame_at_the_floor_rate(self, tmp_path: Path) -> None:
        processor = ND2Processor(_TIMELAPSE)
        processor.load()

        video = processor.export_mp4(output_dir=tmp_path)

        assert video is not None
        assert video.path == tmp_path / "example-timelapse.mp4"
        assert video.frames == 53
        assert video.frame_interval_ms == pytest.approx(500.16)
        # 500 ms between frames is 2 fps, below the 10 fps floor.
        assert video.playback_fps == 10.0
        assert _frame_count_and_fps(video.path) == (53, "10")

    @pytest.mark.parametrize("name", ["example-zstack.nd2", "example-multichannel.nd2"])
    def test_a_single_time_point_makes_no_video(self, tmp_path: Path, name: str) -> None:
        processor = ND2Processor(_EXAMPLES / name)
        processor.load()

        assert processor.export_mp4(output_dir=tmp_path) is None
        assert list(tmp_path.iterdir()) == []

    def test_frames_are_read_in_order_with_the_first_frames_contrast(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        processor = ND2Processor(_TIMELAPSE)
        processor.load()
        chunks: list[bytes] = []
        ranges: list[object] = []
        real_rescale = image_processing._rescale

        def _record_rescale(plane: Any, contrast: Any) -> Any:
            ranges.append(contrast)
            return real_rescale(plane, contrast)

        def _capture(frames: Iterable[bytes], **_kwargs: object) -> None:
            chunks.extend(frames)

        monkeypatch.setattr(image_processing, "_rescale", _record_rescale)
        monkeypatch.setattr(image_processing, "encode_rgb24", _capture)

        processor.export_mp4(output_dir=tmp_path)

        stack = np.asarray(nd2.imread(_TIMELAPSE))
        assert len(chunks) == 53
        assert set(ranges) == {_percentile_range(stack[0])}
        assert chunks[0] == processor._render_uint8([stack[0]]).tobytes()
        assert chunks[30] == processor._render_uint8([stack[30]]).tobytes()
        assert chunks[30] != chunks[0]

    def test_time_points_without_frames_are_skipped(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        processor = ND2Processor(_TIMELAPSE)
        processor.load()
        chunks: list[bytes] = []
        real_indices = image_processing._frame_indices_by_time

        # A capture stopped early: the last three time points have no frames.
        def _stopped_early(loops: Any, sizes: Any) -> list[list[int]]:
            return [*real_indices(loops, sizes)[:50], [], [], []]

        def _capture(frames: Iterable[bytes], **_kwargs: object) -> None:
            chunks.extend(frames)

        monkeypatch.setattr(image_processing, "_frame_indices_by_time", _stopped_early)
        monkeypatch.setattr(image_processing, "encode_rgb24", _capture)

        video = processor.export_mp4(output_dir=tmp_path)

        assert video is not None
        assert video.frames == 50
        assert len(chunks) == 50

    def test_only_the_first_time_point_with_frames_makes_no_video(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        processor = ND2Processor(_TIMELAPSE)
        processor.load()
        real_indices = image_processing._frame_indices_by_time

        def _first_only(loops: Any, sizes: Any) -> list[list[int]]:
            return [real_indices(loops, sizes)[0], *([[]] * 52)]

        monkeypatch.setattr(image_processing, "_frame_indices_by_time", _first_only)

        assert processor.export_mp4(output_dir=tmp_path) is None
        assert list(tmp_path.iterdir()) == []

    def test_encode_stops_before_the_time_limit(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        processor = ND2Processor(_TIMELAPSE)
        processor.load()
        monkeypatch.setattr(
            image_processing, "encode_rgb24", lambda frames, **_kwargs: list(frames)
        )
        set_deadline_from_remaining_ms(0)

        with pytest.raises(ProcessingDeadlineError, match=r"encoding \(1 of 53 frames done\)"):
            processor.export_mp4(output_dir=tmp_path)
