"""Unit tests for `hina_microscope.image_processing`.

The helper tests need no ND2 file. The `ND2Processor` tests use the small
example files that ship with the locked `arcadia-microscopy-tools` package.
"""

from __future__ import annotations
import importlib.resources
from pathlib import Path

import nd2
import numpy as np
import pytest
from PIL import Image

from data_hub_lambda.hina_microscope import image_processing
from data_hub_lambda.hina_microscope.image_processing import (
    PREVIEW_TOO_LARGE_MESSAGE,
    ND2Processor,
    _rescale_percentile,
)
from data_hub_lambda.hina_microscope.parse_metadata import parse_metadata

_EXAMPLES = Path(str(importlib.resources.files("arcadia_microscopy_tools"))) / "tests" / "data"


class TestRescalePercentile:
    def test_range_maps_to_0_1(self) -> None:
        arr = np.linspace(100, 200, 100, dtype=np.float64)

        out = _rescale_percentile(arr, (1, 99))

        assert out.min() == pytest.approx(0.0, abs=1e-6)
        assert out.max() == pytest.approx(1.0, abs=1e-6)

    def test_constant_array_returns_zeros(self) -> None:
        arr = np.full((4, 4), 42.0, dtype=np.float64)

        out = _rescale_percentile(arr, (1, 99))

        np.testing.assert_array_equal(out, np.zeros_like(arr))

    def test_empty_array_returns_empty_array(self) -> None:
        arr = np.array([], dtype=np.float64)

        out = _rescale_percentile(arr, (1, 99))

        assert out.shape == (0,)


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

    def test_too_large_image_fails_before_reading_frames(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def _no_read(*_args: object) -> None:
            raise AssertionError("an oversized image should not be read")

        monkeypatch.setattr(image_processing, "MAX_PREVIEW_BYTES", 1)
        monkeypatch.setattr(image_processing, "_preview_planes", _no_read)
        processor = ND2Processor(_EXAMPLES / "example-zstack.nd2")

        with pytest.raises(ValueError, match="too large for a preview") as exc:
            processor.load()

        assert str(exc.value) == PREVIEW_TOO_LARGE_MESSAGE
