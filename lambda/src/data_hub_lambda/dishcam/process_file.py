"""Process DishCam TIFF stacks once `run.json` is also in S3."""

from __future__ import annotations
import logging
from pathlib import Path

from data_hub_lambda.api_client import ApiError, DataHubClient, get_client
from data_hub_lambda.dishcam.encode_video import encode_tiff_stack
from data_hub_lambda.dishcam.filenames import RUN_JSON_NAME, is_tiff, matches_filename
from data_hub_lambda.dishcam.parse_metadata import encode_fps, parse_run_json, playback_fps
from data_hub_lambda.models import FileResponse
from data_hub_shared import s3_utils
from data_hub_shared.config import config

logger = logging.getLogger(__name__)


def process_file(instrument_id: str, run_id: str, filename: str) -> None:
    """Encode each TIFF after both the stack(s) and sidecar exist.

    S3 can notify on a stack or on `run.json` first. If the sibling is
    missing, return without creating a run or flipping status — the later
    event encodes.

    A TIFF event encodes that stack only. A `run.json` event encodes every
    TIFF currently under the run prefix, so a sidecar that lands last still
    produces an MP4 per stack. Later TIFFs encode themselves once the
    sidecar is already in S3.

    Reprocess already marks the trigger `processing`, so a missing sibling
    fails that file instead of leaving it stuck. Successful encodes also
    complete `run.json`: it has no stack of its own, and leaving it in
    `processing` stranded the run after the MP4 was already uploaded.

    TIFF and `run.json` are separate S3 events, so two invocations can
    encode the same stack. `create_file` is idempotent; completed/failed
    updates swallow 409 so the loser does not fail a successful run.
    Duplicate compute is accepted — a lock would need run-level state
    we do not have.
    """
    if not matches_filename(filename):
        logger.info("Ignoring DishCam file %s; not a TIFF or run.json.", filename)
        return

    raw_bucket = config.AWS_S3_RAW_DATA_BUCKET or ""
    json_key = f"{instrument_id}/{run_id}/{RUN_JSON_NAME}"
    json_uri = f"s3://{raw_bucket}/{json_key}"
    tiff_filenames = _tiff_filenames_to_process(raw_bucket, instrument_id, run_id, filename)

    json_exists = s3_utils.object_exists(json_uri)
    if not tiff_filenames or not json_exists:
        missing = "run.json" if not json_exists else "TIFF stack"
        logger.info("DishCam run %s is missing %s; skipping.", run_id, missing)
        _fail_if_processing(
            instrument_id,
            run_id,
            filename,
            f"Cannot process: {missing} not found in S3",
        )
        return

    logger.info(
        "Processing DishCam TIFF%s %s (run: %s)",
        "" if len(tiff_filenames) == 1 else "s",
        ", ".join(tiff_filenames),
        run_id,
    )
    client = get_client()
    client.ensure_run(instrument_id, run_id)

    raw_dir = config.LOCAL_RAW_DATA_DIRPATH / instrument_id / run_id
    local_json = raw_dir / RUN_JSON_NAME
    try:
        s3_utils.download_file(json_uri, local_json)
        metadata = parse_run_json(local_json)
        fps = playback_fps(encode_fps(metadata))
    except Exception as exc:
        logger.error("Error reading DishCam run.json for %s: %s", run_id, exc)
        for tiff_filename in tiff_filenames:
            tiff_key = f"{instrument_id}/{run_id}/{tiff_filename}"
            record = client.create_file(
                instrument_id=instrument_id,
                run_id=run_id,
                s3_bucket=raw_bucket,
                s3_key=tiff_key,
                filename=tiff_filename,
            )
            _update_file_status(client, record.id, "failed", error_message=str(exc))
        _fail_if_processing(instrument_id, run_id, RUN_JSON_NAME, str(exc))
        raise

    sidecar = _sidecar_record(client, instrument_id, run_id)
    # Only bump uploaded/failed → processing. A completed sidecar from a
    # sibling invocation must stay completed so the run does not flicker
    # back to processing during a duplicate encode.
    if sidecar is not None and sidecar.status in {"uploaded", "failed"}:
        _update_file_status(client, sidecar.id, "processing")

    last_error: Exception | None = None
    encoded_any = False
    for tiff_filename in tiff_filenames:
        try:
            _encode_tiff(
                client,
                instrument_id,
                run_id,
                raw_bucket,
                raw_dir,
                tiff_filename,
                fps,
            )
            encoded_any = True
        except Exception as exc:
            logger.error("Error processing DishCam file %s: %s", tiff_filename, exc)
            last_error = exc

    if encoded_any:
        client.update_run(instrument_id, run_id, metadata=metadata)
    # `_encode_tiff` completes stacks only. Reprocess already flipped the
    # sidecar to processing, so leaving it there stranded the run after a
    # successful encode.
    if sidecar is not None and sidecar.status != "completed":
        _update_file_status(client, sidecar.id, "completed")
    if last_error is not None:
        raise last_error


def _tiff_filenames_to_process(
    raw_bucket: str,
    instrument_id: str,
    run_id: str,
    filename: str,
) -> list[str]:
    if is_tiff(filename):
        return [filename]
    return _list_tiff_filenames(raw_bucket, instrument_id, run_id)


def _list_tiff_filenames(raw_bucket: str, instrument_id: str, run_id: str) -> list[str]:
    prefix = f"s3://{raw_bucket}/{instrument_id}/{run_id}/"
    names: list[str] = []
    for uri in sorted(s3_utils.list_objects(prefix)):
        name = uri.rsplit("/", 1)[-1]
        if is_tiff(name):
            names.append(name)
    return names


def _encode_tiff(
    client: DataHubClient,
    instrument_id: str,
    run_id: str,
    raw_bucket: str,
    raw_dir: Path,
    tiff_filename: str,
    fps: float,
) -> None:
    tiff_key = f"{instrument_id}/{run_id}/{tiff_filename}"
    tiff_uri = f"s3://{raw_bucket}/{tiff_key}"
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

        local_tiff = raw_dir / tiff_filename
        s3_utils.download_file(tiff_uri, local_tiff)

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

        if not _update_file_status(client, tiff_id, "completed"):
            logger.info(
                "DishCam file %s already finished by a sibling invocation.",
                tiff_filename,
            )
            return
        logger.info("DishCam file %s marked as completed.", tiff_filename)
    except Exception as exc:
        _update_file_status(client, tiff_id, "failed", error_message=str(exc))
        raise


def _sidecar_record(client: DataHubClient, instrument_id: str, run_id: str) -> FileResponse | None:
    """Return the `run.json` row, or None when the run is not in the API yet."""
    raw_bucket = config.AWS_S3_RAW_DATA_BUCKET or ""
    s3_key = f"{instrument_id}/{run_id}/{RUN_JSON_NAME}"
    try:
        return client.create_file(
            instrument_id=instrument_id,
            run_id=run_id,
            s3_bucket=raw_bucket,
            s3_key=s3_key,
            filename=RUN_JSON_NAME,
        )
    except ApiError as exc:
        if exc.status_code == 404:
            return None
        raise


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


def _update_file_status(
    client: DataHubClient,
    file_id: int,
    status: str,
    *,
    error_message: str | None = None,
) -> bool:
    """Set status. Return False if another invocation already moved the file."""
    try:
        client.update_file(file_id, status=status, error_message=error_message)
    except ApiError as exc:
        if exc.status_code == 409:
            logger.info(
                "File %s status conflict when setting %s (sibling encode likely won).",
                file_id,
                status,
            )
            return False
        raise
    return True


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
