"""Unit tests for DishCam `process_file` orchestration."""

from __future__ import annotations
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from data_hub_lambda.api_client import ApiError
from data_hub_lambda.dishcam.parse_metadata import MIN_PLAYBACK_FPS
from data_hub_lambda.models import FileResponse, RunDetailFile, RunDetailResponse, RunResponse


@pytest.fixture(autouse=True)
def _reset_api_client() -> Any:
    import data_hub_lambda.api_client as api_module

    original = api_module._client
    api_module._client = None
    try:
        yield
    finally:
        api_module._client = original


def _file_response(
    file_id: int,
    filename: str,
    status: str = "uploaded",
    category: str = "raw",
    relative_path: str | None = None,
) -> FileResponse:
    return FileResponse(
        id=file_id,
        instrument_run_id="run-uuid",
        filename=filename,
        relative_path=relative_path,
        s3_bucket="raw",
        s3_key=f"dishcam/run-xyz/{filename}",
        category=category,
        status=status,
    )


def _run_file(
    file_id: int,
    filename: str,
    status: str = "uploaded",
    category: str = "raw",
    relative_path: str | None = None,
    *,
    s3_key: str | None = None,
    deleted_at: datetime | None = None,
) -> RunDetailFile:
    if s3_key is None and status != "detected":
        s3_key = f"dishcam/run-xyz/{filename}"
    return RunDetailFile(
        id=file_id,
        filename=filename,
        relative_path=relative_path,
        s3_key=s3_key,
        category=category,
        status=status,
        deleted_at=deleted_at,
    )


def _stub_run(client: MagicMock, *filenames: str) -> None:
    """Flat capture: every name sits in the run root and is already in S3."""
    client.get_run.return_value = RunDetailResponse(
        id="run-uuid",
        instrument_id="dishcam",
        run_id="run-xyz",
        source="watcher",
        files=[_run_file(index, name) for index, name in enumerate(filenames, start=1)],
    )


def _run_response() -> RunResponse:
    return RunResponse(
        id="run-uuid",
        instrument_id="dishcam",
        run_id="run-xyz",
        source="lambda",
        metadata={},
    )


SIDECAR_ID = 99


def _exists_for(*keys: str):
    present = set(keys)

    def _exists(s3_uri: str, **_: Any) -> bool:
        key = s3_uri.split("//", 1)[1].split("/", 1)[1]
        return key in present

    return _exists


def _completed_file_ids(client: MagicMock) -> list[int]:
    return [
        call.args[0]
        for call in client.update_file.call_args_list
        if call.kwargs.get("status") == "completed"
    ]


def _write_download(s3_uri: str, local_path: Path, **_: Any) -> None:
    local_path.parent.mkdir(parents=True, exist_ok=True)
    name = s3_uri.rsplit("/", 1)[-1]
    if name.lower().endswith(".json"):
        local_path.write_text('{"fps": 1.0}')
    else:
        local_path.write_bytes(b"tiff")


def _write_encode(tiff_path: Path, mp4_path: Path, poster_path: Path, fps: float) -> None:
    mp4_path.write_bytes(b"mp4")
    poster_path.write_bytes(b"jpg")


def _status_updates(client: MagicMock, file_id: int) -> list[str]:
    return [
        call.kwargs.get("status")
        for call in client.update_file.call_args_list
        if call.args[0] == file_id and call.kwargs.get("status") is not None
    ]


@contextmanager
def _patched_process(
    tmp_path: Path,
    client: MagicMock,
    *,
    list_objects: list[str] | None = None,
    encode: Any = None,
    download: Any = _write_download,
) -> Iterator[Any]:
    encode_mock = encode if encode is not None else MagicMock(side_effect=_write_encode)
    # Tests that pair by folder set get_run themselves. The rest describe a
    # flat run via the old S3 listing arguments.
    if not isinstance(client.get_run.return_value, RunDetailResponse):
        names = [uri.rsplit("/", 1)[-1] for uri in (list_objects or [])]
        json_names = [
            name
            for name in names
            if name.lower().startswith("run") and name.lower().endswith(".json")
        ]
        if not json_names:
            names = ["run.json", *names]
        _stub_run(client, *names)
    with (
        patch(
            "data_hub_lambda.dishcam.process_file.get_client",
            return_value=client,
        ),
        patch(
            "data_hub_lambda.dishcam.process_file.s3_utils.object_exists",
            return_value=True,
        ),
        patch(
            "data_hub_lambda.dishcam.process_file.s3_utils.list_objects",
            return_value=list_objects or [],
        ),
        patch(
            "data_hub_lambda.dishcam.process_file.s3_utils.download_file",
            side_effect=download,
        ),
        patch("data_hub_lambda.dishcam.process_file.s3_utils.upload_file"),
        patch(
            "data_hub_lambda.dishcam.process_file.encode_tiff_stack",
            encode_mock,
        ),
        patch(
            "data_hub_shared.config.config.AWS_S3_RAW_DATA_BUCKET",
            "raw",
        ),
        patch(
            "data_hub_shared.config.config.AWS_S3_PROCESSED_DATA_BUCKET",
            "processed",
        ),
        patch(
            "data_hub_shared.config.config.LOCAL_RAW_DATA_DIRPATH",
            tmp_path,
        ),
    ):
        from data_hub_lambda.dishcam.process_file import process_file

        yield process_file, encode_mock


