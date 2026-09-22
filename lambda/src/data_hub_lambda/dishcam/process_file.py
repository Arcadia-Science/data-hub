"""Process DishCam TIFF stacks once `run.json` is also in S3."""

from __future__ import annotations
import logging
from pathlib import Path
from typing import Any

from data_hub_lambda.api_client import ApiError, DataHubClient, get_client
from data_hub_lambda.dishcam.encode_video import encode_tiff_stack
from data_hub_lambda.dishcam.filenames import RUN_JSON_NAME, is_run_json, is_tiff, matches_filename
from data_hub_lambda.dishcam.parse_metadata import encode_fps, parse_run_json, playback_fps
from data_hub_lambda.models import FileResponse, RunDetailFile, RunDetailResponse
from data_hub_shared import s3_utils
from data_hub_shared.config import config

logger = logging.getLogger(__name__)

# Bytes are in S3. `detected` is still on the instrument PC. The triggering
# file counts as present anyway: the S3 event is the proof it landed.
_IN_S3_STATUSES = {"uploaded", "processing", "completed", "failed"}


def process_file(instrument_id: str, run_id: str, filename: str) -> None:
    """Encode each TIFF after both the stack(s) and sidecar exist.

    S3 can notify on a stack or on `run.json` first. If the sibling is
    missing, return without creating a run or flipping status — the later
    event encodes.

    A TIFF event encodes that stack only. A sidecar event encodes every
    TIFF in the same folder, so a sidecar that lands last still produces
    an MP4 per stack. Later TIFFs encode themselves once that folder's
    sidecar is in S3.

    The folder comes from the run's file list, not from the S3 prefix.
    A stack uses the sidecar from its own folder. A folder with no sidecar
    of its own falls back to the plain `run.json`, which is what older
    watchers stored for every capture. A plain `run.json` event also encodes
    stacks in those folders. Only that plain sidecar writes run metadata.

    Reprocess already marks the trigger `processing`, so a missing sibling
    fails that file instead of leaving it stuck. A parsed sidecar is
    completed even if a stack failed: it has no stack of its own, and
    leaving it in `processing` stranded the run. Stack status, not the
    sidecar, decides whether the run looks failed.

    TIFF and `run.json` are separate S3 events, so two invocations can
    encode the same stack. The `run.json` batch skips stacks that are
    already completed or processing: `completed → processing` is a legal
    transition, and a later disk-full failure would otherwise reopen a
    sibling's success and mark it failed. A stack left in `processing`
    after a timeout is retried by reprocessing that TIFF, not another
    `run.json` batch. A TIFF-triggered invoke always encodes that stack.
    completed/failed updates swallow 409 so the loser does not fail a
    successful run.

    Run metadata is written from the plain `run.json` even when every stack
    is skipped, so a corrected sidecar still updates the run. A renamed
    sidecar updates only the stacks in its own folder.

    High-quality stacks are a few GB and Lambda `/tmp` is capped, so each
    encode deletes its local TIFF/MP4/JPEG before the next stack.
    """
    if not matches_filename(filename):
        logger.info("Ignoring DishCam file %s; not a TIFF or run.json.", filename)
        return

    raw_bucket = config.AWS_S3_RAW_DATA_BUCKET or ""
    client = get_client()
    # File rows say which sidecar belongs to which folder. A 404 means the
    # S3 event arrived first; the objects are still flat under the run prefix.
    run_files = _load_run_files(client, instrument_id, run_id)
    if run_files is None:
        group = _s3_flat_group(raw_bucket, instrument_id, run_id, filename)
    else:
        group = _capture_group(run_files, filename)
    if group is None:
        missing = (
            "no uploaded run.json for this stack's folder"
            if is_tiff(filename)
            else "no uploaded TIFF stack in this run.json's folder"
        )
        logger.info("Skipping DishCam run %s: %s.", run_id, missing)
        _fail_if_processing(
            instrument_id,
            run_id,
            filename,
            f"Cannot process: {missing}",
        )
        return
    sidecar_row, tiff_filenames = group
    json_uri = _object_uri(raw_bucket, sidecar_row, instrument_id, run_id)

    logger.info(
        "Processing DishCam TIFF%s %s (run: %s)",
        "" if len(tiff_filenames) == 1 else "s",
        ", ".join(tiff_filenames),
        run_id,
    )
    client.ensure_run(instrument_id, run_id)

    raw_dir = config.LOCAL_RAW_DATA_DIRPATH / instrument_id / run_id
    local_json = raw_dir / sidecar_row.filename
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
            _fail_file(client, record, str(exc))
        _fail_file(client, _sidecar_record(client, instrument_id, run_id, sidecar_row), str(exc))
        raise

    sidecar = _sidecar_record(client, instrument_id, run_id, sidecar_row)
    # Only bump uploaded/failed → processing. A completed sidecar from a
    # sibling invocation must stay completed so the run does not flicker
    # back to processing during a duplicate encode.
    if sidecar.status in {"uploaded", "failed"}:
        _update_file_status(client, sidecar.id, "processing")

    last_error: Exception | None = None
    owned = is_tiff(filename)
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
                metadata,
                owned=owned,
            )
        except Exception as exc:
            logger.error("Error processing DishCam file %s: %s", tiff_filename, exc)
            last_error = exc

    # A tagged sidecar belongs to one folder. Writing it onto the run would
    # replace settings from whichever capture finished last.
    if sidecar_row.filename.lower() == RUN_JSON_NAME:
        client.update_run(instrument_id, run_id, metadata=metadata)
    # The sidecar parsed; complete it even if a stack failed. Do not let a
    # status PATCH hide the encode error the caller should see.
    if sidecar.status != "completed":
        try:
            _update_file_status(client, sidecar.id, "completed")
        except Exception:
            logger.exception("Failed to complete DishCam run.json for %s.", run_id)
            if last_error is None:
                raise
    if last_error is not None:
        raise last_error


