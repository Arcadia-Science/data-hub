from __future__ import annotations
import logging
from typing import Literal

from data_hub_lambda.api_client import get_client
from data_hub_lambda.constants import DATA_HUB_WEB_URL
from data_hub_lambda.spectramax_plate_reader.utils import parse_metadata, parse_raw_well_data
from data_hub_shared import s3_utils
from data_hub_shared.config import config

logger = logging.getLogger(__name__)

InstrumentType = Literal["spectramax-id3-plate-reader", "spectramax-id5-plate-reader"]


def process_file(instrument_id: InstrumentType, run_id: str, filename: str) -> str:
    """Process a single SpectraMax plate reader file through the Data Hub API.

    Args:
        instrument_id: The instrument ID (iD3 or iD5).
        run_id: The run ID (filename stem).
        filename: The original filename (e.g. `033126_CM_Od750.xls`).

    Returns:
        The web app URL for the instrument run.
    """
    logger.info("Processing SpectraMax file: %s (run: %s)", filename, run_id)

    client = get_client()
    s3_bucket = config.AWS_S3_RAW_DATA_BUCKET
    s3_key = f"{instrument_id}/{filename}"

    client.ensure_run(instrument_id, run_id)

    file_record = client.create_file(
        instrument_id=instrument_id,
        run_id=run_id,
        s3_bucket=s3_bucket or "",
        s3_key=s3_key,
        filename=filename,
    )
    file_id = file_record.id

    try:
        client.update_file(file_id, status="processing")

        raw_data_dir = config.LOCAL_RAW_DATA_DIRPATH / instrument_id / run_id
        local_file_path = raw_data_dir / filename
        s3_utils.download_file(f"s3://{s3_bucket}/{s3_key}", local_file_path)
        logger.info("Downloaded %s to %s", filename, local_file_path)

        metadata = parse_metadata(local_file_path)
        logger.info("Parsed metadata: %s", metadata)

        well_data = parse_raw_well_data(local_file_path)
        logger.info("Parsed %d well data rows.", len(well_data))

        client.update_run(instrument_id, run_id, metadata=metadata)
        client.update_file(
            file_id,
            status="completed",
            report_data=[
                {
                    "data_type": "raw_well_data",
                    "data": well_data.to_dict(orient="records"),
                },
            ],
        )
        logger.info("File %s marked as completed.", filename)

    except Exception as e:
        logger.error("Error processing file: %s", e)
        client.update_file(file_id, status="failed", error_message=str(e))
        raise

    return f"{DATA_HUB_WEB_URL}/instruments/{instrument_id}/runs/{run_id}"