class TestProcessFileSkipUntilBothPresent:
    def test_tiff_without_json_does_not_ensure_run_or_download(self) -> None:
        client = MagicMock()
        _stub_run(client, "stack.tif")
        client.create_file.return_value = _file_response(1, "stack.tif")

        with (
            patch(
                "data_hub_lambda.dishcam.process_file.get_client",
                return_value=client,
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.object_exists",
                side_effect=_exists_for("dishcam/run-xyz/stack.tif"),
            ),
            patch("data_hub_lambda.dishcam.process_file.s3_utils.download_file") as download,
        ):
            from data_hub_lambda.dishcam.process_file import process_file

            process_file("dishcam", "run-xyz", "stack.tif")

        client.ensure_run.assert_not_called()
        download.assert_not_called()
        client.update_file.assert_not_called()

    def test_json_without_tiff_does_not_encode(self) -> None:
        client = MagicMock()
        _stub_run(client, "run.json")
        client.create_file.return_value = _file_response(2, "run.json")

        with (
            patch(
                "data_hub_lambda.dishcam.process_file.get_client",
                return_value=client,
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.object_exists",
                side_effect=_exists_for("dishcam/run-xyz/run.json"),
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.list_objects",
                return_value=[],
            ),
            patch("data_hub_lambda.dishcam.process_file.encode_tiff_stack") as encode,
        ):
            from data_hub_lambda.dishcam.process_file import process_file

            process_file("dishcam", "run-xyz", "run.json")

        encode.assert_not_called()
        client.ensure_run.assert_not_called()

    def test_reprocess_fails_when_sibling_missing(self) -> None:
        client = MagicMock()
        _stub_run(client, "stack.tif")
        client.create_file.return_value = _file_response(3, "stack.tif", status="processing")

        with (
            patch(
                "data_hub_lambda.dishcam.process_file.get_client",
                return_value=client,
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.object_exists",
                side_effect=_exists_for("dishcam/run-xyz/stack.tif"),
            ),
        ):
            from data_hub_lambda.dishcam.process_file import process_file

            process_file("dishcam", "run-xyz", "stack.tif")

        client.update_file.assert_called_once_with(
            3,
            status="failed",
            error_message="Cannot process: no uploaded run.json for this stack's folder",
        )

    def test_missing_run_on_skip_is_not_an_error(self) -> None:
        client = MagicMock()
        client.get_run.side_effect = ApiError("not found", status_code=404)
        client.create_file.side_effect = ApiError("not found", status_code=404)

        with (
            patch(
                "data_hub_lambda.dishcam.process_file.get_client",
                return_value=client,
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.object_exists",
                return_value=False,
            ),
        ):
            from data_hub_lambda.dishcam.process_file import process_file

            process_file("dishcam", "run-xyz", "stack.tif")

        client.update_file.assert_not_called()

    def test_missing_run_uses_the_s3_prefix(self, tmp_path: Path) -> None:
        client = MagicMock()
        client.get_run.side_effect = ApiError("not found", status_code=404)
        client.ensure_run.return_value = _run_response()
        client.create_file.side_effect = [
            _file_response(SIDECAR_ID, "run.json"),
            _file_response(10, "stack.tif"),
            _file_response(11, "stack.mp4", category="processed"),
            _file_response(12, "stack.jpg", category="processed"),
        ]

        with _patched_process(
            tmp_path,
            client,
            list_objects=["s3://raw/dishcam/run-xyz/stack.tif"],
        ) as (process_file, encode):
            process_file("dishcam", "run-xyz", "run.json")

        client.ensure_run.assert_called_once_with("dishcam", "run-xyz")
        assert [call.args[0].name for call in encode.call_args_list] == ["stack.tif"]


