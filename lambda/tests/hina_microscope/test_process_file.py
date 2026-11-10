"""Unit tests for `hina_microscope.process_file`.

These verify the orchestration logic — that run-level metadata is parsed
and stored only on the first file to arrive in a given run, and that a
timelapse also gets a registered MP4 — by mocking S3 I/O, the API client,
the ND2 processor, and the metadata parser.
"""

from __future__ import annotations
from contextlib import AbstractContextManager, nullcontext
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from data_hub_lambda.deadline import ProcessingDeadlineError
from data_hub_lambda.hina_microscope.image_processing import TimelapseVideo
from data_hub_lambda.hina_microscope.process_file import TimelapseVideoError
from data_hub_lambda.models import FileResponse, RunResponse


@pytest.fixture(autouse=True)
def _small_raw_object(monkeypatch: pytest.MonkeyPatch) -> None:
    """The shared helper asks S3 for the size before it opens the file."""

    def _download(_uri: str, local_path: Path, **_kwargs: Any) -> None:
        local_path.parent.mkdir(parents=True, exist_ok=True)
        local_path.write_bytes(b"nd2")

    monkeypatch.setattr("data_hub_shared.s3_utils.object_content_length", lambda *_a, **_k: 128)
    monkeypatch.setattr("data_hub_shared.s3_utils.download_file", _download)


