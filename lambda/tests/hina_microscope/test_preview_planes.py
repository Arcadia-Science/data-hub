"""Frame-by-frame ND2 reduction keeps one plane per channel."""

from __future__ import annotations

import numpy as np
import pytest

from data_hub_lambda.deadline import clear_deadline
from data_hub_lambda.hina_microscope.image_processing import _reduce_loops


@pytest.fixture(autouse=True)
def _no_deadline() -> None:
    clear_deadline()


def test_max_projects_z_and_keeps_the_first_timepoint() -> None:
    frames = {
        0: np.array([[1, 1], [1, 1]], dtype=np.uint8),
        1: np.array([[5, 0], [0, 2]], dtype=np.uint8),
        2: np.array([[9, 9], [9, 9]], dtype=np.uint8),
    }
    loops = [
        {"C": 0, "Z": 0, "T": 0},
        {"C": 0, "Z": 1, "T": 0},
        {"C": 0, "Z": 0, "T": 1},
    ]

    planes = _reduce_loops(frames.get, loops, {"C": 1, "Z": 2, "T": 2, "Y": 2, "X": 2}, 3)

    assert len(planes) == 1
    assert planes[0].tolist() == [[5, 1], [1, 2]]


def test_later_timepoint_is_not_read() -> None:
    read: list[int] = []

    def _read(index: int) -> np.ndarray:
        read.append(index)
        return np.zeros((2, 2), dtype=np.uint8)

    loops = [{"C": 0, "T": 0}, {"C": 0, "T": 1}]
    _reduce_loops(_read, loops, {"C": 1, "T": 2, "Y": 2, "X": 2}, 2)
    assert read == [0]