class TestProcessFileEncodesWhenBothPresent:
    def test_run_json_trigger_encodes_sibling_tiff(self, tmp_path: Path) -> None:
        client = MagicMock()
        _stub_run(client, "run.json", "stack.tif")
        client.ensure_run.return_value = _run_response()
        client.create_file.side_effect = [
            _file_response(SIDECAR_ID, "run.json"),
            _file_response(10, "stack.tif"),
            _file_response(11, "stack.mp4", category="processed"),
            _file_response(12, "stack.jpg", category="processed"),
        ]

        tiff = tmp_path / "stack.tif"
        sidecar = tmp_path / "run.json"
        tiff.write_bytes(b"tiff")
        sidecar.write_text("{}")
        mp4 = tmp_path / "stack.mp4"
        poster = tmp_path / "stack.jpg"
        mp4.write_bytes(b"mp4")
        poster.write_bytes(b"jpg")

        def _download(s3_uri: str, local_path: Path, **_: Any) -> None:
            local_path.parent.mkdir(parents=True, exist_ok=True)
            if s3_uri.endswith("run.json"):
                local_path.write_text(
                    '{"fps": 1.0, "measured_fps": 0.9, "frames": 4, "quality": "High"}'
                )
            else:
                local_path.write_bytes(b"tiff")

        def _encode(tiff_path: Path, mp4_path: Path, poster_path: Path, fps: float) -> None:
            assert fps == MIN_PLAYBACK_FPS
            mp4_path.write_bytes(b"mp4")
            poster_path.write_bytes(b"jpg")

        with (
            patch(
                "data_hub_lambda.dishcam.process_file.get_client",
                return_value=client,
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.object_exists",
                return_value=True,
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.list_objects",
                return_value=["s3://raw/dishcam/run-xyz/stack.tif"],
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.download_file",
                side_effect=_download,
            ),
            patch("data_hub_lambda.dishcam.process_file.s3_utils.upload_file"),
            patch(
                "data_hub_lambda.dishcam.process_file.encode_tiff_stack",
                side_effect=_encode,
            ),
            patch(
                "data_hub_shared.config.config.AWS_S3_RAW_DATA_BUCKET",
                "raw",
            ),
            patch(
                "data_hub_shared.config.config.AWS_S3_PROCESSED_DATA_BUCKET",
                "processed",
            ),
            patch(
                "data_hub_shared.config.config.LOCAL_RAW_DATA_DIRPATH",
                tmp_path,
            ),
        ):
            from data_hub_lambda.dishcam.process_file import process_file

            process_file("dishcam", "run-xyz", "run.json")

        client.ensure_run.assert_called_once_with("dishcam", "run-xyz")
        client.update_run.assert_called_once()
        metadata = client.update_run.call_args.kwargs["metadata"]
        assert metadata["measured_fps"] == 0.9
        assert metadata["frames"] == 4
        assert _completed_file_ids(client) == [10, SIDECAR_ID]

    def test_processing_sidecar_is_completed_after_encode(self, tmp_path: Path) -> None:
        client = MagicMock()
        _stub_run(client, "run.json", "stack.tif")
        client.ensure_run.return_value = _run_response()
        client.create_file.side_effect = [
            _file_response(SIDECAR_ID, "run.json", status="processing"),
            _file_response(10, "stack.tif"),
            _file_response(11, "stack.mp4", category="processed"),
            _file_response(12, "stack.jpg", category="processed"),
        ]

        def _download(s3_uri: str, local_path: Path, **_: Any) -> None:
            local_path.parent.mkdir(parents=True, exist_ok=True)
            if s3_uri.endswith("run.json"):
                local_path.write_text('{"fps": 1.0}')
            else:
                local_path.write_bytes(b"tiff")

        def _encode(tiff_path: Path, mp4_path: Path, poster_path: Path, fps: float) -> None:
            mp4_path.write_bytes(b"mp4")
            poster_path.write_bytes(b"jpg")

        with (
            patch(
                "data_hub_lambda.dishcam.process_file.get_client",
                return_value=client,
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.object_exists",
                return_value=True,
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.list_objects",
                return_value=["s3://raw/dishcam/run-xyz/stack.tif"],
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.download_file",
                side_effect=_download,
            ),
            patch("data_hub_lambda.dishcam.process_file.s3_utils.upload_file"),
            patch(
                "data_hub_lambda.dishcam.process_file.encode_tiff_stack",
                side_effect=_encode,
            ),
            patch(
                "data_hub_shared.config.config.AWS_S3_RAW_DATA_BUCKET",
                "raw",
            ),
            patch(
                "data_hub_shared.config.config.AWS_S3_PROCESSED_DATA_BUCKET",
                "processed",
            ),
            patch(
                "data_hub_shared.config.config.LOCAL_RAW_DATA_DIRPATH",
                tmp_path,
            ),
        ):
            from data_hub_lambda.dishcam.process_file import process_file

            process_file("dishcam", "run-xyz", "run.json")

        sidecar_statuses = [
            call.kwargs.get("status")
            for call in client.update_file.call_args_list
            if call.args[0] == SIDECAR_ID and call.kwargs.get("status") is not None
        ]
        assert sidecar_statuses == ["completed"]
        assert _completed_file_ids(client) == [10, SIDECAR_ID]

    def test_completed_conflict_is_not_a_failure(self, tmp_path: Path) -> None:
        client = MagicMock()
        _stub_run(client, "run.json", "stack.tif")
        client.ensure_run.return_value = _run_response()
        client.create_file.side_effect = [
            _file_response(SIDECAR_ID, "run.json"),
            _file_response(10, "stack.tif"),
            _file_response(11, "stack.mp4", category="processed"),
            _file_response(12, "stack.jpg", category="processed"),
        ]
        client.update_file.side_effect = [
            _file_response(SIDECAR_ID, "run.json", status="processing"),
            _file_response(10, "stack.tif", status="processing"),
            _file_response(11, "stack.mp4", category="processed"),
            _file_response(12, "stack.jpg", category="processed"),
            ApiError("conflict", status_code=409),
            _file_response(SIDECAR_ID, "run.json", status="completed"),
        ]

        def _download(s3_uri: str, local_path: Path, **_: Any) -> None:
            local_path.parent.mkdir(parents=True, exist_ok=True)
            if s3_uri.endswith("run.json"):
                local_path.write_text('{"fps": 1.0}')
            else:
                local_path.write_bytes(b"tiff")

        def _encode(tiff_path: Path, mp4_path: Path, poster_path: Path, fps: float) -> None:
            mp4_path.write_bytes(b"mp4")
            poster_path.write_bytes(b"jpg")

        with (
            patch(
                "data_hub_lambda.dishcam.process_file.get_client",
                return_value=client,
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.object_exists",
                return_value=True,
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.list_objects",
                return_value=["s3://raw/dishcam/run-xyz/stack.tif"],
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.download_file",
                side_effect=_download,
            ),
            patch("data_hub_lambda.dishcam.process_file.s3_utils.upload_file"),
            patch(
                "data_hub_lambda.dishcam.process_file.encode_tiff_stack",
                side_effect=_encode,
            ),
            patch(
                "data_hub_shared.config.config.AWS_S3_RAW_DATA_BUCKET",
                "raw",
            ),
            patch(
                "data_hub_shared.config.config.AWS_S3_PROCESSED_DATA_BUCKET",
                "processed",
            ),
            patch(
                "data_hub_shared.config.config.LOCAL_RAW_DATA_DIRPATH",
                tmp_path,
            ),
        ):
            from data_hub_lambda.dishcam.process_file import process_file

            process_file("dishcam", "run-xyz", "stack.tif")

        failed = [
            call
            for call in client.update_file.call_args_list
            if call.kwargs.get("status") == "failed"
        ]
        assert failed == []

    def test_run_json_trigger_encodes_every_tiff(self, tmp_path: Path) -> None:
        client = MagicMock()
        _stub_run(client, "run.json", "empty.tif", "ruler.tif")
        client.ensure_run.return_value = _run_response()
        client.create_file.side_effect = [
            _file_response(SIDECAR_ID, "run.json"),
            _file_response(10, "empty.tif"),
            _file_response(11, "empty.mp4", category="processed"),
            _file_response(12, "empty.jpg", category="processed"),
            _file_response(20, "ruler.tif"),
            _file_response(21, "ruler.mp4", category="processed"),
            _file_response(22, "ruler.jpg", category="processed"),
        ]

        def _download(s3_uri: str, local_path: Path, **_: Any) -> None:
            local_path.parent.mkdir(parents=True, exist_ok=True)
            if s3_uri.endswith("run.json"):
                local_path.write_text('{"fps": 1.0}')
            else:
                local_path.write_bytes(b"tiff")

        def _encode(tiff_path: Path, mp4_path: Path, poster_path: Path, fps: float) -> None:
            mp4_path.write_bytes(b"mp4")
            poster_path.write_bytes(b"jpg")

        encode = MagicMock(side_effect=_encode)

        with (
            patch(
                "data_hub_lambda.dishcam.process_file.get_client",
                return_value=client,
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.object_exists",
                return_value=True,
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.list_objects",
                return_value=[
                    "s3://raw/dishcam/run-xyz/empty.tif",
                    "s3://raw/dishcam/run-xyz/ruler.tif",
                    "s3://raw/dishcam/run-xyz/run.json",
                ],
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.download_file",
                side_effect=_download,
            ),
            patch("data_hub_lambda.dishcam.process_file.s3_utils.upload_file"),
            patch(
                "data_hub_lambda.dishcam.process_file.encode_tiff_stack",
                encode,
            ),
            patch(
                "data_hub_shared.config.config.AWS_S3_RAW_DATA_BUCKET",
                "raw",
            ),
            patch(
                "data_hub_shared.config.config.AWS_S3_PROCESSED_DATA_BUCKET",
                "processed",
            ),
            patch(
                "data_hub_shared.config.config.LOCAL_RAW_DATA_DIRPATH",
                tmp_path,
            ),
        ):
            from data_hub_lambda.dishcam.process_file import process_file

            process_file("dishcam", "run-xyz", "run.json")

        encoded = [call.args[0].name for call in encode.call_args_list]
        assert encoded == ["empty.tif", "ruler.tif"]
        assert _completed_file_ids(client) == [10, 20, SIDECAR_ID]

    def test_tiff_trigger_encodes_only_that_stack(self, tmp_path: Path) -> None:
        client = MagicMock()
        _stub_run(client, "run.json", "empty.tif", "ruler.tif")
        client.ensure_run.return_value = _run_response()
        client.create_file.side_effect = [
            _file_response(SIDECAR_ID, "run.json"),
            _file_response(20, "ruler.tif"),
            _file_response(21, "ruler.mp4", category="processed"),
            _file_response(22, "ruler.jpg", category="processed"),
        ]

        def _download(s3_uri: str, local_path: Path, **_: Any) -> None:
            local_path.parent.mkdir(parents=True, exist_ok=True)
            if s3_uri.endswith("run.json"):
                local_path.write_text('{"fps": 1.0}')
            else:
                local_path.write_bytes(b"tiff")

        def _encode(tiff_path: Path, mp4_path: Path, poster_path: Path, fps: float) -> None:
            mp4_path.write_bytes(b"mp4")
            poster_path.write_bytes(b"jpg")

        encode = MagicMock(side_effect=_encode)
        list_objects = MagicMock(
            return_value=[
                "s3://raw/dishcam/run-xyz/empty.tif",
                "s3://raw/dishcam/run-xyz/ruler.tif",
            ]
        )

        with (
            patch(
                "data_hub_lambda.dishcam.process_file.get_client",
                return_value=client,
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.object_exists",
                return_value=True,
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.list_objects",
                list_objects,
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.download_file",
                side_effect=_download,
            ),
            patch("data_hub_lambda.dishcam.process_file.s3_utils.upload_file"),
            patch(
                "data_hub_lambda.dishcam.process_file.encode_tiff_stack",
                encode,
            ),
            patch(
                "data_hub_shared.config.config.AWS_S3_RAW_DATA_BUCKET",
                "raw",
            ),
            patch(
                "data_hub_shared.config.config.AWS_S3_PROCESSED_DATA_BUCKET",
                "processed",
            ),
            patch(
                "data_hub_shared.config.config.LOCAL_RAW_DATA_DIRPATH",
                tmp_path,
            ),
        ):
            from data_hub_lambda.dishcam.process_file import process_file

            process_file("dishcam", "run-xyz", "ruler.tif")

        list_objects.assert_not_called()
        assert [call.args[0].name for call in encode.call_args_list] == ["ruler.tif"]
        assert _completed_file_ids(client) == [20, SIDECAR_ID]

    def test_one_failed_stack_does_not_block_the_others(self, tmp_path: Path) -> None:
        client = MagicMock()
        _stub_run(client, "run.json", "empty.tif", "ruler.tif")
        client.ensure_run.return_value = _run_response()
        client.create_file.side_effect = [
            _file_response(SIDECAR_ID, "run.json"),
            _file_response(10, "empty.tif"),
            _file_response(20, "ruler.tif"),
            _file_response(21, "ruler.mp4", category="processed"),
            _file_response(22, "ruler.jpg", category="processed"),
        ]

        def _download(s3_uri: str, local_path: Path, **_: Any) -> None:
            local_path.parent.mkdir(parents=True, exist_ok=True)
            if s3_uri.endswith("run.json"):
                local_path.write_text('{"fps": 1.0}')
            else:
                local_path.write_bytes(b"tiff")

        def _encode(tiff_path: Path, mp4_path: Path, poster_path: Path, fps: float) -> None:
            if tiff_path.name == "empty.tif":
                raise RuntimeError("empty stack is corrupt")
            mp4_path.write_bytes(b"mp4")
            poster_path.write_bytes(b"jpg")

        with (
            patch(
                "data_hub_lambda.dishcam.process_file.get_client",
                return_value=client,
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.object_exists",
                return_value=True,
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.list_objects",
                return_value=[
                    "s3://raw/dishcam/run-xyz/empty.tif",
                    "s3://raw/dishcam/run-xyz/ruler.tif",
                ],
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.download_file",
                side_effect=_download,
            ),
            patch("data_hub_lambda.dishcam.process_file.s3_utils.upload_file"),
            patch(
                "data_hub_lambda.dishcam.process_file.encode_tiff_stack",
                side_effect=_encode,
            ),
            patch(
                "data_hub_shared.config.config.AWS_S3_RAW_DATA_BUCKET",
                "raw",
            ),
            patch(
                "data_hub_shared.config.config.AWS_S3_PROCESSED_DATA_BUCKET",
                "processed",
            ),
            patch(
                "data_hub_shared.config.config.LOCAL_RAW_DATA_DIRPATH",
                tmp_path,
            ),
        ):
            from data_hub_lambda.dishcam.process_file import process_file

            with pytest.raises(RuntimeError, match="corrupt"):
                process_file("dishcam", "run-xyz", "run.json")

        statuses = {
            call.args[0]: call.kwargs.get("status")
            for call in client.update_file.call_args_list
            if call.kwargs.get("status") in {"completed", "failed"}
        }
        assert statuses[10] == "failed"
        assert statuses[20] == "completed"
        assert statuses[SIDECAR_ID] == "completed"
        client.update_run.assert_called_once()

    def test_run_json_skips_completed_and_in_flight_stacks(self, tmp_path: Path) -> None:
        client = MagicMock()
        _stub_run(client, "run.json", "empty.tif", "ruler.tif", "gk.tif")
        client.ensure_run.return_value = _run_response()
        records = {
            "run.json": _file_response(SIDECAR_ID, "run.json"),
            "empty.tif": _file_response(10, "empty.tif", status="completed"),
            "ruler.tif": _file_response(20, "ruler.tif", status="processing"),
            "gk.tif": _file_response(30, "gk.tif"),
            "gk.mp4": _file_response(31, "gk.mp4", category="processed"),
            "gk.jpg": _file_response(32, "gk.jpg", category="processed"),
        }
        client.create_file.side_effect = lambda **kwargs: records[kwargs["filename"]]

        encode = MagicMock(side_effect=_write_encode)

        with (
            patch(
                "data_hub_lambda.dishcam.process_file.get_client",
                return_value=client,
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.object_exists",
                return_value=True,
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.list_objects",
                return_value=[
                    "s3://raw/dishcam/run-xyz/empty.tif",
                    "s3://raw/dishcam/run-xyz/gk.tif",
                    "s3://raw/dishcam/run-xyz/ruler.tif",
                ],
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.download_file",
                side_effect=_write_download,
            ),
            patch("data_hub_lambda.dishcam.process_file.s3_utils.upload_file"),
            patch(
                "data_hub_lambda.dishcam.process_file.encode_tiff_stack",
                encode,
            ),
            patch(
                "data_hub_shared.config.config.AWS_S3_RAW_DATA_BUCKET",
                "raw",
            ),
            patch(
                "data_hub_shared.config.config.AWS_S3_PROCESSED_DATA_BUCKET",
                "processed",
            ),
            patch(
                "data_hub_shared.config.config.LOCAL_RAW_DATA_DIRPATH",
                tmp_path,
            ),
        ):
            from data_hub_lambda.dishcam.process_file import process_file

            process_file("dishcam", "run-xyz", "run.json")

        assert [call.args[0].name for call in encode.call_args_list] == ["gk.tif"]
        assert _status_updates(client, 10) == []
        assert _status_updates(client, 20) == []
        assert _completed_file_ids(client) == [30, SIDECAR_ID]

    def test_run_json_completes_sidecar_when_every_stack_is_already_done(
        self, tmp_path: Path
    ) -> None:
        client = MagicMock()
        _stub_run(client, "run.json", "empty.tif")
        client.ensure_run.return_value = _run_response()
        records = {
            "run.json": _file_response(SIDECAR_ID, "run.json", status="processing"),
            "empty.tif": _file_response(10, "empty.tif", status="completed"),
        }
        client.create_file.side_effect = lambda **kwargs: records[kwargs["filename"]]

        encode = MagicMock(side_effect=_write_encode)

        with (
            patch(
                "data_hub_lambda.dishcam.process_file.get_client",
                return_value=client,
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.object_exists",
                return_value=True,
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.list_objects",
                return_value=["s3://raw/dishcam/run-xyz/empty.tif"],
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.download_file",
                side_effect=_write_download,
            ),
            patch("data_hub_lambda.dishcam.process_file.s3_utils.upload_file"),
            patch(
                "data_hub_lambda.dishcam.process_file.encode_tiff_stack",
                encode,
            ),
            patch(
                "data_hub_shared.config.config.AWS_S3_RAW_DATA_BUCKET",
                "raw",
            ),
            patch(
                "data_hub_shared.config.config.AWS_S3_PROCESSED_DATA_BUCKET",
                "processed",
            ),
            patch(
                "data_hub_shared.config.config.LOCAL_RAW_DATA_DIRPATH",
                tmp_path,
            ),
        ):
            from data_hub_lambda.dishcam.process_file import process_file

            process_file("dishcam", "run-xyz", "run.json")

        encode.assert_not_called()
        client.update_run.assert_called_once()
        assert client.update_run.call_args.kwargs["metadata"] == {"fps": 1.0}
        assert _completed_file_ids(client) == [SIDECAR_ID]

    def test_tiff_trigger_encodes_even_if_already_completed(self, tmp_path: Path) -> None:
        client = MagicMock()
        _stub_run(client, "run.json", "ruler.tif")
        client.ensure_run.return_value = _run_response()
        client.create_file.side_effect = [
            _file_response(SIDECAR_ID, "run.json", status="completed"),
            _file_response(20, "ruler.tif", status="completed"),
            _file_response(21, "ruler.mp4", category="processed"),
            _file_response(22, "ruler.jpg", category="processed"),
        ]

        encode = MagicMock(side_effect=_write_encode)

        with (
            patch(
                "data_hub_lambda.dishcam.process_file.get_client",
                return_value=client,
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.object_exists",
                return_value=True,
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.download_file",
                side_effect=_write_download,
            ),
            patch("data_hub_lambda.dishcam.process_file.s3_utils.upload_file"),
            patch(
                "data_hub_lambda.dishcam.process_file.encode_tiff_stack",
                encode,
            ),
            patch(
                "data_hub_shared.config.config.AWS_S3_RAW_DATA_BUCKET",
                "raw",
            ),
            patch(
                "data_hub_shared.config.config.AWS_S3_PROCESSED_DATA_BUCKET",
                "processed",
            ),
            patch(
                "data_hub_shared.config.config.LOCAL_RAW_DATA_DIRPATH",
                tmp_path,
            ),
        ):
            from data_hub_lambda.dishcam.process_file import process_file

            process_file("dishcam", "run-xyz", "ruler.tif")

        assert [call.args[0].name for call in encode.call_args_list] == ["ruler.tif"]
        assert "processing" in _status_updates(client, 20)
        assert 20 in _completed_file_ids(client)

    def test_local_stack_files_are_removed_after_each_encode(self, tmp_path: Path) -> None:
        client = MagicMock()
        _stub_run(client, "run.json", "empty.tif", "ruler.tif")
        client.ensure_run.return_value = _run_response()
        client.create_file.side_effect = [
            _file_response(SIDECAR_ID, "run.json"),
            _file_response(10, "empty.tif"),
            _file_response(11, "empty.mp4", category="processed"),
            _file_response(12, "empty.jpg", category="processed"),
            _file_response(20, "ruler.tif"),
            _file_response(21, "ruler.mp4", category="processed"),
            _file_response(22, "ruler.jpg", category="processed"),
        ]

        tiffs_on_disk: list[list[str]] = []

        def _encode(tiff_path: Path, mp4_path: Path, poster_path: Path, fps: float) -> None:
            tiffs_on_disk.append(sorted(path.name for path in tiff_path.parent.glob("*.tif")))
            _write_encode(tiff_path, mp4_path, poster_path, fps)

        with (
            patch(
                "data_hub_lambda.dishcam.process_file.get_client",
                return_value=client,
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.object_exists",
                return_value=True,
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.list_objects",
                return_value=[
                    "s3://raw/dishcam/run-xyz/empty.tif",
                    "s3://raw/dishcam/run-xyz/ruler.tif",
                ],
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.download_file",
                side_effect=_write_download,
            ),
            patch("data_hub_lambda.dishcam.process_file.s3_utils.upload_file"),
            patch(
                "data_hub_lambda.dishcam.process_file.encode_tiff_stack",
                side_effect=_encode,
            ),
            patch(
                "data_hub_shared.config.config.AWS_S3_RAW_DATA_BUCKET",
                "raw",
            ),
            patch(
                "data_hub_shared.config.config.AWS_S3_PROCESSED_DATA_BUCKET",
                "processed",
            ),
            patch(
                "data_hub_shared.config.config.LOCAL_RAW_DATA_DIRPATH",
                tmp_path,
            ),
        ):
            from data_hub_lambda.dishcam.process_file import process_file

            process_file("dishcam", "run-xyz", "run.json")

        assert tiffs_on_disk == [["empty.tif"], ["ruler.tif"]]
        leftover = list((tmp_path / "dishcam" / "run-xyz").glob("*.tif"))
        leftover += list((tmp_path / "dishcam" / "run-xyz").glob("*.mp4"))
        leftover += list((tmp_path / "dishcam" / "run-xyz").glob("*.jpg"))
        assert leftover == []

    def test_failed_encode_still_removes_local_files(self, tmp_path: Path) -> None:
        client = MagicMock()
        _stub_run(client, "run.json", "empty.tif", "ruler.tif")
        client.ensure_run.return_value = _run_response()
        client.create_file.side_effect = [
            _file_response(SIDECAR_ID, "run.json"),
            _file_response(10, "empty.tif"),
            _file_response(20, "ruler.tif"),
            _file_response(21, "ruler.mp4", category="processed"),
            _file_response(22, "ruler.jpg", category="processed"),
        ]

        tiffs_on_disk: list[list[str]] = []

        def _encode(tiff_path: Path, mp4_path: Path, poster_path: Path, fps: float) -> None:
            tiffs_on_disk.append(sorted(path.name for path in tiff_path.parent.glob("*.tif")))
            if tiff_path.name == "empty.tif":
                raise RuntimeError("empty stack is corrupt")
            _write_encode(tiff_path, mp4_path, poster_path, fps)

        with (
            patch(
                "data_hub_lambda.dishcam.process_file.get_client",
                return_value=client,
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.object_exists",
                return_value=True,
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.list_objects",
                return_value=[
                    "s3://raw/dishcam/run-xyz/empty.tif",
                    "s3://raw/dishcam/run-xyz/ruler.tif",
                ],
            ),
            patch(
                "data_hub_lambda.dishcam.process_file.s3_utils.download_file",
                side_effect=_write_download,
            ),
            patch("data_hub_lambda.dishcam.process_file.s3_utils.upload_file"),
            patch(
                "data_hub_lambda.dishcam.process_file.encode_tiff_stack",
                side_effect=_encode,
            ),
            patch(
                "data_hub_shared.config.config.AWS_S3_RAW_DATA_BUCKET",
                "raw",
            ),
            patch(
                "data_hub_shared.config.config.AWS_S3_PROCESSED_DATA_BUCKET",
                "processed",
            ),
            patch(
                "data_hub_shared.config.config.LOCAL_RAW_DATA_DIRPATH",
                tmp_path,
            ),
        ):
            from data_hub_lambda.dishcam.process_file import process_file

            with pytest.raises(RuntimeError, match="corrupt"):
                process_file("dishcam", "run-xyz", "run.json")

        assert tiffs_on_disk == [["empty.tif"], ["ruler.tif"]]

    @pytest.mark.parametrize(
        ("tiff_status", "sidecar_status", "tiff_expected", "sidecar_expected"),
        [
            ("uploaded", "uploaded", ["processing", "failed"], ["processing", "failed"]),
            ("processing", "processing", ["failed"], ["failed"]),
        ],
    )
    def test_unreadable_run_json_fails_sidecar_and_stacks(
        self,
        tmp_path: Path,
        tiff_status: str,
        sidecar_status: str,
        tiff_expected: list[str],
        sidecar_expected: list[str],
    ) -> None:
        client = MagicMock()
        client.ensure_run.return_value = _run_response()
        client.create_file.side_effect = [
            _file_response(10, "stack.tif", status=tiff_status),
            _file_response(SIDECAR_ID, "run.json", status=sidecar_status),
        ]

        def _download(s3_uri: str, local_path: Path, **_: Any) -> None:
            local_path.parent.mkdir(parents=True, exist_ok=True)
            local_path.write_text("not json")

        with _patched_process(
            tmp_path,
            client,
            list_objects=["s3://raw/dishcam/run-xyz/stack.tif"],
            download=_download,
        ) as (process_file, encode):
            with pytest.raises(ValueError, match="Invalid run.json"):
                process_file("dishcam", "run-xyz", "run.json")

        encode.assert_not_called()
        assert _status_updates(client, 10) == tiff_expected
        assert _status_updates(client, SIDECAR_ID) == sidecar_expected

    def test_sidecar_complete_error_does_not_hide_encode_error(self, tmp_path: Path) -> None:
        client = MagicMock()
        client.ensure_run.return_value = _run_response()
        client.create_file.side_effect = [
            _file_response(SIDECAR_ID, "run.json"),
            _file_response(10, "empty.tif"),
        ]

        def _update(file_id: int, **kwargs: Any) -> FileResponse:
            if file_id == SIDECAR_ID and kwargs.get("status") == "completed":
                raise ApiError("sidecar complete failed", status_code=500)
            return _file_response(file_id, "x", status=kwargs.get("status", "uploaded"))

        client.update_file.side_effect = _update

        def _encode(tiff_path: Path, mp4_path: Path, poster_path: Path, fps: float) -> None:
            raise RuntimeError("empty stack is corrupt")

        with _patched_process(
            tmp_path,
            client,
            list_objects=["s3://raw/dishcam/run-xyz/empty.tif"],
            encode=MagicMock(side_effect=_encode),
        ) as (process_file, _encode_mock):
            with pytest.raises(RuntimeError, match="corrupt"):
                process_file("dishcam", "run-xyz", "run.json")

        client.update_run.assert_called_once()

    def test_sidecar_complete_error_is_raised_when_encode_succeeds(self, tmp_path: Path) -> None:
        client = MagicMock()
        _stub_run(client, "run.json", "stack.tif")
        client.ensure_run.return_value = _run_response()
        client.create_file.side_effect = [
            _file_response(SIDECAR_ID, "run.json"),
            _file_response(10, "stack.tif"),
            _file_response(11, "stack.mp4", category="processed"),
            _file_response(12, "stack.jpg", category="processed"),
        ]

        def _update(file_id: int, **kwargs: Any) -> FileResponse:
            if file_id == SIDECAR_ID and kwargs.get("status") == "completed":
                raise ApiError("sidecar complete failed", status_code=500)
            return _file_response(file_id, "x", status=kwargs.get("status", "uploaded"))

        client.update_file.side_effect = _update

        with _patched_process(
            tmp_path,
            client,
            list_objects=["s3://raw/dishcam/run-xyz/stack.tif"],
        ) as (process_file, _encode):
            with pytest.raises(ApiError, match="sidecar complete failed"):
                process_file("dishcam", "run-xyz", "run.json")