def _load_run_files(
    client: DataHubClient,
    instrument_id: str,
    run_id: str,
) -> list[RunDetailFile] | None:
    """Return the run's raw files, or None when the run does not exist yet.

    Dismissed rows and processed MP4/JPEG artifacts can reuse a raw name.
    Pairing only active raw rows keeps them out of the match.
    """
    try:
        detail: RunDetailResponse = client.get_run(instrument_id, run_id)
    except ApiError as exc:
        if exc.status_code == 404:
            return None
        raise
    return [row for row in detail.files if row.deleted_at is None and row.category == "raw"]


def _s3_flat_group(
    raw_bucket: str,
    instrument_id: str,
    run_id: str,
    filename: str,
) -> tuple[RunDetailFile, list[str]] | None:
    """Pair a flat S3 prefix the way DishCam did before folder records existed.

    The sidecar is `{instrument}/{run}/run.json` unless the event itself is
    a renamed sidecar. TIFF names are the basenames directly under the prefix.
    """
    sidecar_name = filename if is_run_json(filename) else "run.json"
    json_key = f"{instrument_id}/{run_id}/{sidecar_name}"
    if not s3_utils.object_exists(f"s3://{raw_bucket}/{json_key}"):
        return None
    tiff_filenames = (
        [filename] if is_tiff(filename) else _list_tiff_filenames(raw_bucket, instrument_id, run_id)
    )
    if not tiff_filenames:
        return None
    sidecar = RunDetailFile(
        id=0,
        filename=sidecar_name,
        s3_key=json_key,
        category="raw",
        status="uploaded",
    )
    return sidecar, tiff_filenames


def _list_tiff_filenames(raw_bucket: str, instrument_id: str, run_id: str) -> list[str]:
    prefix = f"s3://{raw_bucket}/{instrument_id}/{run_id}/"
    names: list[str] = []
    for uri in sorted(s3_utils.list_objects(prefix)):
        name = uri.rsplit("/", 1)[-1]
        if is_tiff(name):
            names.append(name)
    return names


def _folder(file: RunDetailFile) -> str:
    path = file.relative_path or file.filename
    slash = path.rfind("/")
    if slash < 0:
        return ""
    return path[:slash]


def _bytes_ready(file: RunDetailFile, *, triggered: bool) -> bool:
    if triggered or file.s3_key:
        return True
    return file.status in _IN_S3_STATUSES


def _ready_rows(rows: list[RunDetailFile], trigger: RunDetailFile | None) -> list[RunDetailFile]:
    return [
        row
        for row in rows
        if _bytes_ready(row, triggered=trigger is not None and row.filename == trigger.filename)
    ]


def _uploaded_tiffs(run_files: list[RunDetailFile], folder: str) -> list[str]:
    return sorted(
        row.filename
        for row in run_files
        if is_tiff(row.filename) and _folder(row) == folder and _bytes_ready(row, triggered=False)
    )


