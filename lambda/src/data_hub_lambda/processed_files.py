"""Register a file a processor made, such as a preview, alongside its raw file."""

from __future__ import annotations
from pathlib import Path

from data_hub_lambda.api_client import DataHubClient
from data_hub_shared import s3_utils


def upload_processed(
    client: DataHubClient,
    instrument_id: str,
    run_id: str,
    processed_bucket: str,
    local_path: Path,
    content_type: str,
    source_file_id: int | None = None,
) -> None:
    """Upload *local_path* to the processed bucket and register it as a `processed` file.

    *source_file_id* is the raw file the output was made from. Pass it for the
    preview, video or table of one raw file. Leave it out when more than one
    raw file can write the output, as qPCR's outputs named for the run can be.

    The size and content type go with the create call. If the file was deleted
    while it processed, the API returns the new row already deleted, and the
    follow-up PATCH that fixes up an existing row is skipped, because a deleted
    file refuses it.
    """
    s3_key = f"{instrument_id}/{run_id}/{local_path.name}"
    s3_utils.upload_file(local_path, f"s3://{processed_bucket}/{s3_key}")
    size_bytes = local_path.stat().st_size
    processed = client.create_file(
        instrument_id=instrument_id,
        run_id=run_id,
        s3_bucket=processed_bucket,
        s3_key=s3_key,
        filename=local_path.name,
        content_type=content_type,
        size_bytes=size_bytes,
        category="processed",
        source_file_id=source_file_id,
    )
    if processed.deleted_at is not None:
        return
    # A row that already existed, such as one from an earlier run of the
    # processor, comes back as it was, so write this run's size and type to it.
    client.update_file(
        processed.id,
        size_bytes=size_bytes,
        content_type=content_type,
    )