def _detail(*rows: RunDetailFile) -> RunDetailResponse:
    return RunDetailResponse(
        id="run-uuid",
        instrument_id="dishcam",
        run_id="run-xyz",
        source="watcher",
        files=list(rows),
    )


class TestCaptureFolderPairing:
    def test_plain_tiff_uses_the_sidecar_from_its_folder(self, tmp_path: Path) -> None:
        from data_hub_lambda.dishcam.filenames import is_run_json

        assert is_run_json("run.json")
        assert is_run_json("run~3f9a1c2b.json")
        assert is_run_json("RUN~3F9A1C2B.JSON")
        assert not is_run_json("run~zzzzzzzz.json")
        assert not is_run_json("notes.json")

        own_folder = "alice/day-2/capture-b"
        other_folder = "alice/day-1/capture-a"
        tagged_sidecar = "run~3f9a1c2b.json"
        client = MagicMock()
        client.ensure_run.return_value = _run_response()
        client.get_run.return_value = _detail(
            _run_file(1, "run.json", relative_path=f"{other_folder}/run.json"),
            _run_file(2, "sample.tif", relative_path=f"{own_folder}/sample.tif"),
            _run_file(3, tagged_sidecar, relative_path=f"{own_folder}/{tagged_sidecar}"),
        )
        client.create_file.side_effect = [
            _file_response(3, tagged_sidecar),
            _file_response(2, "sample.tif"),
            _file_response(4, "sample.mp4", category="processed"),
            _file_response(5, "sample.jpg", category="processed"),
        ]

        def _download(s3_uri: str, local_path: Path, **_: Any) -> None:
            local_path.parent.mkdir(parents=True, exist_ok=True)
            name = s3_uri.rsplit("/", 1)[-1]
            if name == tagged_sidecar:
                local_path.write_text('{"fps": 8, "frames": 10}')
            elif name == "run.json":
                local_path.write_text('{"fps": 1, "frames": 100}')
            else:
                local_path.write_bytes(b"tiff")

        with _patched_process(tmp_path, client, download=_download) as (process_file, encode):
            process_file("dishcam", "run-xyz", "sample.tif")

        encode.assert_called_once()
        client.update_run.assert_not_called()
        tiff_metadata = [
            call.kwargs.get("metadata")
            for call in client.update_file.call_args_list
            if call.args[0] == 2 and call.kwargs.get("metadata") is not None
        ]
        assert tiff_metadata == [{"fps": 8, "frames": 10}]

    def test_tagged_sidecar_encodes_only_its_folder(self, tmp_path: Path) -> None:
        own_folder = "alice/day-2/capture-b"
        other_folder = "alice/day-1/capture-a"
        tagged_sidecar = "run~3f9a1c2b.json"
        client = MagicMock()
        client.ensure_run.return_value = _run_response()
        client.get_run.return_value = _detail(
            _run_file(1, "run.json", relative_path=f"{other_folder}/run.json"),
            _run_file(2, "other.tif", relative_path=f"{other_folder}/other.tif"),
            _run_file(3, tagged_sidecar, relative_path=f"{own_folder}/{tagged_sidecar}"),
            _run_file(4, "sample.tif", relative_path=f"{own_folder}/sample.tif"),
        )
        client.create_file.side_effect = lambda **kwargs: _file_response(
            {"run~3f9a1c2b.json": 3, "sample.tif": 4, "sample.mp4": 5, "sample.jpg": 6}[
                kwargs["filename"]
            ],
            kwargs["filename"],
            category=kwargs.get("category", "raw"),
        )

        with _patched_process(tmp_path, client) as (process_file, encode):
            process_file("dishcam", "run-xyz", tagged_sidecar)

        assert [call.args[0].name for call in encode.call_args_list] == ["sample.tif"]
        client.update_run.assert_not_called()

    def test_root_files_still_share_the_plain_sidecar(self, tmp_path: Path) -> None:
        client = MagicMock()
        client.ensure_run.return_value = _run_response()
        client.get_run.return_value = _detail(
            _run_file(SIDECAR_ID, "run.json", relative_path="run.json"),
            _run_file(10, "stack.tif", relative_path="stack.tif"),
        )
        client.create_file.side_effect = [
            _file_response(SIDECAR_ID, "run.json"),
            _file_response(10, "stack.tif"),
            _file_response(11, "stack.mp4", category="processed"),
            _file_response(12, "stack.jpg", category="processed"),
        ]

        with _patched_process(tmp_path, client) as (process_file, encode):
            process_file("dishcam", "run-xyz", "stack.tif")

        encode.assert_called_once()
        assert encode.call_args.args[0].name == "stack.tif"


