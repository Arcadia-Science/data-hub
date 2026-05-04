from __future__ import annotations
import hmac
import json
import re
import shutil
import warnings
from dataclasses import dataclass
from pprint import pformat
from typing import Any
from urllib.parse import quote, unquote_plus

from aws_lambda_typing.context import Context
from aws_lambda_typing.events.s3 import S3Event

from data_hub_lambda import (
    agilent_4150_tapestation,
    akta_fplc,
    archive_builder,
    azure_600_gel_doc,
    azure_cielo_qpcr,
    hina_microscope,
    spectramax_plate_reader,
)
from data_hub_shared import slack
from data_hub_shared.constants import INSTRUMENT_ID_TO_NAME_MAP
from data_hub_shared.enums import Instrument
from data_hub_shared.logger import get_named_logger

logger = get_named_logger(__name__)

warnings.filterwarnings("ignore", category=DeprecationWarning)


# ------------------------------------------------------------------
# S3 event parsing
# ------------------------------------------------------------------


@dataclass
class S3EventInfo:
    """Parsed fields from an S3 event record."""

    instrument_id: str
    run_id: str
    s3_bucket: str
    s3_key: str
    filename: str


def parse_s3_event(event: S3Event) -> S3EventInfo:
    """Parses instrument ID, run ID, and file details from an S3 event.

    Returns:
        An `S3EventInfo` with all fields populated.

    Raises:
        ValueError: If the event payload is malformed or the instrument is unsupported.
    """
    record = event["Records"][0]
    if not record:
        raise ValueError("No records found in event payload.")

    s3_bucket: str = record["s3"]["bucket"]["name"]  # type: ignore[index]
    s3_key: str = unquote_plus(record["s3"]["object"]["key"])  # type: ignore[index]

    # S3 key layout: {instrument_id}/{run_id}/{filename}
    pattern = r"^/?([^/]+)/([^/]+)/([^/]+)$"
    match = re.match(pattern, s3_key)
    if not match:
        raise ValueError(f"Object key does not match expected pattern: {s3_key}")

    instrument_id = match.group(1)
    run_id = match.group(2)
    filename = match.group(3)

    if instrument_id not in {member.value for member in Instrument}:
        raise ValueError(f"This instrument is not currently supported: {instrument_id}")

    return S3EventInfo(
        instrument_id=instrument_id,
        run_id=run_id,
        s3_bucket=s3_bucket,
        s3_key=s3_key,
        filename=filename,
    )


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------


def get_cloudwatch_logs_url(context: Context) -> str:
    """Generates the CloudWatch logs URL for the current Lambda execution."""
    arn_parts = context.invoked_function_arn.split(":")
    region = arn_parts[3] if len(arn_parts) > 3 else "us-east-1"
    log_group_encoded = quote(context.log_group_name, safe="")
    log_stream_encoded = quote(context.log_stream_name, safe="")
    base_url = f"https://{region}.console.aws.amazon.com/cloudwatch/home"
    logs_path = f"log-groups/log-group/{log_group_encoded}/log-events/{log_stream_encoded}"
    return f"{base_url}?region={region}#logsV2:{logs_path}"


# ------------------------------------------------------------------
# Function URL helpers
# ------------------------------------------------------------------


def _is_function_url_event(event: dict[str, Any]) -> bool:
    return "requestContext" in event and "http" in event.get("requestContext", {})


def _authenticate_function_url(event: dict[str, Any]) -> dict[str, Any] | None:
    """Verify the Bearer token on a Function URL invocation.

    Returns the parsed S3 event payload on success, or ``None`` if
    authentication fails (the caller should return a 401 response).
    """
    from data_hub_lambda.config import lambda_config

    expected = lambda_config.LAMBDA_INVOKE_TOKEN
    if not expected:
        logger.error("LAMBDA_INVOKE_TOKEN is not configured")
        return None

    headers: dict[str, str] = event.get("headers", {})
    auth_header = headers.get("authorization", "")
    if not auth_header.startswith("Bearer "):
        return None

    token = auth_header[len("Bearer ") :]
    if not hmac.compare_digest(token, expected):
        return None

    body = event.get("body", "")
    if event.get("isBase64Encoded"):
        import base64

        body = base64.b64decode(body).decode()

    try:
        return json.loads(body)  # type: ignore[no-any-return]
    except (json.JSONDecodeError, TypeError):
        logger.error("Function URL body is not valid JSON")
        return None


# ------------------------------------------------------------------
# Ephemeral storage cleanup
# ------------------------------------------------------------------


def _cleanup_tmp() -> None:
    """Remove downloaded/processed files so warm containers don't run out of /tmp space."""
    from data_hub_shared.config import config

    data_dir = config.LOCAL_DATA_DIRPATH
    if data_dir.exists():
        shutil.rmtree(data_dir, ignore_errors=True)
        logger.info("Cleaned up %s", data_dir)


