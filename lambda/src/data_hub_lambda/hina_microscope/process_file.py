from __future__ import annotations
import logging
from pathlib import Path

from data_hub_lambda.api_client import get_client
from data_hub_lambda.hina_microscope.image_processing import ND2Processor, TimelapseVideo
from data_hub_lambda.hina_microscope.parse_metadata import parse_metadata
from data_hub_lambda.processed_files import upload_processed
from data_hub_lambda.raw_access import local_raw_file
from data_hub_shared.config import config

logger = logging.getLogger(__name__)


class TimelapseVideoError(Exception):
    """The still preview is registered, but the timelapse MP4 could not be made."""

    def __init__(self, reason: str) -> None:
        super().__init__(
            f"Couldn't make the timelapse video: {reason.rstrip('.')}. "
            "The still preview is still available."
        )


def process_file(instrument_id: str, run_id: str, filename: str) -> None:
    """Process a single Hina microscope ND2 file through the Data Hub API.

    Opens the raw ND2 with `local_raw_file`, from the mount when it is
    large, renders the first time point as a composite JPG overlay, uploads
    it to the processed bucket, and registers it via the API. Run-level
    metadata (sizes, channels, dimensions) is parsed and stored once per
    run — the first file to arrive wins. Subsequent files in the same run
    still get a JPG but skip the metadata step.

    A file with more than one time point also gets `{stem}.mp4`, with the
    JPG as its poster. Its frame count and timing go in the raw file's
    metadata. If the encode fails, the file is marked failed and the JPG
    stays.

    Args:
        instrument_id: The instrument ID from the S3 key / event.
        run_id: The run ID (grouping key for files in a single imaging session).
        filename: The original filename (e.g. `well_A1_xy01.nd2`).
    """
    logger.info("Processing Hina microscope file: %s (run: %s)", filename, run_id)

    client = get_client()
    s3_bucket = config.AWS_S3_RAW_DATA_BUCKET
    s3_key = f"{instrument_id}/{run_id}/{filename}"

    run = client.ensure_run(instrument_id, run_id)

    file_record = client.create_file(
        instrument_id=instrument_id,
        run_id=run_id,
        s3_bucket=s3_bucket or "",
        s3_key=s3_key,
        filename=filename,
    )
    file_id = file_record.id

    output_dir = config.LOCAL_PROCESSED_DATA_DIRPATH / instrument_id / run_id
    # A reused Lambda container keeps `/tmp`, so remove the previews even
    # when an upload or the encode fails part way.
    stem = Path(filename).stem
    local_outputs = [output_dir / f"{stem}.jpg", output_dir / f"{stem}.mp4"]

    try:
        client.update_file(file_id, status="processing")

        processed_bucket = config.AWS_S3_PROCESSED_DATA_BUCKET or ""
        raw_data_dir = config.LOCAL_RAW_DATA_DIRPATH / instrument_id / run_id
        video: TimelapseVideo | None = None
        with local_raw_file(s3_bucket or "", s3_key, raw_data_dir, streams=True) as local_file_path:
            processor = ND2Processor(local_file_path)
            processor.load()
            jpg_file_path = processor.export_jpg(output_dir=output_dir)
            upload_processed(
                client, instrument_id, run_id, processed_bucket, jpg_file_path, "image/jpeg"
            )
            logger.info("Uploaded processed image %s", jpg_file_path.name)

            # Run-level metadata is deterministic for a Hina run (same channels,
            # sizes, dimensions across every .nd2 file in the run) so we only
            # parse and store it once — on the first file to arrive.
            # `ensure_run` returns the metadata stored when this file started.
            # Files that start before the first one finishes, as in a whole-run
            # reprocess, also see none and each write their own.
            if not run.metadata:
                metadata = parse_metadata(processor.image)
                client.update_run(instrument_id, run_id, metadata=metadata)
                logger.info("Parsed and stored run-level metadata for %s", run_id)
            else:
                logger.info("Run %s already has metadata; skipping metadata step.", run_id)

            try:
                video = processor.export_mp4(output_dir=output_dir)
            except Exception as exc:
                raise TimelapseVideoError(str(exc)) from exc
            if video is not None:
                upload_processed(
                    client, instrument_id, run_id, processed_bucket, video.path, "video/mp4"
                )
                logger.info("Uploaded timelapse video %s", video.path.name)

        if video is None:
            client.update_file(file_id, status="completed")
        else:
            client.update_file(
                file_id,
                status="completed",
                metadata={
                    "frames": video.frames,
                    "frame_interval_ms": video.frame_interval_ms,
                    "playback_fps": video.playback_fps,
                },
            )
        logger.info("File %s marked as completed.", filename)

    except Exception as e:
        logger.error("Error processing file: %s", e)
        client.update_file(file_id, status="failed", error_message=str(e))
        raise
    finally:
        for path in local_outputs:
            path.unlink(missing_ok=True)
