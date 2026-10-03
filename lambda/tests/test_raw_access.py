"""Tests for reading a raw object from the mount or from a download."""

from __future__ import annotations
import json
from pathlib import Path
from typing import Any

import pytest

from data_hub_lambda import raw_access
from data_hub_lambda.config import lambda_config
from data_hub_lambda.deadline import ProcessingDeadlineError, set_deadline_from_remaining_ms
from data_hub_lambda.raw_access import OUTPUT_HEADROOM_BYTES, ObjectTooLargeForDiskError
from data_hub_shared.s3_utils import parse_s3_uri

_GIB = 1024**3
_ROOMY = 10 * _GIB


class _Usage:
    def __init__(self, free: int) -> None:
        self.free = free


class _Clock:
    def __init__(self) -> None:
        self.now = 0.0
        self.on_sleep: Any = lambda: None

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds
        self.on_sleep()


@pytest.fixture(autouse=True)
def _no_mount_from_the_shell(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RAW_DATA_MOUNT_PATH", raising=False)
    monkeypatch.delenv("DATA_HUB_ENVIRONMENT", raising=False)
    lambda_config.__init__()  # type: ignore[misc]


def _patch_disk(monkeypatch: pytest.MonkeyPatch, free: int) -> None:
    monkeypatch.setattr(raw_access.shutil, "disk_usage", lambda _path: _Usage(free))


def _patch_size(monkeypatch: pytest.MonkeyPatch, size: int) -> None:
    monkeypatch.setattr(raw_access.s3_utils, "object_content_length", lambda _uri, **_k: size)


def _mount_at(monkeypatch: pytest.MonkeyPatch, mount: Path) -> None:
    monkeypatch.setenv("RAW_DATA_MOUNT_PATH", str(mount))
    lambda_config.__init__()  # type: ignore[misc]


def _sparse_file(path: Path, size: int) -> Path:
    """A file that reports *size* bytes without using the disk."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as handle:
        handle.truncate(size)
    return path


def _record_downloads(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, Path]]:
    downloads: list[tuple[str, Path]] = []

    def _download(uri: str, local_path: Path, **_k: Any) -> None:
        local_path.parent.mkdir(parents=True, exist_ok=True)
        local_path.write_bytes(b"copy")
        downloads.append((uri, local_path))

    monkeypatch.setattr(raw_access.s3_utils, "download_file", _download)
    return downloads


def _no_wait(*_a: Any, **_k: Any) -> None:
    raise AssertionError("the helper should not wait for the mount")


def test_small_file_is_downloaded_and_then_deleted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    dest = tmp_path / "dest"
    _patch_disk(monkeypatch, free=_GIB)
    _patch_size(monkeypatch, size=5)
    downloads = _record_downloads(monkeypatch)

    with raw_access.local_raw_file("bucket", "inst/run/file.csv", dest) as path:
        assert path.read_bytes() == b"copy"
        assert downloads == [("s3://bucket/inst/run/file.csv", path)]

    assert path.exists() is False


def test_a_downloaded_file_is_deleted_when_processing_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_disk(monkeypatch, free=_GIB)
    _patch_size(monkeypatch, size=5)
    downloads = _record_downloads(monkeypatch)

    with pytest.raises(RuntimeError, match="parse failed"):
        with raw_access.local_raw_file("bucket", "inst/run/file.csv", tmp_path / "dest"):
            raise RuntimeError("parse failed")

    assert downloads[0][1].exists() is False


def test_streaming_caller_downloads_a_small_file_without_waiting(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mount = tmp_path / "mount"
    _sparse_file(mount / "inst" / "run" / "plate.csv", 5)
    _mount_at(monkeypatch, mount)
    _patch_disk(monkeypatch, free=_ROOMY)
    _patch_size(monkeypatch, size=5)
    downloads = _record_downloads(monkeypatch)
    monkeypatch.setattr(raw_access, "_wait_for_mounted", _no_wait)

    with raw_access.local_raw_file(
        "bucket", "inst/run/plate.csv", tmp_path / "dest", streams=True
    ) as path:
        assert path == tmp_path / "dest" / "plate.csv"

    assert len(downloads) == 1


@pytest.mark.parametrize("filename", ["Sample #1.tif", "what?.tif", "a b+c%20d.tif"])
def test_a_hash_or_question_mark_stays_in_the_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, filename: str
) -> None:
    key = f"inst/run/{filename}"
    _patch_disk(monkeypatch, free=_GIB)
    _patch_size(monkeypatch, size=5)
    downloads = _record_downloads(monkeypatch)

    with raw_access.local_raw_file("bucket", key, tmp_path / "dest") as path:
        assert path.name == filename

    assert parse_s3_uri(downloads[0][0]) == ("bucket", key)


def test_a_hash_in_a_large_file_maps_to_the_mounted_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mount = tmp_path / "mount"
    mounted = _sparse_file(mount / "inst" / "run" / "Sample #1.tif", _GIB)
    _mount_at(monkeypatch, mount)
    _patch_disk(monkeypatch, free=_ROOMY)
    _patch_size(monkeypatch, size=_GIB)

    with raw_access.local_raw_file(
        "bucket", "inst/run/Sample #1.tif", tmp_path / "dest", streams=True
    ) as path:
        assert path == mounted


def test_large_file_is_read_from_the_mount_and_not_deleted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mount = tmp_path / "mount"
    mounted = _sparse_file(mount / "inst" / "run" / "stack.tif", _GIB)
    _mount_at(monkeypatch, mount)

    def _download(*_a: Any, **_k: Any) -> None:
        raise AssertionError("a large file should not be downloaded")

    _patch_disk(monkeypatch, free=_ROOMY)
    _patch_size(monkeypatch, size=_GIB)
    monkeypatch.setattr(raw_access.s3_utils, "download_file", _download)

    with raw_access.local_raw_file(
        "bucket", "inst/run/stack.tif", tmp_path / "dest", streams=True
    ) as path:
        assert path == mounted

    assert mounted.exists()


def test_wait_accepts_a_file_that_shows_up_at_the_right_size(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    mount = tmp_path / "mount"
    mounted = mount / "inst" / "run" / "stack.tif"
    mounted.parent.mkdir(parents=True)
    _mount_at(monkeypatch, mount)
    clock = _Clock()
    sleeps = {"n": 0}

    def _on_sleep() -> None:
        sleeps["n"] += 1
        if sleeps["n"] == 1:
            mounted.write_bytes(b"short")
        else:
            mounted.write_bytes(b"1234")

    clock.on_sleep = _on_sleep
    monkeypatch.setattr(raw_access, "_Clock", lambda: clock)
    # Smaller than 1 GiB, but larger than free disk, so the helper uses the mount.
    _patch_disk(monkeypatch, free=1)
    _patch_size(monkeypatch, size=4)

    def _no_download(*_a: Any, **_k: Any) -> None:
        raise AssertionError("the mounted file should not be downloaded")

    monkeypatch.setattr(raw_access.s3_utils, "download_file", _no_download)

    with raw_access.local_raw_file(
        "bucket", "inst/run/stack.tif", tmp_path / "dest", streams=True
    ) as path:
        assert path == mounted
        assert path.read_bytes() == b"1234"

    assert sleeps["n"] == 2
    assert capsys.readouterr().out == ""
    assert mounted.exists()


def test_timeout_downloads_and_writes_the_metric(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    mount = tmp_path / "mount"
    mount.mkdir()
    monkeypatch.setenv("DATA_HUB_ENVIRONMENT", "staging")
    _mount_at(monkeypatch, mount)
    clock = _Clock()
    monkeypatch.setattr(raw_access, "_Clock", lambda: clock)
    _patch_disk(monkeypatch, free=_ROOMY)
    _patch_size(monkeypatch, size=_GIB)
    downloads = _record_downloads(monkeypatch)

    with raw_access.local_raw_file(
        "bucket", "inst/run/stack.tif", tmp_path / "dest", streams=True
    ) as path:
        assert path.read_bytes() == b"copy"

    assert downloads[0][1].exists() is False
    metric = json.loads(capsys.readouterr().out.strip())
    assert metric["RawMountWaitTimeouts"] == 1
    assert metric["Environment"] == "staging"
    assert metric["_aws"]["CloudWatchMetrics"][0]["Namespace"] == "DataHub"


@pytest.mark.parametrize(
    ("key", "shown"),
    [
        ("inst/run/stack.tif", True),
        (f"inst/{'r' * 255}/stack.tif", True),
        (f"inst/{'r' * 256}/stack.tif", False),
        (f"inst/{'é' * 128}/stack.tif", False),
        ("inst/../stack.tif", False),
        ("inst/./stack.tif", False),
        ("inst//stack.tif", False),
        ("inst/run/st\x00ack.tif", False),
    ],
)
def test_mount_shows_only_keys_s3_files_imports(key: str, shown: bool) -> None:
    assert raw_access._mount_can_show(key) is shown


@pytest.mark.parametrize(
    "key",
    ["inst/../stack.tif", "inst/./stack.tif", "inst//stack.tif", f"inst/{'r' * 256}/stack.tif"],
    ids=["dot-dot", "dot", "empty-part", "long-part"],
)
def test_a_key_the_mount_never_shows_is_downloaded_without_waiting(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], key: str
) -> None:
    mount = tmp_path / "mount"
    mount.mkdir()
    _mount_at(monkeypatch, mount)
    _patch_disk(monkeypatch, free=_ROOMY)
    _patch_size(monkeypatch, size=_GIB)
    monkeypatch.setattr(raw_access, "_wait_for_mounted", _no_wait)
    downloads = _record_downloads(monkeypatch)

    with raw_access.local_raw_file("bucket", key, tmp_path / "dest", streams=True):
        pass

    assert len(downloads) == 1
    assert capsys.readouterr().out == ""


def test_a_key_the_mount_never_shows_and_too_big_for_disk_names_only_the_disk(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mount = tmp_path / "mount"
    mount.mkdir()
    _mount_at(monkeypatch, mount)
    _patch_disk(monkeypatch, free=10)
    _patch_size(monkeypatch, size=_GIB)
    monkeypatch.setattr(raw_access, "_wait_for_mounted", _no_wait)

    with pytest.raises(ObjectTooLargeForDiskError) as exc:
        with raw_access.local_raw_file(
            "bucket", "inst/../stack.tif", tmp_path / "dest", streams=True
        ):
            pass

    assert "mount" not in str(exc.value)


def test_file_too_big_for_mount_and_disk_says_both(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mount = tmp_path / "mount"
    mount.mkdir()
    _mount_at(monkeypatch, mount)
    clock = _Clock()
    monkeypatch.setattr(raw_access, "_Clock", lambda: clock)
    _patch_disk(monkeypatch, free=10)
    _patch_size(monkeypatch, size=_GIB)

    with pytest.raises(ObjectTooLargeForDiskError, match="processing mount") as exc:
        with raw_access.local_raw_file(
            "bucket", "inst/run/stack.tif", tmp_path / "dest", streams=True
        ):
            pass

    assert "disk" in str(exc.value)


def test_download_leaves_headroom_for_outputs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    free = 4 * _GIB
    _patch_disk(monkeypatch, free=free)
    _patch_size(monkeypatch, size=free - OUTPUT_HEADROOM_BYTES + 1)

    with pytest.raises(ObjectTooLargeForDiskError, match=r"larger than the 3\.5 GB of disk"):
        with raw_access.local_raw_file("bucket", "inst/run/file.csv", tmp_path / "dest"):
            pass


def test_a_file_that_fits_only_without_headroom_goes_to_the_mount(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    free = OUTPUT_HEADROOM_BYTES + 100
    mount = tmp_path / "mount"
    mounted = _sparse_file(mount / "inst" / "run" / "stack.tif", 200)
    _mount_at(monkeypatch, mount)
    _patch_disk(monkeypatch, free=free)
    _patch_size(monkeypatch, size=200)

    with raw_access.local_raw_file(
        "bucket", "inst/run/stack.tif", tmp_path / "dest", streams=True
    ) as path:
        assert path == mounted


def test_deadline_stops_a_download(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_disk(monkeypatch, free=_GIB)
    _patch_size(monkeypatch, size=5)
    set_deadline_from_remaining_ms(0)

    with pytest.raises(ProcessingDeadlineError, match="downloading"):
        with raw_access.local_raw_file("bucket", "inst/run/file.csv", tmp_path / "dest"):
            pass


def test_deadline_stops_the_mount_wait(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    mount = tmp_path / "mount"
    mount.mkdir()
    _mount_at(monkeypatch, mount)
    _patch_disk(monkeypatch, free=_ROOMY)
    _patch_size(monkeypatch, size=_GIB)
    set_deadline_from_remaining_ms(0)

    with pytest.raises(ProcessingDeadlineError, match="mounted file"):
        with raw_access.local_raw_file(
            "bucket", "inst/run/stack.tif", tmp_path / "dest", streams=True
        ):
            pass


def test_without_streams_a_large_file_is_downloaded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mount = tmp_path / "mount"
    mounted = _sparse_file(mount / "inst" / "run" / "stack.tif", _GIB)
    _mount_at(monkeypatch, mount)
    _patch_disk(monkeypatch, free=_ROOMY)
    _patch_size(monkeypatch, size=_GIB)
    downloads = _record_downloads(monkeypatch)

    with raw_access.local_raw_file("bucket", "inst/run/stack.tif", tmp_path / "dest") as path:
        assert path != mounted
        assert path.read_bytes() == b"copy"

    assert len(downloads) == 1


def test_without_streams_a_file_too_big_for_disk_names_only_the_disk(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mount = tmp_path / "mount"
    mount.mkdir()
    _mount_at(monkeypatch, mount)
    _patch_disk(monkeypatch, free=10)
    _patch_size(monkeypatch, size=_GIB)

    with pytest.raises(ObjectTooLargeForDiskError, match=r"File is 1\.0 GB, larger than") as exc:
        with raw_access.local_raw_file("bucket", "inst/run/stack.tif", tmp_path / "dest"):
            pass

    assert "mount" not in str(exc.value)


@pytest.mark.parametrize("missing", ["inst/run/stack.tif", "inst/run.tif/stack.tif"])
def test_a_missing_mounted_file_is_not_ready_and_not_logged(
    tmp_path: Path, missing: str, caplog: pytest.LogCaptureFixture
) -> None:
    (tmp_path / "inst").mkdir()
    (tmp_path / "inst" / "run.tif").write_bytes(b"x")

    assert raw_access._matching_size(tmp_path / missing, 1) is False
    assert caplog.records == []


def test_an_unreadable_mounted_file_is_not_ready_and_is_logged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    mounted = tmp_path / "stack.tif"

    def _stat(self: Path, **_k: Any) -> Any:
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(Path, "stat", _stat)

    assert raw_access._matching_size(mounted, 1) is False
    assert "Cannot read mounted file" in caplog.text
    assert "Permission denied" in caplog.text
