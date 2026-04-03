from __future__ import annotations
import logging

from data_hub_lambda.agilent_4150_tapestation.utils import parse_tape_type
from data_hub_lambda.api_client import get_client
from data_hub_lambda.constants import DATA_HUB_WEB_URL
from data_hub_shared import s3_utils
from data_hub_shared.config import config
from data_hub_shared.enums import Instrument

logger = logging.getLogger(__name__)

INSTRUMENT_ID = Instrument.AGILENT_4150_TAPESTATION.value


def process_file(run_id: str, filename: str) -> str:
    """Process a single Agilent 4150 TapeStation file through the Data Hub API.

    Args:
        run_id: The run ID (`YYYY-MM-DD - HH-MM-SS` prefix).
        filename: The original filename (e.g. `2026-02-18 - 18-00-04-gDNA_peakTable.csv`).

    Returns:
        The web app URL for the instrument run.
    """
    logger.info("Processing Agilent 4150 TapeStation file: %s (run: %s)", filename, run_id)

    client = get_client()
    s3_bucket = config.AWS_S3_RAW_DATA_BUCKET
    s3_key = f"{INSTRUMENT_ID}/{filename}"

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

        metadata: dict[str, str] = {}
        tape_type = parse_tape_type(filename)
        if tape_type:
            metadata["Tape Type"] = tape_type
        logger.info("Parsed metadata: %s", metadata)

        client.update_file(file_id, status="completed", metadata=metadata)
        logger.info("File %s marked as completed.", filename)

    except Exception as e:
        logger.error("Error processing file: %s", e)
        client.update_file(file_id, status="failed", error_message=str(e))
        raise

    return f"{DATA_HUB_WEB_URL}/instruments/{INSTRUMENT_ID}/runs/{run_id}"