# ------------------------------------------------------------------
# Archive-build dispatch
# ------------------------------------------------------------------


def _archive_error_response(status_code: int, message: str) -> dict[str, Any]:
    """Shape a JSON error response for the build_archive Function URL path.

    Centralised so the ``Content-Type`` header stays consistent with the
    success response — the web app reads the body as JSON regardless of the
    status code.
    """
    return {
        "statusCode": status_code,
        "headers": {"content-type": "application/json"},
        "body": json.dumps({"error": message}),
    }


def _handle_build_archive(payload: dict[str, Any]) -> dict[str, Any]:
    """Run the archive builder and (optionally) PATCH the originating job.

    Sync callers (``payload["job_id"]`` absent) get the build result inline.
    Async callers send ``"job_id"`` so the web-app job row gets PATCHed when
    the build finishes — the HTTP response is the ack of acceptance and the
    actual outcome is delivered out-of-band.
    """
    from data_hub_lambda.config import lambda_config
    from data_hub_shared.config import config

    job_id = payload.get("job_id")
    # Build the source-bucket allow-list from the Lambda's configured raw +
    # processed bucket env vars. Both are set by SAM (`AWS_S3_RAW_DATA_BUCKET`
    # / `AWS_S3_PROCESSED_DATA_BUCKET`); if neither is configured (e.g. a
    # broken deploy), skip the check rather than refuse every build — the
    # destination_bucket allow-list below still prevents writes from being
    # redirected.
    allowed_source_buckets: set[str] = set()
    if config.AWS_S3_RAW_DATA_BUCKET:
        allowed_source_buckets.add(config.AWS_S3_RAW_DATA_BUCKET)
    if config.AWS_S3_PROCESSED_DATA_BUCKET:
        allowed_source_buckets.add(config.AWS_S3_PROCESSED_DATA_BUCKET)

    try:
        request = archive_builder.parse_build_request(
            payload,
            allowed_source_buckets=allowed_source_buckets or None,
        )
    except ValueError as exc:
        logger.warning("Invalid build_archive payload: %s", exc)
        if isinstance(job_id, str):
            _post_archive_job_status(job_id, status="failed", error_message=str(exc))
        return _archive_error_response(400, str(exc))

    # Allow-list the destination bucket against the Lambda's own configured
    # archives bucket. Even though the web app generates the payload, an
    # attacker with the invoke token shouldn't be able to redirect writes at
    # an arbitrary bucket the Lambda role happens to have PutObject on.
    expected_bucket = lambda_config.AWS_S3_ARCHIVES_BUCKET
    if expected_bucket and request.destination_bucket != expected_bucket:
        message = (
            f"destination_bucket '{request.destination_bucket}' does not match "
            f"this Lambda's configured archives bucket"
        )
        logger.warning(message)
        if isinstance(job_id, str):
            _post_archive_job_status(job_id, status="failed", error_message=message)
        return _archive_error_response(400, message)

    try:
        result = archive_builder.build_run_archive(request)
    except Exception as exc:
        logger.exception(
            "Failed to build zip archive for run %s/%s",
            request.instrument_id,
            request.run_id,
        )
        if isinstance(job_id, str):
            _post_archive_job_status(job_id, status="failed", error_message=str(exc))
        return _archive_error_response(500, str(exc))

    body: dict[str, Any] = {
        "archive_bucket": result.archive_bucket,
        "archive_key": result.archive_key,
        "size_bytes": result.size_bytes,
    }
    if isinstance(job_id, str):
        _post_archive_job_status(
            job_id,
            status="ready",
            archive_bucket=result.archive_bucket,
            archive_key=result.archive_key,
            size_bytes=result.size_bytes,
        )
    return {
        "statusCode": 200,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(body),
    }


