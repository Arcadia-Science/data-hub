from __future__ import annotations
import logging

from data_hub_lambda.api_client import DataHubClient
from data_hub_lambda.azure_cielo_qpcr.parse_dye_channels import parse_dye_channels
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
    """Process a single Azure Cielo qPCR file through the Data Hub API.

    For Cq Values CSV files, the unique dye channel names are extracted from
    the ``Fluorescence`` column and stored as run-level metadata.

    Args:
        instrument_id: The kebab-case instrument ID.
        run_id: The run ID (``Experiment_YYYYMMDD`` prefix).
        s3_bucket: The S3 bucket containing the file.
        s3_key: The full S3 object key.
        filename: The original filename (e.g. ``Experiment_20260101_CqValues.csv``).
        client: An authenticated ``DataHubClient`` instance.

    Returns:
        The web app URL for the instrument run.
    """
    logger.info("Processing Azure Cielo qPCR file: %s (run: %s)", filename, run_id)

    client.ensure_run(instrument_id, run_id)

    file_record = client.create_file(
        instrument_id=instrument_id,
        run_id=run_id,
        s3_bucket=s3_bucket,
        s3_key=s3_key,
        filename=filename,
    )
    file_id = file_record.id

    try:
        client.update_file(file_id, status="processing")

        raw_data_dir = config.LOCAL_RAW_DATA_DIRPATH / Instrument.AZURE_CIELO_QPCR.value / run_id
        local_file_path = raw_data_dir / filename
        s3_utils.download_file(f"s3://{s3_bucket}/{s3_key}", local_file_path)
        logger.info("Downloaded %s to %s", filename, local_file_path)

        metadata: dict[str, object] = {}
        if filename.endswith(".csv"):
            dye_channels = parse_dye_channels(local_file_path)
            metadata["dye_channels"] = dye_channels
            logger.info("Parsed dye channels: %s", dye_channels)

        client.update_file(file_id, status="completed", metadata=metadata)
        logger.info("File %s marked as completed.", filename)

    except Exception as e:
        logger.error("Error processing file: %s", e)
        client.update_file(file_id, status="failed", error_message=str(e))
        raise

    return f"{DATA_HUB_WEB_URL}/instruments/{instrument_id}/runs/{run_id}"
