from __future__ import annotations
import logging

from data_hub_lambda.api_client import get_client
from data_hub_lambda.constants import DATA_HUB_WEB_URL
from data_hub_lambda.hina_microscope.image_processing import ND2Processor
from data_hub_lambda.hina_microscope.parse_metadata import parse_metadata
from data_hub_shared import s3_utils
from data_hub_shared.config import config
from data_hub_shared.enums import Instrument

logger = logging.getLogger(__name__)

INSTRUMENT_ID = Instrument.HINA_MICROSCOPE.value


def process_file(run_id: str, filename: str) -> str:
    """Process a single Hina microscope ND2 file through the Data Hub API.

    Downloads the raw ND2, runs it through the image processing pipeline to
    produce a composite JPG overlay, uploads the JPG to the processed bucket,
    and registers both files via the API. Run-level metadata (sizes,
    channels, dimensions) is parsed and stored once per run — the first file
    to arrive wins. Subsequent files in the same run still get a JPG but
    skip the metadata step.

    Args:
        run_id: The run ID (grouping key for files in a single imaging session).
        filename: The original filename (e.g. `well_A1_xy01.nd2`).

    Returns:
        The web app URL for the instrument run.
    """
    logger.info("Processing Hina microscope file: %s (run: %s)", filename, run_id)

    client = get_client()
    s3_bucket = config.AWS_S3_RAW_DATA_BUCKET
    s3_key = f"{INSTRUMENT_ID}/{run_id}/{filename}"

    run = client.ensure_run(INSTRUMENT_ID, run_id)

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

        processor = ND2Processor(local_file_path)
        processor.load()
        jpg_file_path = processor.export_jpg()

        processed_bucket = config.AWS_S3_PROCESSED_DATA_BUCKET
        jpg_s3_key = f"{INSTRUMENT_ID}/{run_id}/{jpg_file_path.name}"
        s3_utils.upload_file(jpg_file_path, f"s3://{processed_bucket}/{jpg_s3_key}")
        logger.info("Uploaded processed image to s3://%s/%s", processed_bucket, jpg_s3_key)

        processed_file = client.create_file(
            instrument_id=INSTRUMENT_ID,
            run_id=run_id,
            s3_bucket=processed_bucket or "",
            s3_key=jpg_s3_key,
            filename=jpg_file_path.name,
            category="processed",
        )
        client.update_file(
            processed_file.id,
            size_bytes=jpg_file_path.stat().st_size,
            content_type="image/jpeg",
        )

        # Run-level metadata is deterministic for a Hina run (same channels,
        # sizes, dimensions across every .nd2 file in the run) so we only
        # parse and store it once — on the first file to arrive.
        if not run.metadata:
            metadata = parse_metadata(processor.image)
            client.update_run(INSTRUMENT_ID, run_id, metadata=metadata)
            logger.info("Parsed and stored run-level metadata for %s", run_id)
        else:
            logger.info("Run %s already has metadata; skipping metadata step.", run_id)

        client.update_file(file_id, status="completed")
        logger.info("File %s marked as completed.", filename)

    except Exception as e:
        logger.error("Error processing file: %s", e)
        client.update_file(file_id, status="failed", error_message=str(e))
        raise

    return f"{DATA_HUB_WEB_URL}/instruments/{INSTRUMENT_ID}/runs/{run_id}"
