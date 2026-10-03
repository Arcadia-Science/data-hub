"""The synthetic TIFF stack writer and its `synthetic-tiff` command."""

from __future__ import annotations
from pathlib import Path

import numpy as np
import pytest
import tifffile
from click.testing import CliRunner

from data_hub_lambda.cli import cli
from data_hub_lambda_devtools import synthetic_stack
from data_hub_lambda_devtools.synthetic_stack import write_synthetic_tiff_stack


def test_synthetic_stack_reaches_the_requested_size(tmp_path: Path) -> None:
    dest = tmp_path / "stack.tif"
    size = write_synthetic_tiff_stack(dest, 50_000, frame_shape=(64, 64, 3))
    assert size >= 50_000
    assert dest.stat().st_size == size
    with tifffile.TiffFile(dest) as tif:
        assert len(tif.pages) > 1
        assert tif.pages[0].shape == (64, 64, 3)
        assert tif.pages[0].dtype == np.uint8


@pytest.fixture
def targets(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    """Record the requested size instead of writing 12 MP frames."""
    seen: list[int] = []

    def _write(_dest: Path, target_bytes: int) -> int:
        seen.append(target_bytes)
        return target_bytes

    monkeypatch.setattr(synthetic_stack, "write_synthetic_tiff_stack", _write)
    return seen


@pytest.mark.parametrize(
    ("args", "expected"),
    [(["--size-gib", "0.5"], 512 * 1024**2), (["--size-bytes", "1000"], 1000)],
)
def test_command_converts_the_size(
    tmp_path: Path, targets: list[int], args: list[str], expected: int
) -> None:
    result = CliRunner().invoke(cli, ["synthetic-tiff", str(tmp_path / "s.tif"), *args])

    assert result.exit_code == 0, result.output
    assert targets == [expected]


@pytest.mark.parametrize(
    "args",
    [
        [],
        ["--size-gib", "1", "--size-bytes", "1"],
        ["--size-gib", "0"],
        ["--size-bytes", "0"],
        ["--size-gb", "1"],
    ],
    ids=["neither", "both", "zero-gib", "zero-bytes", "old-flag"],
)
def test_command_rejects_bad_sizes(tmp_path: Path, targets: list[int], args: list[str]) -> None:
    result = CliRunner().invoke(cli, ["synthetic-tiff", str(tmp_path / "s.tif"), *args])

    assert result.exit_code == 2
    assert targets == []