@pytest.fixture(autouse=True)
def _local_dirs_in_tmp(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from data_hub_lambda.hina_microscope.process_file import config

    monkeypatch.setattr(config, "LOCAL_RAW_DATA_DIRPATH", tmp_path / "raw")
    monkeypatch.setattr(config, "LOCAL_PROCESSED_DATA_DIRPATH", tmp_path / "processed")


@pytest.fixture(autouse=True)
def _reset_api_client() -> Any:
    """Ensure `get_client()` returns a fresh mock per test."""
    import data_hub_lambda.api_client as api_module

    original = api_module._client
    api_module._client = None
    try:
        yield
    finally:
        api_module._client = original


def _run_response(metadata: dict | None = None) -> RunResponse:
    return RunResponse(
        id="run-uuid",
        instrument_id="hina-microscope",
        run_id="run-xyz",
        source="lambda",
        metadata=metadata or {},
    )


def _file_response(file_id: int = 123) -> FileResponse:
    return FileResponse(
        id=file_id,
        instrument_run_id="run-uuid",
        filename="sample.nd2",
        s3_bucket="raw",
        s3_key="hina-microscope/run-xyz/sample.nd2",
        category="raw",
        status="uploaded",
    )


def _build_client_mock(run_metadata: dict | None) -> MagicMock:
    client = MagicMock()
    client.ensure_run.return_value = _run_response(metadata=run_metadata)
    # `create_file` is called twice (raw, processed); give each a distinct id.
    client.create_file.side_effect = [
        _file_response(file_id=10),
        _file_response(file_id=11),
    ]
    return client


@pytest.fixture
def patched_jpg_path(tmp_path: Path) -> Path:
    """A fake JPG output path that actually exists on disk (for stat())."""
    jpg = tmp_path / "sample.jpg"
    jpg.write_bytes(b"fake-jpg-bytes")
    return jpg


@pytest.fixture
def patched_processor(patched_jpg_path: Path) -> MagicMock:
    """A stand-in `ND2Processor` whose `export_jpg` returns a real tmp file."""
    processor = MagicMock()
    processor.image = MagicMock()
    processor.load.return_value = None
    processor.export_jpg.return_value = patched_jpg_path
    processor.export_mp4.return_value = None
    return processor


class TestProcessFileRunMetadataGate:
    """Verifies the single-shot-metadata behavior of `process_file`."""

    def test_first_file_parses_metadata_and_updates_run(
        self,
        patched_processor: MagicMock,
    ) -> None:
        client = _build_client_mock(run_metadata=None)  # empty = first file

        with (
            patch("data_hub_lambda.hina_microscope.process_file.get_client", return_value=client),
            patch("data_hub_lambda.processed_files.s3_utils") as s3_mock,
            patch(
                "data_hub_lambda.hina_microscope.process_file.ND2Processor",
                return_value=patched_processor,
            ),
            patch(
                "data_hub_lambda.hina_microscope.process_file.parse_metadata",
                return_value={"sizes": {"C": 1}, "channels": [], "dimensions": []},
            ) as parse_mock,
        ):
            from data_hub_lambda.hina_microscope.process_file import process_file

            process_file(
                instrument_id="hina-microscope",
                run_id="run-xyz",
                filename="sample.nd2",
            )

        # First file → metadata is parsed and persisted.
        parse_mock.assert_called_once_with(patched_processor.image)
        client.update_run.assert_called_once()
        _, kwargs = client.update_run.call_args
        assert kwargs == {
            "metadata": {"sizes": {"C": 1}, "channels": [], "dimensions": []},
        }

        # JPG is generated and uploaded regardless.
        patched_processor.export_jpg.assert_called_once()
        s3_mock.upload_file.assert_called_once()

    def test_later_file_skips_metadata_but_still_generates_jpg(
        self,
        patched_processor: MagicMock,
    ) -> None:
        existing_metadata = {
            "sizes": {"C": 2, "Y": 8, "X": 8},
            "channels": [{"name": "DAPI"}],
            "dimensions": ["MULTICHANNEL"],
        }
        client = _build_client_mock(run_metadata=existing_metadata)

        with (
            patch("data_hub_lambda.hina_microscope.process_file.get_client", return_value=client),
            patch("data_hub_lambda.processed_files.s3_utils") as s3_mock,
            patch(
                "data_hub_lambda.hina_microscope.process_file.ND2Processor",
                return_value=patched_processor,
            ),
            patch(
                "data_hub_lambda.hina_microscope.process_file.parse_metadata",
            ) as parse_mock,
        ):
            from data_hub_lambda.hina_microscope.process_file import process_file

            process_file(
                instrument_id="hina-microscope",
                run_id="run-xyz",
                filename="sample-2.nd2",
            )

        # Second file → metadata step is skipped.
        parse_mock.assert_not_called()
        client.update_run.assert_not_called()

        # JPG is still generated and uploaded.
        patched_processor.export_jpg.assert_called_once()
        s3_mock.upload_file.assert_called_once()


class TestProcessFileFailure:
    """On exception, the raw file status is marked `failed` with an error message."""

    def test_marks_raw_file_failed_on_exception(self, tmp_path: Path) -> None:
        client = _build_client_mock(run_metadata=None)

        failing_processor = MagicMock()
        failing_processor.load.side_effect = RuntimeError("boom")

        with (
            patch("data_hub_lambda.hina_microscope.process_file.get_client", return_value=client),
            patch("data_hub_lambda.processed_files.s3_utils"),
            patch(
                "data_hub_lambda.hina_microscope.process_file.ND2Processor",
                return_value=failing_processor,
            ),
        ):
            from data_hub_lambda.hina_microscope.process_file import process_file

            with pytest.raises(RuntimeError, match="boom"):
                process_file(
                    instrument_id="hina-microscope",
                    run_id="run-xyz",
                    filename="broken.nd2",
                )

        # File should be transitioned through processing → failed with the error message.
        statuses = [
            call.kwargs.get("status")
            for call in client.update_file.call_args_list
            if "status" in call.kwargs
        ]
        assert "processing" in statuses
        assert "failed" in statuses

        failed_call = next(
            call
            for call in client.update_file.call_args_list
            if call.kwargs.get("status") == "failed"
        )
        assert failed_call.kwargs["error_message"] == "boom"


_TOO_BIG = (
    "File is 10.3 GB, larger than the 9.5 GB of disk available for processing. "
    "The raw file is stored and can be downloaded."
)


class TestProcessFileTooLarge:
    def test_oversized_file_is_marked_failed_and_not_downloaded(self, tmp_path: Path) -> None:
        client = _build_client_mock(run_metadata=None)

        with (
            patch(
                "data_hub_shared.s3_utils.object_content_length",
                return_value=11_097_280_814,
            ),
            patch(
                "data_hub_lambda.raw_access.shutil.disk_usage",
                return_value=SimpleNamespace(free=10 * 1024**3),
            ),
            patch(
                "data_hub_lambda.hina_microscope.process_file.config.LOCAL_RAW_DATA_DIRPATH",
                tmp_path,
            ),
            patch("data_hub_lambda.hina_microscope.process_file.get_client", return_value=client),
            patch("data_hub_shared.s3_utils.download_file") as download,
            patch("data_hub_lambda.hina_microscope.process_file.ND2Processor") as processor,
        ):
            from data_hub_lambda.hina_microscope.process_file import process_file
            from data_hub_lambda.raw_access import ObjectTooLargeForDiskError

            with pytest.raises(ObjectTooLargeForDiskError, match="10.3 GB"):
                process_file(
                    instrument_id="hina-microscope",
                    run_id="run-xyz",
                    filename="huge.nd2",
                )

        download.assert_not_called()
        processor.assert_not_called()
        failed_call = next(
            call
            for call in client.update_file.call_args_list
            if call.kwargs.get("status") == "failed"
        )
        assert failed_call.kwargs["error_message"] == _TOO_BIG


class TestProcessFileFromMount:
    def test_mounted_nd2_is_processed_in_place(
        self, tmp_path: Path, patched_processor: MagicMock
    ) -> None:
        client = _build_client_mock(run_metadata={"sizes": {"C": 1}})
        mount = tmp_path / "mount"
        mounted = mount / "hina-microscope" / "run-xyz" / "sample.nd2"
        mounted.parent.mkdir(parents=True)
        mounted.write_bytes(b"nd2-bytes")
        output_dir = tmp_path / "processed"

        with (
            patch("data_hub_lambda.config.lambda_config.RAW_DATA_MOUNT_PATH", str(mount)),
            patch(
                "data_hub_lambda.hina_microscope.process_file.config.LOCAL_PROCESSED_DATA_DIRPATH",
                output_dir,
            ),
            patch(
                "data_hub_shared.s3_utils.object_content_length",
                return_value=len(b"nd2-bytes"),
            ),
            patch("data_hub_lambda.raw_access.MOUNT_READ_MIN_BYTES", 1),
            patch("data_hub_shared.s3_utils.download_file") as download,
            patch("data_hub_lambda.hina_microscope.process_file.get_client", return_value=client),
            patch("data_hub_lambda.processed_files.s3_utils"),
            patch(
                "data_hub_lambda.hina_microscope.process_file.ND2Processor",
                return_value=patched_processor,
            ) as processor_class,
        ):
            from data_hub_lambda.hina_microscope.process_file import process_file

            process_file(
                instrument_id="hina-microscope",
                run_id="run-xyz",
                filename="sample.nd2",
            )

        download.assert_not_called()
        processor_class.assert_called_once_with(mounted)
        patched_processor.export_jpg.assert_called_once_with(
            output_dir=output_dir / "hina-microscope" / "run-xyz"
        )
        assert mounted.exists()


_OUTPUT_DIR_NAME = "processed"


def _writing_processor(
    video_frames: int | None, encode_error: Exception | None = None
) -> MagicMock:
    """A stand-in `ND2Processor` that writes its previews into the output folder.

    *video_frames* of `None` stands for a file with one time point.
    """
    processor = MagicMock()

    def _export_jpg(*, output_dir: Path) -> Path:
        output_dir.mkdir(parents=True, exist_ok=True)
        path = output_dir / "sample.jpg"
        path.write_bytes(b"jpg")
        return path

    def _export_mp4(*, output_dir: Path) -> TimelapseVideo | None:
        if video_frames is None and encode_error is None:
            return None
        path = output_dir / "sample.mp4"
        path.write_bytes(b"mp4-bytes")
        if encode_error is not None:
            raise encode_error
        assert video_frames is not None
        return TimelapseVideo(
            path=path, frames=video_frames, frame_interval_ms=500.16, playback_fps=10.0
        )

    processor.export_jpg.side_effect = _export_jpg
    processor.export_mp4.side_effect = _export_mp4
    return processor


def _run(client: MagicMock, processor: MagicMock) -> MagicMock:
    with (
        patch("data_hub_lambda.hina_microscope.process_file.get_client", return_value=client),
        patch("data_hub_lambda.processed_files.s3_utils") as s3_mock,
        patch("data_hub_lambda.hina_microscope.process_file.ND2Processor", return_value=processor),
        patch(
            "data_hub_lambda.hina_microscope.process_file.parse_metadata",
            return_value={"sizes": {"T": 53}},
        ),
    ):
        from data_hub_lambda.hina_microscope.process_file import process_file

        process_file(instrument_id="hina-microscope", run_id="run-xyz", filename="sample.nd2")
    return s3_mock


def _timelapse_client() -> MagicMock:
    client = _build_client_mock(run_metadata=None)
    client.create_file.side_effect = [_file_response(file_id) for file_id in (10, 11, 12)]
    return client


def _created(client: MagicMock, filename: str) -> dict[str, Any]:
    return next(
        call.kwargs
        for call in client.create_file.call_args_list
        if call.kwargs["filename"] == filename
    )


def _status_updates(client: MagicMock) -> list[dict[str, Any]]:
    return [call.kwargs for call in client.update_file.call_args_list if "status" in call.kwargs]


class TestProcessFileTimelapse:
    def test_mp4_is_registered_and_the_timing_stored_on_the_raw_file(self, tmp_path: Path) -> None:
        client = _timelapse_client()

        s3_mock = _run(client, _writing_processor(video_frames=53))

        mp4 = _created(client, "sample.mp4")
        assert mp4["category"] == "processed"
        assert mp4["s3_key"] == "hina-microscope/run-xyz/sample.mp4"
        assert _created(client, "sample.jpg")["category"] == "processed"
        client.update_file.assert_any_call(
            12, size_bytes=len(b"mp4-bytes"), content_type="video/mp4"
        )
        client.update_file.assert_any_call(11, size_bytes=len(b"jpg"), content_type="image/jpeg")
        assert _status_updates(client)[-1] == {
            "status": "completed",
            "metadata": {"frames": 53, "frame_interval_ms": 500.16, "playback_fps": 10.0},
        }
        uploaded = [call.args[1] for call in s3_mock.upload_file.call_args_list]
        assert [uri.rsplit("/", 1)[-1] for uri in uploaded] == ["sample.jpg", "sample.mp4"]

    def test_a_single_time_point_gets_only_the_jpg(self) -> None:
        client = _timelapse_client()

        _run(client, _writing_processor(video_frames=None))

        assert [call.kwargs["filename"] for call in client.create_file.call_args_list] == [
            "sample.nd2",
            "sample.jpg",
        ]
        assert _status_updates(client)[-1] == {"status": "completed"}

    @pytest.mark.parametrize(
        ("error", "message"),
        [
            (
                RuntimeError("ffmpeg encode failed: broken pipe"),
                "Couldn't make the timelapse video: ffmpeg encode failed: broken pipe. "
                "The still preview is still available.",
            ),
            (
                ProcessingDeadlineError(
                    "Stopped before the time limit during encoding (12 of 53 frames done). "
                    "The raw file is stored and can be downloaded."
                ),
                "Couldn't make the timelapse video: Stopped before the time limit during "
                "encoding (12 of 53 frames done). The raw file is stored and can be "
                "downloaded. The still preview is still available.",
            ),
        ],
        ids=["ffmpeg", "deadline"],
    )
    def test_failed_encode_marks_the_file_failed_and_keeps_the_jpg(
        self, error: Exception, message: str
    ) -> None:
        client = _timelapse_client()

        with pytest.raises(TimelapseVideoError):
            _run(client, _writing_processor(video_frames=53, encode_error=error))

        assert _created(client, "sample.jpg")["category"] == "processed"
        client.update_file.assert_any_call(11, size_bytes=len(b"jpg"), content_type="image/jpeg")
        assert all(
            call.kwargs["filename"] != "sample.mp4" for call in client.create_file.call_args_list
        )
        assert _status_updates(client)[-1] == {"status": "failed", "error_message": message}

    @pytest.mark.parametrize(
        "encode_error",
        [None, RuntimeError("ffmpeg encode failed")],
        ids=["completed", "failed"],
    )
    def test_local_previews_are_removed(
        self, tmp_path: Path, encode_error: Exception | None
    ) -> None:
        output_dir = tmp_path / _OUTPUT_DIR_NAME / "hina-microscope" / "run-xyz"

        raises: AbstractContextManager[object] = (
            pytest.raises(TimelapseVideoError) if encode_error else nullcontext()
        )
        with raises:
            _run(_timelapse_client(), _writing_processor(53, encode_error))

        assert output_dir.is_dir()
        assert list(output_dir.iterdir()) == []
