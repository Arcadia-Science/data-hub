from __future__ import annotations
import logging

from data_hub_lambda.api_client import get_client
from data_hub_lambda.azure_600_gel_doc.image_processing import TIFFProcessor
from data_hub_lambda.azure_600_gel_doc.parse_metadata import parse_metadata
from data_hub_lambda.constants import DATA_HUB_WEB_URL
from data_hub_shared import s3_utils
from data_hub_shared.config import config
from data_hub_shared.enums import Instrument

logger = logging.getLogger(__name__)

INSTRUMENT_ID = Instrument.AZURE_600_GEL_DOC.value


def process_file(run_id: str, filename: str) -> str:
    """Process a single Azure 600 Gel Doc file through the Data Hub API.

    Downloads the raw TIFF, runs it through the image processing pipeline
    to produce a contrast-enhanced PNG, uploads the PNG to the processed
    S3 bucket, and registers both files via the API.

    Args:
        run_id: The run ID (filename stem).
        filename: The original filename (e.g. `26.04.01_16.51.59.tif`).

    Returns:
        The web app URL for the instrument run.
    """
    logger.info("Processing Azure 600 Gel Doc file: %s (run: %s)", filename, run_id)

    client = get_client()
    s3_bucket = config.AWS_S3_RAW_DATA_BUCKET
    s3_key = f"{INSTRUMENT_ID}/{run_id}/{filename}"

    client.ensure_run(INSTRUMENT_ID, run_id)

    file_record = client.create_file(
        instrument_id=INSTRUMENT_ID,
        run_id=run_id,
        s3_bucket=s3_bucket or "",
        s3_key=s3_key,
        filename=filename,
    )
    file_id = file_record.id

    try:
        client.update_file(file_id, status="processing")

        raw_data_dir = config.LOCAL_RAW_DATA_DIRPATH / INSTRUMENT_ID / run_id
        local_file_path = raw_data_dir / filename
        s3_utils.download_file(f"s3://{s3_bucket}/{s3_key}", local_file_path)
        logger.info("Downloaded %s to %s", filename, local_file_path)

        tiff_processor = TIFFProcessor(local_file_path)
        tiff_processor.load()
        png_file_path = tiff_processor.export_figure()

        processed_bucket = config.AWS_S3_PROCESSED_DATA_BUCKET
        png_s3_key = f"{INSTRUMENT_ID}/{run_id}/{png_file_path.name}"
        s3_utils.upload_file(png_file_path, f"s3://{processed_bucket}/{png_s3_key}")
        logger.info("Uploaded processed image to s3://%s/%s", processed_bucket, png_s3_key)

        processed_file = client.create_file(
            instrument_id=INSTRUMENT_ID,
            run_id=run_id,
            s3_bucket=processed_bucket or "",
            s3_key=png_s3_key,
            filename=png_file_path.name,
            category="processed",
        )
        client.update_file(
            processed_file.id,
            size_bytes=png_file_path.stat().st_size,
            content_type="image/png",
        )

        metadata = parse_metadata(local_file_path)
        logger.info("Parsed metadata: %s", metadata)

        client.update_run(INSTRUMENT_ID, run_id, metadata=metadata)
        client.update_file(file_id, status="completed")
        logger.info("File %s marked as completed.", filename)

    except Exception as e:
        logger.error("Error processing file: %s", e)
        client.update_file(file_id, status="failed", error_message=str(e))
        raise

    return f"{DATA_HUB_WEB_URL}/instruments/{INSTRUMENT_ID}/runs/{run_id}"
