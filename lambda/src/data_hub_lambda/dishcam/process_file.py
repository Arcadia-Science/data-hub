"""Process a DishCam TIFF stack once its `run.json` sidecar is also in S3."""

from __future__ import annotations
import logging
from pathlib import Path

from data_hub_lambda.api_client import ApiError, DataHubClient, get_client
from data_hub_lambda.dishcam.encode_video import encode_tiff_stack
from data_hub_lambda.dishcam.filenames import RUN_JSON_NAME, is_tiff, matches_filename
from data_hub_lambda.dishcam.parse_metadata import encode_fps, parse_run_json
from data_hub_shared import s3_utils
from data_hub_shared.config import config

logger = logging.getLogger(__name__)


def process_file(instrument_id: str, run_id: str, filename: str) -> None:
    """Encode the run's TIFF after both the stack and sidecar exist.

    S3 can notify on either file first. If the sibling is missing, return
    without creating a run or flipping status — the later event encodes.
    Reprocess already marks the trigger `processing`, so a missing sibling
    fails that file instead of leaving it stuck.
    """
    if not matches_filename(filename):
        logger.info("Ignoring DishCam file %s; not a TIFF or run.json.", filename)
        return

    raw_bucket = config.AWS_S3_RAW_DATA_BUCKET or ""
    json_key = f"{instrument_id}/{run_id}/{RUN_JSON_NAME}"
    json_uri = f"s3://{raw_bucket}/{json_key}"
    tiff_filename = _resolve_tiff_filename(raw_bucket, instrument_id, run_id, filename)

    json_exists = s3_utils.object_exists(json_uri)
    if tiff_filename is None or not json_exists:
        missing = "run.json" if not json_exists else "TIFF stack"
        logger.info("DishCam run %s is missing %s; skipping.", run_id, missing)
        _fail_if_processing(
            instrument_id,
            run_id,
            filename,
            f"Cannot process: {missing} not found in S3",
        )
        return

    tiff_key = f"{instrument_id}/{run_id}/{tiff_filename}"
    tiff_uri = f"s3://{raw_bucket}/{tiff_key}"
    if not s3_utils.object_exists(tiff_uri):
        logger.info("DishCam run %s is missing TIFF stack; skipping.", run_id)
        _fail_if_processing(
            instrument_id,
            run_id,
            filename,
            "Cannot process: TIFF stack not found in S3",
        )
        return

    logger.info("Processing DishCam TIFF %s (run: %s)", tiff_filename, run_id)
    client = get_client()
    client.ensure_run(instrument_id, run_id)

    tiff_record = client.create_file(
        instrument_id=instrument_id,
        run_id=run_id,
        s3_bucket=raw_bucket,
        s3_key=tiff_key,
        filename=tiff_filename,
    )
    tiff_id = tiff_record.id

    try:
        client.update_file(tiff_id, status="processing")

        raw_dir = config.LOCAL_RAW_DATA_DIRPATH / instrument_id / run_id
        local_tiff = raw_dir / tiff_filename
        local_json = raw_dir / RUN_JSON_NAME
        s3_utils.download_file(tiff_uri, local_tiff)
        s3_utils.download_file(json_uri, local_json)

        metadata = parse_run_json(local_json)
        fps = encode_fps(metadata)

        mp4_path = raw_dir / f"{Path(tiff_filename).stem}.mp4"
        poster_path = raw_dir / f"{Path(tiff_filename).stem}.jpg"
        encode_tiff_stack(local_tiff, mp4_path, poster_path, fps)

        processed_bucket = config.AWS_S3_PROCESSED_DATA_BUCKET or ""
        _upload_processed(
            client,
            instrument_id,
            run_id,
            processed_bucket,
            mp4_path,
            "video/mp4",
        )
        _upload_processed(
            client,
            instrument_id,
            run_id,
            processed_bucket,
            poster_path,
            "image/jpeg",
        )

        client.update_run(instrument_id, run_id, metadata=metadata)
        client.update_file(tiff_id, status="completed")
        logger.info("DishCam file %s marked as completed.", tiff_filename)
    except Exception as exc:
        logger.error("Error processing DishCam file: %s", exc)
        client.update_file(tiff_id, status="failed", error_message=str(exc))
        raise


def _resolve_tiff_filename(
    raw_bucket: str,
    instrument_id: str,
    run_id: str,
    filename: str,
) -> str | None:
    if is_tiff(filename):
        return filename
    prefix = f"s3://{raw_bucket}/{instrument_id}/{run_id}/"
    uris = sorted(s3_utils.list_objects(prefix))
    for uri in uris:
        name = uri.rsplit("/", 1)[-1]
        if is_tiff(name):
            return name
    return None


def _upload_processed(
    client: DataHubClient,
    instrument_id: str,
    run_id: str,
    processed_bucket: str,
    local_path: Path,
    content_type: str,
) -> None:
    s3_key = f"{instrument_id}/{run_id}/{local_path.name}"
    s3_utils.upload_file(local_path, f"s3://{processed_bucket}/{s3_key}")
    processed = client.create_file(
        instrument_id=instrument_id,
        run_id=run_id,
        s3_bucket=processed_bucket,
        s3_key=s3_key,
        filename=local_path.name,
        category="processed",
    )
    client.update_file(
        processed.id,
        size_bytes=local_path.stat().st_size,
        content_type=content_type,
    )


def _fail_if_processing(
    instrument_id: str,
    run_id: str,
    filename: str,
    error_message: str,
) -> None:
    """Fail a reprocess that is already `processing` when a sibling is missing."""
    raw_bucket = config.AWS_S3_RAW_DATA_BUCKET or ""
    s3_key = f"{instrument_id}/{run_id}/{filename}"
    try:
        client = get_client()
        record = client.create_file(
            instrument_id=instrument_id,
            run_id=run_id,
            s3_bucket=raw_bucket,
            s3_key=s3_key,
            filename=filename,
        )
    except ApiError as exc:
        if exc.status_code == 404:
            return
        raise
    if record.status == "processing":
        client.update_file(record.id, status="failed", error_message=error_message)
