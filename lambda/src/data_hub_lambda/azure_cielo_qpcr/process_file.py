from __future__ import annotations
import logging
from pathlib import Path

from data_hub_lambda.api_client import get_client
from data_hub_lambda.azure_cielo_qpcr.melting_curve import (
    is_melting_curve_filename,
    parse_melting_curve_file,
    write_plate_json,
    write_tidy_csv,
)
from data_hub_lambda.azure_cielo_qpcr.parse_dye_channels import (
    is_cq_values_filename,
    parse_dye_channels,
)
from data_hub_shared import s3_utils
from data_hub_shared.config import config

logger = logging.getLogger(__name__)


def process_file(instrument_id: str, run_id: str, filename: str) -> None:
    """Process a single Azure Cielo qPCR file through the Data Hub API.

    Melting curves and Cq Values are parsed; other CSVs and PDFs complete as a no-op.
    Melt-curve passes skip `update_run` so they cannot wipe dye channels.
    """
    logger.info("Processing Azure Cielo qPCR file: %s (run: %s)", filename, run_id)

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

        if is_melting_curve_filename(filename):
            local_file_path = _download_raw(s3_bucket, s3_key, instrument_id, run_id, filename)
            parsed = parse_melting_curve_file(local_file_path)
            logger.info(
                "Parsed melting curve: %d channels, %d tidy rows.",
                len(parsed.blocks),
                len(parsed.tidy_rows),
            )

            processed_root = config.LOCAL_PROCESSED_DATA_DIRPATH / instrument_id / run_id
            processed_root.mkdir(parents=True, exist_ok=True)

            csv_filename = f"{run_id}_melting_curve_derivatives.csv"
            json_filename = f"{run_id}_melting_curve_plate.json"
            csv_path = processed_root / csv_filename
            json_path = processed_root / json_filename
            write_tidy_csv(csv_path, parsed.tidy_rows)
            write_plate_json(json_path, parsed.plate)

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
        elif filename.lower().endswith(".pdf"):
            logger.info("qPCR report %s has no preprocessing.", filename)
        elif filename.lower().endswith(".csv"):
            local_file_path = _download_raw(s3_bucket, s3_key, instrument_id, run_id, filename)
            try:
                dye_channels = parse_dye_channels(local_file_path)
            except Exception as exc:
                if is_cq_values_filename(filename):
                    raise
                logger.info("Skipping qPCR CSV %s: %s", filename, exc)
            else:
                client.update_run(instrument_id, run_id, metadata={"dye_channels": dye_channels})
                logger.info("Parsed dye channels: %s", dye_channels)
        else:
            logger.info("Skipping qPCR file %s; not a PDF or melting curve.", filename)

        client.update_file(file_id, status="completed")
        logger.info("File %s marked as completed.", filename)

    except Exception as e:
        logger.error("Error processing file: %s", e)
        client.update_file(file_id, status="failed", error_message=str(e))
        raise


def _download_raw(
    s3_bucket: str | None,
    s3_key: str,
    instrument_id: str,
    run_id: str,
    filename: str,
) -> Path:
    raw_data_dir = config.LOCAL_RAW_DATA_DIRPATH / instrument_id / run_id
    local_file_path = raw_data_dir / filename
    s3_utils.download_file(f"s3://{s3_bucket}/{s3_key}", local_file_path)
    logger.info("Downloaded %s to %s", filename, local_file_path)
    return local_file_path


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
