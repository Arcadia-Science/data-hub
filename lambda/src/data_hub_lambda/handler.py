from __future__ import annotations
import json
import re
import shutil
import warnings
from dataclasses import dataclass
from pprint import pformat
from typing import Any
from urllib.parse import unquote_plus

from aws_lambda_typing.context import Context
from aws_lambda_typing.events.s3 import S3Event

from data_hub_lambda import archive_builder
from data_hub_lambda.api_client import ApiError, get_client
from data_hub_lambda.processors import get_processor, matches_any_processor_gate
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
        ValueError: If the event payload is malformed or the key shape is wrong.
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

    return S3EventInfo(
        instrument_id=match.group(1),
        run_id=match.group(2),
        s3_bucket=s3_bucket,
        s3_key=s3_key,
        filename=match.group(3),
    )


# ------------------------------------------------------------------
# Function URL helpers
# ------------------------------------------------------------------


def _is_function_url_event(event: dict[str, Any]) -> bool:
    return "requestContext" in event and "http" in event.get("requestContext", {})


def _parse_function_url_body(event: dict[str, Any]) -> dict[str, Any] | None:
    """Decode and JSON-parse the body of a Function URL invocation.

    Authentication is enforced upstream by Lambda itself: the Function URL
    is configured with ``AuthType: AWS_IAM`` so the runtime only ever
    delivers SigV4-verified requests to this handler. If the body is not
    valid JSON we return ``None`` and the caller should respond 400.
    """
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
    Async callers send ``"job_id"`` so the web app job row gets PATCHed when
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
    # archives bucket. Even though the web app generates the payload, a
    # caller with ``lambda:InvokeFunctionUrl`` shouldn't be able to redirect
    # writes at an arbitrary bucket the Lambda role happens to have
    # PutObject on.
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

    Authenticates with the standard ``DATA_HUB_API_KEY`` PAT — the same
    credential used for every other Lambda → API call.

    Failures here are logged but never re-raised — the build itself succeeded
    or failed for its own reasons, and we don't want a callback failure to
    mask that. The web app's UI does not depend on this PATCH landing
    either: it polls ``/download-archive`` which short-circuits on an S3
    HEAD, so a finished build is downloadable the moment the multipart
    upload completes.
    """
    from data_hub_lambda.api_client import ApiError, get_client

    try:
        get_client().update_archive_job(
            job_id,
            status=status,
            archive_bucket=archive_bucket,
            archive_key=archive_key,
            size_bytes=size_bytes,
            error_message=error_message,
        )
    except ApiError as exc:
        logger.error(
            "PATCH /archive-jobs/%s failed (status %d): %s", job_id, exc.status_code, exc.message
        )
    except Exception:
        logger.exception("Failed to PATCH archive-job %s", job_id)


# ------------------------------------------------------------------
# Reprocess failure recovery
# ------------------------------------------------------------------


def _fail_reprocess_file(
    instrument_id: str,
    run_id: str,
    filename: str,
    error_message: str,
) -> None:
    """PATCH the file to failed so a Function URL no-op can't leave it in processing.

    The web app transitions the file to ``processing`` before invoking the
    Function URL. Resolves the row via the idempotent ``create_file`` upsert
    (returns the existing record) and marks it failed. Failures here are
    logged but not re-raised — the caller has already decided not to process.
    """
    from data_hub_shared.config import config

    try:
        client = get_client()
        s3_bucket = config.AWS_S3_RAW_DATA_BUCKET or ""
        s3_key = f"{instrument_id}/{run_id}/{filename}"
        file_record = client.create_file(
            instrument_id=instrument_id,
            run_id=run_id,
            s3_bucket=s3_bucket,
            s3_key=s3_key,
            filename=filename,
        )
        client.update_file(
            file_record.id,
            status="failed",
            error_message=error_message,
        )
    except Exception:
        logger.exception(
            "Failed to mark reprocess file %s/%s/%s as failed",
            instrument_id,
            run_id,
            filename,
        )


# ------------------------------------------------------------------
# Main handler
# ------------------------------------------------------------------


def lambda_handler(event: dict[str, Any], context: Context) -> dict[str, Any] | None:
    """Top-level Lambda handler dispatching to instrument workflows.

    Dispatch is by ``instrument_type`` (fetched from the API), not instrument
    ID. Filename gates filter the S3 firehose; explicit reprocess via the
    Function URL bypasses those gates so user-initiated work can't strand
    a file in ``processing``.
    """
    logger.info("Received event: %s", pformat(event))

    # Capture before unwrapping so reprocess (Function URL) can skip gates.
    is_function_url = _is_function_url_event(event)
    apply_filename_gates = not is_function_url

    # Function URL invocations carry a requestContext with an http key.
    # AWS_IAM auth is enforced by Lambda before the handler runs, so we
    # only need to unwrap the inner JSON payload here.
    if is_function_url:
        payload = _parse_function_url_body(event)
        if payload is None:
            return {"statusCode": 400, "body": "Invalid JSON body"}

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
    filename = event_info.filename
    logger.info("Instrument ID: '%s'", instrument_id)
    logger.info("Run ID: '%s'", run_id)

    # Pre-cleanup before the filename gate so warm containers recover from
    # a prior OOM even when the catch-all notification mostly no-ops.
    _cleanup_tmp()

    try:
        # Skip the API call when no processor could possibly want this filename.
        if apply_filename_gates and not matches_any_processor_gate(filename):
            logger.info(
                "No processor filename gate matches %s; skipping.",
                filename,
            )
            return None

        try:
            instrument = get_client().get_instrument(instrument_id)
        except ApiError as exc:
            if exc.status_code == 404:
                logger.info(
                    "Instrument %s not found; skipping %s.",
                    instrument_id,
                    filename,
                )
                if is_function_url:
                    _fail_reprocess_file(
                        instrument_id,
                        run_id,
                        filename,
                        f"Instrument '{instrument_id}' not found",
                    )
                return None
            if exc.status_code in (401, 403):
                logger.error(
                    "Auth failure fetching instrument %s (status %d): %s. "
                    "Check that DATA_HUB_API_KEY includes instruments:read.",
                    instrument_id,
                    exc.status_code,
                    exc.message,
                )
                raise
            # Transient errors already retried inside get_instrument; re-raise
            # so the async S3 path can retry the invocation.
            logger.error(
                "Failed to fetch instrument %s after retries (status %d): %s",
                instrument_id,
                exc.status_code,
                exc.message,
            )
            raise

        processor = get_processor(instrument.instrument_type)
        if processor is None:
            message = f"No Lambda processor for instrument_type='{instrument.instrument_type}'"
            logger.info(
                "%s (instrument %s); skipping %s.",
                message,
                instrument_id,
                filename,
            )
            if is_function_url:
                _fail_reprocess_file(instrument_id, run_id, filename, message)
            return None

        if apply_filename_gates and not processor.matches_filename(filename):
            logger.info(
                "Filename %s does not match gate for instrument_type=%s; skipping.",
                filename,
                instrument.instrument_type,
            )
            return None

        logger.info(
            "Processing file %s with instrument_type=%s...",
            filename,
            instrument.instrument_type,
        )
        processor.process_file(instrument_id, run_id, filename)

    except ApiError:
        # Auth / exhausted-retry failures: re-raise so Lambda retries (S3)
        # or returns 500 (Function URL). Do not swallow.
        raise
    except Exception:
        # Per-file failure is already PATCHed back to the web app's file row
        # (status='failed', error_message=...) by each instrument's
        # `process_file`, so the failure remains visible in the UI without a
        # Slack notification here.
        logger.exception("Failed to preprocess run %s.", run_id)
    finally:
        _cleanup_tmp()

    return None
