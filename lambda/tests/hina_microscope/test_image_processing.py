"""Unit tests for `hina_microscope.image_processing`.

Covers the deterministic helper functions (`_reduce_to_2d`,
`_rescale_percentile`) without requiring a real ND2 fixture.
"""

from __future__ import annotations

import numpy as np
import pytest

from data_hub_lambda.hina_microscope.image_processing import (
    ND2Processor,
    _rescale_percentile,
)


class TestReduceTo2D:
    def test_2d_input_passes_through(self) -> None:
        arr = np.arange(16, dtype=np.float64).reshape(4, 4)

        out = ND2Processor._reduce_to_2d(arr, ["Y", "X"])

        np.testing.assert_array_equal(out, arr)

    def test_z_axis_takes_max_projection(self) -> None:
        # Z-stack with a per-plane max at z=2 in every pixel.
        stack = np.stack(
            [
                np.full((3, 3), 1, dtype=np.float64),
                np.full((3, 3), 5, dtype=np.float64),
                np.full((3, 3), 9, dtype=np.float64),
            ]
        )

        out = ND2Processor._reduce_to_2d(stack, ["Z", "Y", "X"])

        assert out.shape == (3, 3)
        assert np.all(out == 9)

    def test_t_axis_takes_first_frame(self) -> None:
        series = np.stack(
            [
                np.full((2, 2), 1, dtype=np.float64),
                np.full((2, 2), 2, dtype=np.float64),
            ]
        )

        out = ND2Processor._reduce_to_2d(series, ["T", "Y", "X"])

        assert np.all(out == 1)

    def test_p_axis_takes_first_point(self) -> None:
        positions = np.stack(
            [
                np.full((2, 2), 7, dtype=np.float64),
                np.full((2, 2), 8, dtype=np.float64),
            ]
        )

        out = ND2Processor._reduce_to_2d(positions, ["P", "Y", "X"])

        assert np.all(out == 7)

    def test_tz_combined_reduces_in_order(self) -> None:
        # shape: (T=2, Z=3, Y=2, X=2). First T is a Z-stack with max=9.
        arr = np.arange(24, dtype=np.float64).reshape(2, 3, 2, 2)

        out = ND2Processor._reduce_to_2d(arr, ["T", "Z", "Y", "X"])

        # T=0 slice is arr[0] (shape 3,2,2). Max over Z=0 axis gives arr[0][2].
        np.testing.assert_array_equal(out, arr[0].max(axis=0))


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
