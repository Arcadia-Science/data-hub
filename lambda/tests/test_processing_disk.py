"""The processing disk check refuses objects that will not fit."""

from __future__ import annotations
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from data_hub_lambda.processing_disk import (
    ObjectTooLargeForDiskError,
    ensure_object_fits_on_disk,
)


def test_object_smaller_than_free_space_passes(tmp_path: Path) -> None:
    with (
        patch(
            "data_hub_lambda.processing_disk.s3_utils.object_content_length",
            return_value=1024,
        ),
        patch(
            "data_hub_lambda.processing_disk.shutil.disk_usage",
            return_value=SimpleNamespace(free=10 * 1024**3),
        ),
    ):
        ensure_object_fits_on_disk("s3://raw/dishcam/run/stack.tif", tmp_path)


def test_object_larger_than_free_space_names_both_sizes(tmp_path: Path) -> None:
    with (
        patch(
            "data_hub_lambda.processing_disk.s3_utils.object_content_length",
            return_value=11_097_280_814,
        ),
        patch(
            "data_hub_lambda.processing_disk.shutil.disk_usage",
            return_value=SimpleNamespace(free=10 * 1024**3),
        ),
        pytest.raises(ObjectTooLargeForDiskError) as raised,
    ):
        ensure_object_fits_on_disk("s3://raw/dishcam/run/stack.tif", tmp_path)

    assert str(raised.value) == (
        "File is 10.3 GB, larger than the 10.0 GB of disk available for processing. "
        "The raw file is stored and can be downloaded."
    )