def _post_archive_job_status(
    job_id: str,
    *,
    status: str,
    archive_bucket: str | None = None,
    archive_key: str | None = None,
    size_bytes: int | None = None,
    error_message: str | None = None,
) -> None:
    """PATCH the archive-job row in the web app with the final build outcome.

    Authenticates with ``LAMBDA_INVOKE_TOKEN`` (the same shared secret the
    Function URL uses), *not* with the regular ``DATA_HUB_API_KEY`` PAT.
    The PATCH lets the caller mark a job ``ready`` with arbitrary
    ``archive_bucket``/``archive_key``, so allowing user PATs would let any
    signed-in user redirect another user's archive download. Restricting
    callbacks to a server-only secret keeps Lambda as the sole writer.

    Failures here are logged but never re-raised — the build itself succeeded
    or failed for its own reasons, and we don't want a callback failure to
    mask that.
    """
    from data_hub_lambda.config import lambda_config

    base_url = lambda_config.DATA_HUB_API_URL
    invoke_token = lambda_config.LAMBDA_INVOKE_TOKEN
    if not base_url or not invoke_token:
        logger.error(
            "DATA_HUB_API_URL/LAMBDA_INVOKE_TOKEN not configured; cannot PATCH archive job %s",
            job_id,
        )
        return

    payload: dict[str, Any] = {"status": status}
    if archive_bucket is not None:
        payload["archive_bucket"] = archive_bucket
    if archive_key is not None:
        payload["archive_key"] = archive_key
    if size_bytes is not None:
        payload["size_bytes"] = size_bytes
    if error_message is not None:
        payload["error_message"] = error_message

    import requests

    try:
        resp = requests.patch(
            f"{base_url.rstrip('/')}/archive-jobs/{job_id}",
            json=payload,
            headers={"Authorization": f"Bearer {invoke_token}"},
            timeout=(5, 30),
        )
        if not resp.ok:
            logger.error(
                "PATCH /archive-jobs/%s returned %d: %s", job_id, resp.status_code, resp.text
            )
    except Exception:
        logger.exception("Failed to PATCH archive-job %s", job_id)


# ------------------------------------------------------------------
# Main handler
# ------------------------------------------------------------------


def lambda_handler(event: dict[str, Any], context: Context) -> dict[str, Any] | None:
    """Top-level Lambda handler dispatching to instrument workflows."""
    logger.info("Received event: %s", pformat(event))

    # Function URL invocations carry a requestContext with an http key.
    # Verify the Bearer token and unwrap the inner JSON payload.
    if _is_function_url_event(event):
        payload = _authenticate_function_url(event)
        if payload is None:
            logger.warning("Unauthorized Function URL invocation")
            return {"statusCode": 401, "body": "Unauthorized"}

        # Discriminator: explicit "type" routes to non-S3-event handlers (today
        # just the archive builder); absent type means a manually-constructed
        # S3 event (used by the file-reprocess flow on the web app).
        payload_type = payload.get("type") if isinstance(payload, dict) else None
        if payload_type == "build_archive":
            return _handle_build_archive(payload)

        event = payload

    try:
        event_info = parse_s3_event(event)  # type: ignore[arg-type]
    except Exception:
        logger.exception("Error handling event.")
        return None

    instrument_id = event_info.instrument_id
    run_id = event_info.run_id
    logger.info("Instrument ID: '%s'", instrument_id)
    logger.info("Run ID: '%s'", run_id)
    instrument_name = INSTRUMENT_ID_TO_NAME_MAP[instrument_id]

    # Pre-cleanup: if the previous invocation on this warm container was
    # SIGKILL'd (e.g. OOM), the `finally` block below didn't run and stale
    # downloads may still be sitting in /tmp. Wipe them before we start.
    _cleanup_tmp()

    try:
        logger.info("Processing file %s...", event_info.filename)

        if instrument_id == Instrument.AKTA_FPLC.value:
            result_url = akta_fplc.process_file(
                run_id=event_info.run_id,
                filename=event_info.filename,
            )

        elif instrument_id == Instrument.AGILENT_4150_TAPESTATION.value:
            result_url = agilent_4150_tapestation.process_file(
                run_id=event_info.run_id,
                filename=event_info.filename,
            )

        elif instrument_id == Instrument.AZURE_600_GEL_DOC.value:
            result_url = azure_600_gel_doc.process_file(
                run_id=event_info.run_id,
                filename=event_info.filename,
            )

        elif instrument_id == Instrument.AZURE_CIELO_QPCR.value:
            result_url = azure_cielo_qpcr.process_file(
                run_id=event_info.run_id,
                filename=event_info.filename,
            )

        elif instrument_id == Instrument.HINA_MICROSCOPE.value:
            result_url = hina_microscope.process_file(
                run_id=event_info.run_id,
                filename=event_info.filename,
            )

        elif instrument_id in (
            Instrument.SPECTRAMAX_ID3_PLATE_READER.value,
            Instrument.SPECTRAMAX_ID5_PLATE_READER.value,
        ):
            result_url = spectramax_plate_reader.process_file(
                instrument_id=event_info.instrument_id,  # pyright: ignore[reportArgumentType]
                run_id=event_info.run_id,
                filename=event_info.filename,
            )

        else:
            logger.error("Unsupported instrument: %s", instrument_id)
            return None

        slack.send_message(
            f"*{instrument_name}*\n"
            f"Finished preprocessing run `{run_id}`!\n"
            f"<{result_url}|View in Data Hub>"
        )
    except Exception:
        logger.exception("Failed to preprocess run %s.", run_id)
        logs_url = get_cloudwatch_logs_url(context)
        slack.send_message(
            f"*{instrument_name}*\n"
            f"Failed to preprocess run `{run_id}`!\n"
            f"<{logs_url}|View CloudWatch logs>"
        )
    finally:
        _cleanup_tmp()