def _capture_group(
    run_files: list[RunDetailFile],
    filename: str,
) -> tuple[RunDetailFile, list[str]] | None:
    """Sidecar and TIFF names for the capture `filename` belongs to.

    A folder with its own sidecar waits for that sidecar. A folder with
    none uses the plain `run.json`. A plain `run.json` event also encodes
    stacks sitting in folders that have no sidecar row.
    """
    trigger = next((row for row in run_files if row.filename == filename), None)
    folder = _folder(trigger) if trigger is not None else ""
    own_sidecars = [
        row for row in run_files if is_run_json(row.filename) and _folder(row) == folder
    ]
    if own_sidecars:
        ready = _ready_rows(own_sidecars, trigger)
    else:
        ready = _ready_rows(
            [row for row in run_files if row.filename.lower() == RUN_JSON_NAME],
            trigger,
        )
    if not ready:
        return None
    sidecar = ready[0]

    if is_tiff(filename):
        tiff_filenames = [filename]
    elif filename.lower() == RUN_JSON_NAME:
        covered = {_folder(row) for row in run_files if is_run_json(row.filename)}
        orphans = [
            row.filename
            for row in run_files
            if is_tiff(row.filename)
            and _folder(row) not in covered
            and _bytes_ready(row, triggered=False)
        ]
        tiff_filenames = sorted(set(_uploaded_tiffs(run_files, folder) + orphans))
    else:
        tiff_filenames = _uploaded_tiffs(run_files, folder)
    if not tiff_filenames:
        return None
    return sidecar, tiff_filenames


def _object_uri(
    bucket: str,
    file: RunDetailFile,
    instrument_id: str,
    run_id: str,
) -> str:
    key = file.s3_key or f"{instrument_id}/{run_id}/{file.filename}"
    return f"s3://{bucket}/{key}"


def _encode_tiff(
    client: DataHubClient,
    instrument_id: str,
    run_id: str,
    raw_bucket: str,
    raw_dir: Path,
    tiff_filename: str,
    fps: float,
    metadata: dict[str, Any],
    *,
    owned: bool,
) -> bool:
    """Encode one stack. Return True if this invoke produced an MP4.

    `owned` is True when the S3/reprocess trigger is this TIFF, so a
    duplicate event or an intentional retry still runs. The `run.json`
    batch passes False and leaves in-flight and finished stacks alone. A
    stack stuck in `processing` after a timeout is retried by
    reprocessing that TIFF, not another `run.json` batch.
    """
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
    local_tiff = raw_dir / tiff_filename
    mp4_path = raw_dir / f"{Path(tiff_filename).stem}.mp4"
    poster_path = raw_dir / f"{Path(tiff_filename).stem}.jpg"

    if not owned and tiff_record.status in {"completed", "processing"}:
        # A corrected sidecar should still land on a stack this batch
        # does not re-encode. In-flight encodes keep the metadata they
        # already parsed.
        if tiff_record.status == "completed":
            client.update_file(tiff_id, metadata=metadata)
        logger.info(
            "Skipping DishCam file %s; already %s.",
            tiff_filename,
            tiff_record.status,
        )
        return False

    try:
        client.update_file(tiff_id, status="processing")

        s3_utils.download_file(tiff_uri, local_tiff)
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

        if not _update_file_status(client, tiff_id, "completed", metadata=metadata):
            logger.info(
                "DishCam file %s already finished by a sibling invocation.",
                tiff_filename,
            )
            return True
        logger.info("DishCam file %s marked as completed.", tiff_filename)
        return True
    except Exception as exc:
        _update_file_status(client, tiff_id, "failed", error_message=str(exc))
        raise
    finally:
        # One high-quality stack can be several GB; leaving it on disk
        # fills the Lambda `/tmp` cap before the next stack in the batch.
        _remove_local(local_tiff, mp4_path, poster_path)


def _remove_local(*paths: Path) -> None:
    for path in paths:
        path.unlink(missing_ok=True)


def _sidecar_record(
    client: DataHubClient,
    instrument_id: str,
    run_id: str,
    sidecar: RunDetailFile,
) -> FileResponse:
    """Return the sidecar row. The run already exists via `ensure_run`.

    The stored name may be `run~<hash>.json` when another folder already
    took `run.json`. Creating by that name adopts the watcher row instead
    of a second plain `run.json`.
    """
    raw_bucket = config.AWS_S3_RAW_DATA_BUCKET or ""
    return client.create_file(
        instrument_id=instrument_id,
        run_id=run_id,
        s3_bucket=raw_bucket,
        s3_key=sidecar.s3_key or f"{instrument_id}/{run_id}/{sidecar.filename}",
        filename=sidecar.filename,
    )


def _fail_file(client: DataHubClient, record: FileResponse, error_message: str) -> None:
    """Mark failed. Terminal and `uploaded` states must go through `processing` first."""
    if record.status != "processing":
        _update_file_status(client, record.id, "processing")
    _update_file_status(client, record.id, "failed", error_message=error_message)


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
    metadata: dict[str, Any] | None = None,
) -> bool:
    """Set status. Return False if another invocation already moved the file."""
    try:
        client.update_file(
            file_id,
            status=status,
            error_message=error_message,
            metadata=metadata,
        )
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
