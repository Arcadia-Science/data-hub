"""Frame-by-frame ND2 reduction keeps one plane per channel."""

from __future__ import annotations
from collections.abc import Callable
from itertools import product

import numpy as np
import pytest
from numpy.typing import NDArray

from data_hub_lambda.deadline import ProcessingDeadlineError, set_deadline_from_remaining_ms
from data_hub_lambda.hina_microscope.image_processing import (
    MAX_PREVIEW_BYTES,
    _reduce_loops,
    preview_bytes,
)

_SHAPE = (2, 2)


def _frame(value: int, n_channels: int) -> NDArray[np.uint16]:
    """One `read_frame` result: `(C, Y, X)`, squeezed to `(Y, X)` for one channel."""
    planes = [
        np.full(_SHAPE, value + 100 * channel, dtype=np.uint16) for channel in range(n_channels)
    ]
    return np.stack(planes).squeeze(axis=0) if n_channels == 1 else np.stack(planes)


def _reader(
    values: list[int], n_channels: int, read: list[int]
) -> Callable[[int], NDArray[np.uint16]]:
    def _read(index: int) -> NDArray[np.uint16]:
        read.append(index)
        return _frame(values[index], n_channels)

    return _read


def _expected(value: int, n_channels: int) -> list[list[list[int]]]:
    return [np.full(_SHAPE, value + 100 * channel).tolist() for channel in range(n_channels)]


@pytest.fixture(params=[1, 3], ids=["one-channel", "three-channels"])
def n_channels(request: pytest.FixtureRequest) -> int:
    return request.param


def test_z_is_max_projected(n_channels: int) -> None:
    read: list[int] = []
    loops = [{"Z": z} for z in range(3)]
    sizes = {"Z": 3, "C": n_channels, "Y": 2, "X": 2}

    planes = _reduce_loops(_reader([1, 9, 5], n_channels, read), loops, sizes, 3)

    assert [plane.tolist() for plane in planes] == _expected(9, n_channels)
    assert read == [0, 1, 2]
    assert all(plane.dtype == np.uint16 for plane in planes)


@pytest.mark.parametrize("axis", ["T", "P"])
def test_other_axes_keep_the_first_index(n_channels: int, axis: str) -> None:
    read: list[int] = []
    loops = [{axis: index} for index in range(2)]
    sizes = {axis: 2, "C": n_channels, "Y": 2, "X": 2}

    planes = _reduce_loops(_reader([7, 8], n_channels, read), loops, sizes, 2)

    assert [plane.tolist() for plane in planes] == _expected(7, n_channels)
    assert read == [0]


def test_t_and_z_project_the_first_timepoint(n_channels: int) -> None:
    read: list[int] = []
    loops = [{"T": t, "Z": z} for t, z in product(range(2), range(3))]
    sizes = {"T": 2, "Z": 3, "C": n_channels, "Y": 2, "X": 2}
    values = [1, 4, 2, 50, 60, 70]

    planes = _reduce_loops(_reader(values, n_channels, read), loops, sizes, len(loops))

    assert [plane.tolist() for plane in planes] == _expected(4, n_channels)
    assert read == [0, 1, 2]


def test_the_first_frame_is_not_changed_by_later_frames() -> None:
    first = _frame(1, 1)
    frames = [first, _frame(9, 1)]

    planes = _reduce_loops(frames.__getitem__, [{"Z": 0}, {"Z": 1}], {"Z": 2, "Y": 2, "X": 2}, 2)

    assert planes[0].tolist() == _expected(9, 1)[0]
    assert first.tolist() == _expected(1, 1)[0]


def test_deadline_stops_before_the_first_frame() -> None:
    read: list[int] = []
    set_deadline_from_remaining_ms(0)

    with pytest.raises(ProcessingDeadlineError, match="reading frame 1 of 3"):
        _reduce_loops(_reader([1, 2, 3], 1, read), [{"Z": z} for z in range(3)], {"Z": 3}, 3)

    assert read == []


def test_preview_size_grows_with_pixels_and_channels() -> None:
    small = preview_bytes({"C": 4, "Y": 2048, "X": 2048, "Z": 50})
    more_channels = preview_bytes({"C": 8, "Y": 2048, "X": 2048})
    huge = preview_bytes({"C": 4, "Y": 8192, "X": 8192})

    assert small < more_channels < MAX_PREVIEW_BYTES < huge
    assert preview_bytes({"C": 4, "Y": 2048, "X": 2048}) == small
