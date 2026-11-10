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
) -> None:
    """Upload *local_path* to the processed bucket and register it as a `processed` file."""
    s3_key = f"{instrument_id}/{run_id}/{local_path.name}"
    s3_utils.upload_file(local_path, f"s3://{processed_bucket}/{s3_key}")
    processed = client.create_file(
        instrument_id=instrument_id,
        run_id=run_id,
        s3_bucket=processed_bucket,
        s3_key=s3_key,
        filename=local_path.name,
        category="processed",
    )
    client.update_file(
        processed.id,
        size_bytes=local_path.stat().st_size,
        content_type=content_type,
    )
