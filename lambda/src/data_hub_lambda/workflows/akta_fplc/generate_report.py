"""Akta FPLC per-file processor — fully migrated to the Data Hub API.

Replaces the legacy Notion/Ganymede-based ``generate_report`` with a
per-file flow that writes results to the Data Hub REST API.
"""

from __future__ import annotations
import logging

from data_hub_lambda.api_client import DataHubClient
from data_hub_lambda.constants import DATA_HUB_WEB_URL
from data_hub_shared import s3_utils
from data_hub_shared.config import config
from data_hub_shared.enums import Instrument

logger = logging.getLogger(__name__)


def process_file(
    instrument_id: str,
    run_id: str,
    s3_bucket: str,
    s3_key: str,
    filename: str,
    client: DataHubClient,
) -> str:
    """Process a single Akta FPLC file through the Data Hub API.

    Args:
        instrument_id: The kebab-case instrument ID.
        run_id: The run ID (filename stem).
        s3_bucket: The S3 bucket containing the file.
        s3_key: The full S3 object key.
        filename: The original filename (e.g. ``2025-09-23_test.pdf``).
        client: An authenticated ``DataHubClient`` instance.

    Returns:
        The web app URL for the instrument run.
    """
    logger.info("Processing Akta FPLC file: %s (run: %s)", filename, run_id)

    # 1. Ensure the run exists (upsert — no-op if already created).
    client.ensure_run(instrument_id, run_id)

    # 2. Create the file record (idempotent on s3_key).
    file_record = client.create_file(
        instrument_id=instrument_id,
        run_id=run_id,
        s3_bucket=s3_bucket,
        s3_key=s3_key,
        filename=filename,
    )
    file_id = file_record.id

    # 3. Mark as processing.
    client.update_file(file_id, status="processing")

    # 4. Download from S3 for metadata extraction.
    raw_data_dir = config.LOCAL_RAW_DATA_DIRPATH / Instrument.AKTA_FPLC.value / run_id
    local_file_path = raw_data_dir / filename
    s3_utils.download_file(f"s3://{s3_bucket}/{s3_key}", local_file_path)
    logger.info("Downloaded %s to %s", filename, local_file_path)

    # 5. Extract metadata. Column type was previously read from Ganymede tags;
    #    until a new extraction method is implemented, metadata is empty.
    metadata: dict[str, str] = {}

    # 6. Mark as completed with metadata.
    client.update_file(file_id, status="completed", metadata=metadata)
    logger.info("File %s marked as completed.", filename)

    # 7. Return the web app URL.
    return f"{DATA_HUB_WEB_URL}/instruments/{instrument_id}/runs/{run_id}"
