"""`upload_processed` registers a processor's output with the raw file it came from."""

from __future__ import annotations
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from data_hub_lambda.models import FileResponse
from data_hub_lambda.processed_files import upload_processed


def _processed(deleted_at: datetime | None = None) -> FileResponse:
    return FileResponse(
        id=31,
        instrument_run_id="run-uuid",
        filename="a.jpg",
        category="processed",
        status="uploaded",
        deleted_at=deleted_at,
    )


@pytest.fixture
def output(tmp_path: Path) -> Path:
    path = tmp_path / "a.jpg"
    path.write_bytes(b"12345")
    return path


@pytest.fixture(autouse=True)
def _s3() -> Iterator[MagicMock]:
    with patch("data_hub_lambda.processed_files.s3_utils") as mock:
        yield mock


def test_uploads_to_the_processed_bucket_under_the_run(output: Path, _s3: MagicMock) -> None:
    client = MagicMock()
    client.create_file.return_value = _processed()

    upload_processed(client, "inst", "run-1", "processed-bucket", output, "image/jpeg")

    _s3.upload_file.assert_called_once_with(output, "s3://processed-bucket/inst/run-1/a.jpg")


def test_sends_the_size_type_and_source_with_the_create_call(output: Path) -> None:
    client = MagicMock()
    client.create_file.return_value = _processed()

    upload_processed(
        client, "inst", "run-1", "processed-bucket", output, "image/jpeg", source_file_id=12
    )

    client.create_file.assert_called_once_with(
        instrument_id="inst",
        run_id="run-1",
        s3_bucket="processed-bucket",
        s3_key="inst/run-1/a.jpg",
        filename="a.jpg",
        content_type="image/jpeg",
        size_bytes=5,
        category="processed",
        source_file_id=12,
    )


def test_an_output_of_a_whole_run_sends_no_source(output: Path) -> None:
    client = MagicMock()
    client.create_file.return_value = _processed()

    upload_processed(client, "inst", "run-1", "processed-bucket", output, "image/jpeg")

    assert client.create_file.call_args.kwargs["source_file_id"] is None


def test_updates_the_size_and_type_of_a_row_that_already_existed(output: Path) -> None:
    client = MagicMock()
    client.create_file.return_value = _processed()

    upload_processed(client, "inst", "run-1", "processed-bucket", output, "image/jpeg")

    client.update_file.assert_called_once_with(31, size_bytes=5, content_type="image/jpeg")


def test_leaves_an_output_that_came_back_deleted_alone(output: Path) -> None:
    # The raw file was deleted while it processed: the API saved the output as
    # deleted, and a deleted file refuses the PATCH.
    client = MagicMock()
    client.create_file.return_value = _processed(deleted_at=datetime.now(UTC))

    upload_processed(
        client, "inst", "run-1", "processed-bucket", output, "image/jpeg", source_file_id=12
    )

    client.update_file.assert_not_called()
