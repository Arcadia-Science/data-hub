"""Process a Unchained Labs Aunty Excel export through the Data Hub API."""

from __future__ import annotations
import logging
from pathlib import Path

from data_hub_lambda.api_client import get_client
from data_hub_lambda.unchained_labs_aunty.utils import (
    parse_aunty_workbook,
    write_curves_csv,
    write_plate_json,
)
from data_hub_shared import s3_utils
from data_hub_shared.config import config

logger = logging.getLogger(__name__)


def process_file(instrument_id: str, run_id: str, filename: str) -> None:
    """Parse an Aunty `.xlsx` into a curves CSV and a plate JSON.

    Args:
        instrument_id: The instrument ID from the S3 key / event.
        run_id: The run ID (filename stem timestamp).
        filename: The original filename (e.g. `Aunty_export_2026-03-15T09-22-11.xlsx`).
    """
    logger.info("Processing Aunty file: %s (run: %s)", filename, run_id)

    client = get_client()
    s3_bucket = config.AWS_S3_RAW_DATA_BUCKET
    s3_key = f"{instrument_id}/{run_id}/{filename}"

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

        parsed = parse_aunty_workbook(local_file_path)
        logger.info(
            "Parsed %d experiments (%d curve rows).",
            len(parsed.experiments),
            len(parsed.curve_rows),
        )

        processed_root = config.LOCAL_PROCESSED_DATA_DIRPATH / instrument_id / run_id
        processed_root.mkdir(parents=True, exist_ok=True)

        csv_filename = f"{run_id}_aunty_curves.csv"
        json_filename = f"{run_id}_aunty_plate.json"
        csv_path = processed_root / csv_filename
        json_path = processed_root / json_filename
        write_curves_csv(csv_path, parsed.curve_rows)
        write_plate_json(json_path, parsed.experiments)

        _upload_processed(
            instrument_id=instrument_id,
            run_id=run_id,
            local_path=csv_path,
            filename=csv_filename,
            content_type="text/csv",
        )
        _upload_processed(
            instrument_id=instrument_id,
            run_id=run_id,
            local_path=json_path,
            filename=json_filename,
            content_type="application/json",
        )

        client.update_run(instrument_id, run_id, metadata=parsed.metadata)
        client.update_file(file_id, status="completed")
        logger.info("File %s marked as completed.", filename)

    except Exception as e:
        logger.error("Error processing file: %s", e)
        client.update_file(file_id, status="failed", error_message=str(e))
        raise


def _upload_processed(
    *,
    instrument_id: str,
    run_id: str,
    local_path: Path,
    filename: str,
    content_type: str,
) -> None:
    client = get_client()
    processed_bucket = config.AWS_S3_PROCESSED_DATA_BUCKET
    s3_key = f"{instrument_id}/{run_id}/{filename}"
    s3_utils.upload_file(local_path, f"s3://{processed_bucket}/{s3_key}")
    logger.info("Uploaded processed file to s3://%s/%s", processed_bucket, s3_key)

    processed_file = client.create_file(
        instrument_id=instrument_id,
        run_id=run_id,
        s3_bucket=processed_bucket or "",
        s3_key=s3_key,
        filename=filename,
        category="processed",
    )
    client.update_file(
        processed_file.id,
        size_bytes=local_path.stat().st_size,
        content_type=content_type,
    )