class TestPlainRunJsonFallback:
    def test_stack_without_its_own_sidecar_uses_the_plain_run_json(self, tmp_path: Path) -> None:
        client = MagicMock()
        client.ensure_run.return_value = _run_response()
        client.get_run.return_value = _detail(
            _run_file(1, "run.json", relative_path="day-1/run.json"),
            _run_file(2, "day-1.tif", relative_path="day-1/day-1.tif"),
            _run_file(3, "day-2.tif", relative_path="day-2/day-2.tif"),
        )
        client.create_file.side_effect = lambda **kwargs: _file_response(
            {"run.json": 1, "day-2.tif": 3, "day-2.mp4": 4, "day-2.jpg": 5}[kwargs["filename"]],
            kwargs["filename"],
            category=kwargs.get("category", "raw"),
        )

        with _patched_process(tmp_path, client) as (process_file, encode):
            process_file("dishcam", "run-xyz", "day-2.tif")

        assert [call.args[0].name for call in encode.call_args_list] == ["day-2.tif"]
        assert client.update_run.call_args.kwargs["metadata"]["fps"] == 1.0

    def test_plain_run_json_encodes_folders_without_a_sidecar(self, tmp_path: Path) -> None:
        tagged = "run~3f9a1c2b.json"
        client = MagicMock()
        client.ensure_run.return_value = _run_response()
        client.get_run.return_value = _detail(
            _run_file(1, "run.json", relative_path="day-1/run.json"),
            _run_file(2, "own.tif", relative_path="day-1/own.tif"),
            _run_file(3, "orphan.tif", relative_path="day-2/orphan.tif"),
            _run_file(4, tagged, relative_path=f"day-3/{tagged}"),
            _run_file(5, "owned.tif", relative_path="day-3/owned.tif"),
        )
        client.create_file.side_effect = lambda **kwargs: _file_response(
            {
                "run.json": 1,
                "own.tif": 2,
                "orphan.tif": 3,
                "own.mp4": 6,
                "own.jpg": 7,
                "orphan.mp4": 8,
                "orphan.jpg": 9,
            }[kwargs["filename"]],
            kwargs["filename"],
            category=kwargs.get("category", "raw"),
        )

        with _patched_process(tmp_path, client) as (process_file, encode):
            process_file("dishcam", "run-xyz", "run.json")

        assert [call.args[0].name for call in encode.call_args_list] == ["orphan.tif", "own.tif"]
        client.update_run.assert_called_once()

    def test_dismissed_sidecar_does_not_hide_the_plain_run_json(self, tmp_path: Path) -> None:
        client = MagicMock()
        client.ensure_run.return_value = _run_response()
        client.get_run.return_value = _detail(
            _run_file(1, "run.json", relative_path="day-1/run.json"),
            _run_file(
                2,
                "run.json",
                relative_path="day-2/run.json",
                s3_key="dishcam/run-xyz/dismissed.json",
                deleted_at=datetime(2026, 9, 1, tzinfo=UTC),
            ),
            _run_file(3, "day-2.tif", relative_path="day-2/day-2.tif"),
            _run_file(4, "day-2.mp4", category="processed", relative_path="day-2/day-2.mp4"),
        )
        downloaded: list[str] = []

        def _download(s3_uri: str, local_path: Path, **_: Any) -> None:
            downloaded.append(s3_uri)
            _write_download(s3_uri, local_path)

        client.create_file.side_effect = lambda **kwargs: _file_response(
            {"run.json": 1, "day-2.tif": 3, "day-2.mp4": 4, "day-2.jpg": 5}[kwargs["filename"]],
            kwargs["filename"],
            category=kwargs.get("category", "raw"),
        )

        with _patched_process(tmp_path, client, download=_download) as (process_file, encode):
            process_file("dishcam", "run-xyz", "day-2.tif")

        encode.assert_called_once()
        assert downloaded[0].endswith("/run.json")
        assert "dismissed.json" not in downloaded[0]
