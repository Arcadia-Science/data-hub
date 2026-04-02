"""Azure 600 Gel Doc per-file processor — migrated to the Data Hub API.

Replaces the legacy Notion/Ganymede-based ``generate_report`` with a
per-file flow that writes results to the Data Hub REST API.
"""

from __future__ import annotations
import logging
from pathlib import Path

from data_hub_lambda.api_client import DataHubClient
from data_hub_lambda.azure_600_gel_doc.image_processing import TIFFProcessor
from data_hub_lambda.azure_600_gel_doc.parse_metadata import parse_metadata
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
    """Process a single Azure 600 Gel Doc file through the Data Hub API.

    Downloads the raw TIFF, runs it through the image processing pipeline
    to produce a contrast-enhanced PNG, uploads the PNG to the processed
    S3 bucket, and registers both files via the API.

    Args:
        instrument_id: The kebab-case instrument ID.
        run_id: The run ID (filename stem).
        s3_bucket: The S3 bucket containing the file.
        s3_key: The full S3 object key.
        filename: The original filename (e.g. ``26.04.01_16.51.59.tif``).
        client: An authenticated ``DataHubClient`` instance.

    Returns:
        The web app URL for the instrument run.
    """
    logger.info("Processing Azure 600 Gel Doc file: %s (run: %s)", filename, run_id)

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

    try:
        # 3. Mark as processing.
        client.update_file(file_id, status="processing")

        # 4. Download the raw TIFF from S3.
        raw_data_dir = config.LOCAL_RAW_DATA_DIRPATH / Instrument.AZURE_600_GEL_DOC.value / run_id
        local_file_path = raw_data_dir / filename
        s3_utils.download_file(f"s3://{s3_bucket}/{s3_key}", local_file_path)
        logger.info("Downloaded %s to %s", filename, local_file_path)

        # 5. Process the TIFF into a contrast-enhanced PNG.
        png_file_path = _process_tiff(local_file_path)

        # 6. Upload the processed PNG to the processed S3 bucket.
        processed_bucket = config.AWS_S3_PROCESSED_DATA_BUCKET
        png_s3_key = f"{instrument_id}/{png_file_path.name}"
        s3_utils.upload_file(png_file_path, f"s3://{processed_bucket}/{png_s3_key}")
        logger.info("Uploaded processed image to s3://%s/%s", processed_bucket, png_s3_key)

        # 7. Register the processed file in the API.
        client.create_file(
            instrument_id=instrument_id,
            run_id=run_id,
            s3_bucket=processed_bucket or "",
            s3_key=png_s3_key,
            filename=png_file_path.name,
            category="processed",
        )

        # 8. Extract imaging metadata from the TIFF.
        metadata = parse_metadata(local_file_path)
        logger.info("Parsed metadata: %s", metadata)

        # 9. Mark as completed with metadata.
        client.update_file(file_id, status="completed", metadata=metadata)
        logger.info("File %s marked as completed.", filename)

    except Exception as e:
        logger.error("Error processing file: %s", e)
        client.update_file(file_id, status="failed", error_message=str(e))
        raise

    # 10. Return the web app URL.
    return f"{DATA_HUB_WEB_URL}/instruments/{instrument_id}/runs/{run_id}"


def _process_tiff(tiff_path: Path) -> Path:
    """Run the TIFF through the image processing pipeline and return the PNG path."""
    tiff_processor = TIFFProcessor(tiff_path)
    tiff_processor.load()
    return tiff_processor.export_figure()
