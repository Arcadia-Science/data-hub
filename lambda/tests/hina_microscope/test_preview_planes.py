"""Frame-by-frame ND2 reduction keeps one plane per channel, and big planes shrink."""

from __future__ import annotations
from collections.abc import Callable
from itertools import product

import numpy as np
import pytest
from numpy.typing import NDArray

from data_hub_lambda.deadline import ProcessingDeadlineError, set_deadline_from_remaining_ms
from data_hub_lambda.hina_microscope import image_processing
from data_hub_lambda.hina_microscope.image_processing import (
    MAX_PREVIEW_BYTES,
    RGB_NOT_SUPPORTED_MESSAGE,
    _reduce_loops,
    _shrink_plane,
    _shrink_planes,
    plane_bytes,
    preview_bytes,
    preview_shrink_factor,
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

    planes = _reduce_loops(_reader([1, 9, 5], n_channels, read), loops, sizes)

    assert [plane.tolist() for plane in planes] == _expected(9, n_channels)
    assert read == [0, 1, 2]
    assert all(plane.dtype == np.uint16 for plane in planes)


@pytest.mark.parametrize("axis", ["T", "P", "U"])
def test_other_axes_keep_the_first_index(n_channels: int, axis: str) -> None:
    read: list[int] = []
    loops = [{axis: index} for index in range(2)]
    sizes = {axis: 2, "C": n_channels, "Y": 2, "X": 2}

    planes = _reduce_loops(_reader([7, 8], n_channels, read), loops, sizes)

    assert [plane.tolist() for plane in planes] == _expected(7, n_channels)
    assert read == [0]


def test_t_and_z_project_the_first_timepoint(n_channels: int) -> None:
    read: list[int] = []
    loops = [{"T": t, "Z": z} for t, z in product(range(2), range(3))]
    sizes = {"T": 2, "Z": 3, "C": n_channels, "Y": 2, "X": 2}
    values = [1, 4, 2, 50, 60, 70]

    planes = _reduce_loops(_reader(values, n_channels, read), loops, sizes)

    assert [plane.tolist() for plane in planes] == _expected(4, n_channels)
    assert read == [0, 1, 2]


def test_the_first_frame_is_not_changed_by_later_frames() -> None:
    first = _frame(1, 1)
    frames = [first, _frame(9, 1)]

    planes = _reduce_loops(frames.__getitem__, [{"Z": 0}, {"Z": 1}], {"Z": 2, "Y": 2, "X": 2})

    assert planes[0].tolist() == _expected(9, 1)[0]
    assert first.tolist() == _expected(1, 1)[0]


def test_deadline_stops_before_the_first_frame() -> None:
    read: list[int] = []
    set_deadline_from_remaining_ms(0)

    with pytest.raises(ProcessingDeadlineError, match="reading frame 1 of 3"):
        _reduce_loops(_reader([1, 2, 3], 1, read), [{"Z": z} for z in range(3)], {"Z": 3})

    assert read == []


def test_deadline_counts_only_the_frames_that_are_read() -> None:
    loops = [{"T": t, "Z": z} for t, z in product(range(100), range(2))]
    set_deadline_from_remaining_ms(0)

    with pytest.raises(ProcessingDeadlineError, match="reading frame 1 of 2"):
        _reduce_loops(_reader([1] * len(loops), 1, []), loops, {"T": 100, "Z": 2})


def test_missing_channel_plane_is_an_error() -> None:
    with pytest.raises(ValueError, match="missing a channel plane: T=2, C=2"):
        _reduce_loops(_reader([1, 2], 2, []), [{"T": 1}], {"T": 2, "C": 2, "Y": 2, "X": 2})


@pytest.mark.parametrize(
    ("frame", "n_channels"),
    [
        (np.zeros((2, 2, 2, 2), dtype=np.uint16), 2),
        (np.zeros((4, 2, 5), dtype=np.uint16), 3),
        (np.zeros(_SHAPE, dtype=np.uint16), 2),
    ],
    ids=["four-dimensional", "no-channel-axis", "one-plane-for-two-channels"],
)
def test_unexpected_frame_shape_is_an_error(frame: NDArray[np.uint16], n_channels: int) -> None:
    sizes = {"C": n_channels, "Y": 2, "X": 2}

    with pytest.raises(ValueError, match="Unexpected ND2 frame shape"):
        _reduce_loops(lambda _index: frame, [{}], sizes)


def test_rgb_file_is_rejected_before_any_frame_is_read() -> None:
    read: list[int] = []

    with pytest.raises(ValueError, match=RGB_NOT_SUPPORTED_MESSAGE):
        _reduce_loops(_reader([1], 1, read), [{}], {"Y": 2, "X": 2, "S": 3})

    assert read == []


def test_preview_size_grows_with_pixels_and_channels() -> None:
    small = preview_bytes({"C": 4, "Y": 2048, "X": 2048, "Z": 50})
    more_channels = preview_bytes({"C": 8, "Y": 2048, "X": 2048})
    huge = preview_bytes({"C": 4, "Y": 8192, "X": 8192})

    assert small < more_channels < MAX_PREVIEW_BYTES < huge
    assert preview_bytes({"C": 4, "Y": 2048, "X": 2048}) == small


@pytest.mark.parametrize(
    "sizes",
    [
        {"Y": 1024, "X": 1024, "T": 400},
        {"C": 4, "Y": 2304, "X": 2304, "Z": 15},
        {"C": 3, "Y": 3789, "X": 3789, "Z": 3},
        {"C": 4, "Y": 4263, "X": 4263, "Z": 9},
    ],
    ids=["timelapse", "four-channel-2304", "three-channel-3789", "four-channel-4263"],
)
def test_an_image_that_fits_is_not_shrunk(sizes: dict[str, int]) -> None:
    assert preview_bytes(sizes) <= MAX_PREVIEW_BYTES
    assert preview_shrink_factor(sizes) == 1


@pytest.mark.parametrize(
    "sizes",
    [
        {"C": 2, "Y": 6221, "X": 6221, "Z": 9},
        {"C": 3, "Y": 6221, "X": 6221, "Z": 5},
        {"C": 3, "Y": 5530, "X": 5530, "Z": 5},
        {"C": 4, "Y": 5530, "X": 5530, "Z": 5},
    ],
    ids=["two-channel-6221", "three-channel-6221", "three-channel-5530", "four-channel-5530"],
)
def test_an_image_over_the_cap_is_halved(sizes: dict[str, int]) -> None:
    assert preview_bytes(sizes) > MAX_PREVIEW_BYTES
    assert preview_shrink_factor(sizes) == 2


def test_the_shrink_factor_is_the_smallest_one_that_fits() -> None:
    sizes = {"C": 4, "Y": 20_000, "X": 20_000}

    factor = preview_shrink_factor(sizes)

    def shrunk(by: int) -> dict[str, int]:
        return {"C": 4, "Y": 20_000 // by, "X": 20_000 // by}

    assert factor > 2
    assert preview_bytes(shrunk(factor)) <= MAX_PREVIEW_BYTES
    assert preview_bytes(shrunk(factor - 1)) > MAX_PREVIEW_BYTES


def test_the_shrink_factor_never_empties_a_plane(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(image_processing, "MAX_PREVIEW_BYTES", 1)

    assert preview_shrink_factor({"Y": 6, "X": 4}) == 4


def test_planes_are_read_in_twice_their_size() -> None:
    assert plane_bytes({"C": 3, "Y": 10, "X": 10, "Z": 5}, 2) == 2 * 3 * 10 * 10 * 2
    assert plane_bytes({"Y": 10, "X": 10}, 4) == 2 * 10 * 10 * 4


def test_planes_for_a_production_image_fit_easily() -> None:
    assert plane_bytes({"C": 3, "Y": 6221, "X": 6221, "Z": 5}, 2) < MAX_PREVIEW_BYTES // 8
    assert plane_bytes({"C": 3, "Y": 18_800, "X": 18_800}, 2) <= MAX_PREVIEW_BYTES
    assert plane_bytes({"C": 3, "Y": 19_000, "X": 19_000}, 2) > MAX_PREVIEW_BYTES


def test_shrinking_averages_each_block() -> None:
    plane = np.array(
        [[0, 2, 10, 20], [2, 4, 30, 40], [1, 1, 5, 5], [1, 1, 5, 5]],
        dtype=np.uint16,
    )

    shrunk = _shrink_plane(plane, 2)

    assert shrunk.tolist() == [[2, 25], [1, 5]]
    assert shrunk.dtype == np.uint16


def test_shrinking_rounds_to_the_nearest_value() -> None:
    plane = np.array([[1, 1], [1, 0]], dtype=np.uint16)

    assert _shrink_plane(plane, 2).tolist() == [[1]]


def test_shrinking_does_not_overflow_the_pixel_type() -> None:
    plane = np.full((4, 4), np.iinfo(np.uint16).max, dtype=np.uint16)

    assert _shrink_plane(plane, 2).tolist() == [[65535, 65535], [65535, 65535]]


def test_shrinking_keeps_float_values() -> None:
    plane = np.array([[0.0, 0.25], [0.5, 0.75]], dtype=np.float32)

    shrunk = _shrink_plane(plane, 2)

    assert shrunk.dtype == np.float32
    assert shrunk.tolist() == [[0.375]]


def test_shrinking_drops_a_remainder_smaller_than_a_block() -> None:
    plane = np.arange(5 * 7, dtype=np.uint16).reshape(5, 7)

    shrunk = _shrink_plane(plane, 2)

    assert shrunk.shape == (2, 3)
    assert shrunk[0, 0] == round(plane[:2, :2].mean())
    assert shrunk[1, 2] == round(plane[2:4, 4:6].mean())


def test_a_factor_of_one_returns_the_plane_itself() -> None:
    plane = np.arange(4, dtype=np.uint16).reshape(2, 2)

    assert _shrink_plane(plane, 1) is plane


def test_shrinking_planes_replaces_each_one_in_the_list() -> None:
    planes = [np.zeros((4, 6), dtype=np.uint16), np.ones((4, 6), dtype=np.uint16)]

    result = _shrink_planes(planes, 2)

    assert result is planes
    assert [plane.shape for plane in planes] == [(2, 3), (2, 3)]
    assert [plane.tolist() for plane in planes] == [[[0] * 3] * 2, [[1] * 3] * 2]
