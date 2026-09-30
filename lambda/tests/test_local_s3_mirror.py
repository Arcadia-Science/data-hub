"""Tests for the local S3 mirror behind the `data-hub-process handler` CLI."""

from __future__ import annotations
from pathlib import Path

import pytest

from data_hub_lambda import raw_access
from data_hub_lambda.local_s3_mirror import patched_s3
from data_hub_shared.config import config

_RAW_BUCKET = "test-raw-data-bucket"


@pytest.fixture(autouse=True)
def _no_real_s3(monkeypatch: pytest.MonkeyPatch) -> None:
    def _fail() -> None:
        raise AssertionError("patched_s3 let a call through to real S3.")

    monkeypatch.setattr("data_hub_shared.s3_utils.get_s3_client", _fail)


def test_local_raw_file_downloads_from_the_mirror_without_network(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mirror = tmp_path / "mirror"
    staged = mirror / _RAW_BUCKET / "inst" / "run" / "plate.csv"
    staged.parent.mkdir(parents=True)
    staged.write_bytes(b"a,b\n1,2\n")
    # The CLI points the mount at the mirror; small files still download.
    monkeypatch.setattr(config, "RAW_DATA_MOUNT_PATH", str(mirror / _RAW_BUCKET))
    dest = tmp_path / "dest"

    with (
        patched_s3(mirror),
        raw_access.local_raw_file(f"s3://{_RAW_BUCKET}/inst/run/plate.csv", dest) as path,
    ):
        assert path == dest / "plate.csv"
        assert path.read_bytes() == b"a,b\n1,2\n"

    assert not path.exists()
    assert staged.exists()


def test_size_lookup_names_the_missing_mirror_path(tmp_path: Path) -> None:
    with (
        patched_s3(tmp_path),
        pytest.raises(FileNotFoundError, match="No file staged at"),
        raw_access.local_raw_file(f"s3://{_RAW_BUCKET}/inst/run/missing.csv", tmp_path / "dest"),
    ):
        pass
