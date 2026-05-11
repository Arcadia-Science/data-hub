from __future__ import annotations
import logging

from data_hub_lambda.api_client import get_client
from data_hub_lambda.epson_v700_scanner.image_processing import TiffProcessor
from data_hub_shared import s3_utils
from data_hub_shared.config import config
from data_hub_shared.enums import Instrument

logger = logging.getLogger(__name__)

INSTRUMENT_ID = Instrument.EPSON_V700_SCANNER.value


def process_file(run_id: str, filename: str) -> None:
    """Process a single Epson V700 Scanner file through the Data Hub API.

    Downloads the raw TIFF, resizes it to a web-friendly JPEG, uploads the
    JPEG to the processed S3 bucket, extracts TIFF metadata, and registers
    both files via the API.

    Args:
        run_id: The run ID.
        filename: The original filename (e.g. ``scan_001.tif``).
    """
    logger.info("Processing Epson V700 Scanner file: %s (run: %s)", filename, run_id)

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

        processor = TiffProcessor(local_file_path)
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

        metadata = processor.parse_metadata()

        plate_crops = processor.crop_plates()
        if plate_crops:
            from data_hub_lambda.epson_v700_scanner.colony_detection import (
                detect_colonies,
                draw_colony_overlay,
                export_colony_csv,
                export_colony_overlay,
            )

            colony_summaries = []
            dataframes = []
            for i, crop in enumerate(plate_crops):
                result = detect_colonies(crop)
                colony_summaries.append(result.summary())
                dataframes.append(result.to_dataframe(plate_index=i + 1))

                overlay = draw_colony_overlay(crop, result.mask)
                overlay_name = f"{processor.path.stem}_plate{i + 1}_colonies.jpg"
                overlay_path = export_colony_overlay(overlay, raw_data_dir / overlay_name)
                overlay_s3_key = f"{INSTRUMENT_ID}/{run_id}/{overlay_name}"
                s3_utils.upload_file(overlay_path, f"s3://{processed_bucket}/{overlay_s3_key}")
                overlay_file = client.create_file(
                    instrument_id=INSTRUMENT_ID,
                    run_id=run_id,
                    s3_bucket=processed_bucket or "",
                    s3_key=overlay_s3_key,
                    filename=overlay_name,
                    category="processed",
                )
                client.update_file(
                    overlay_file.id,
                    size_bytes=overlay_path.stat().st_size,
                    content_type="image/jpeg",
                )

            csv_name = f"{processor.path.stem}_colonies.csv"
            csv_path = export_colony_csv(dataframes, raw_data_dir / csv_name)
            csv_s3_key = f"{INSTRUMENT_ID}/{run_id}/{csv_name}"
            s3_utils.upload_file(csv_path, f"s3://{processed_bucket}/{csv_s3_key}")
            csv_file = client.create_file(
                instrument_id=INSTRUMENT_ID,
                run_id=run_id,
                s3_bucket=processed_bucket or "",
                s3_key=csv_s3_key,
                filename=csv_name,
                category="processed",
            )
            client.update_file(
                csv_file.id,
                size_bytes=csv_path.stat().st_size,
                content_type="text/csv",
            )

            metadata["colony_detection"] = colony_summaries
            logger.info(
                "Colony detection complete for %d plate(s): %s",
                len(plate_crops),
                [r["colony_count"] for r in colony_summaries],
            )

        logger.info("Parsed metadata: %s", metadata)

        client.update_run(INSTRUMENT_ID, run_id, metadata=metadata)
        client.update_file(file_id, status="completed")
        logger.info("File %s marked as completed.", filename)

    except Exception as e:
        logger.error("Error processing file: %s", e)
        client.update_file(file_id, status="failed", error_message=str(e))
        raise
