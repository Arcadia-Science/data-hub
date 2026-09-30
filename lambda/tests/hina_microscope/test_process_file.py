"""Unit tests for `hina_microscope.process_file`.

These verify the orchestration logic — specifically that run-level metadata
is parsed and stored only on the first file to arrive in a given run — by
mocking S3 I/O, the API client, the ND2 processor, and the metadata parser.
"""

from __future__ import annotations
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

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
            patch("data_hub_lambda.hina_microscope.process_file.s3_utils") as s3_mock,
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
            patch("data_hub_lambda.hina_microscope.process_file.s3_utils") as s3_mock,
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
            patch("data_hub_lambda.hina_microscope.process_file.s3_utils"),
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
    "File is 10.3 GB, larger than the 10.0 GB of disk available for processing. "
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
            from data_hub_lambda.processing_disk import ObjectTooLargeForDiskError

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
            patch("data_hub_shared.config.config.RAW_DATA_MOUNT_PATH", str(mount)),
            patch(
                "data_hub_lambda.hina_microscope.process_file.config.LOCAL_PROCESSED_DATA_DIRPATH",
                output_dir,
            ),
            patch("data_hub_shared.s3_utils.object_content_length", return_value=1024**3),
            patch(
                "data_hub_lambda.raw_access._matching_size",
                lambda path, _expected: path.is_file(),
            ),
            patch("data_hub_shared.s3_utils.download_file") as download,
            patch("data_hub_lambda.hina_microscope.process_file.get_client", return_value=client),
            patch("data_hub_lambda.hina_microscope.process_file.s3_utils"),
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
