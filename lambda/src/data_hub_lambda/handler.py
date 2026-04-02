"""AWS Lambda handler for per-file instrument processing.

Invocation sources:
  1. S3 "New object created" events.
  2. Manual invocations via the GitHub Actions workflow.
"""

from __future__ import annotations
import re
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
    azure_600_gel_doc,
    azure_cielo_qpcr,
    spectramax_plate_reader,
)
from data_hub_shared import slack
from data_hub_shared.constants import (
    INSTRUMENT_ID_TO_NAME_MAP,
    INSTRUMENT_NAME_TO_ID_MAP,
)
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

    # S3 key layout is {instrument_id}/{filename} — the run_id is encoded in
    # the filename itself and must be extracted per-instrument below. This
    # differs from the watcher's 3-segment layout ({instrument_id}/{run_id}/{filename}).
    pattern = r"^/?([^/]+)/([^/]+)$"
    match = re.match(pattern, s3_key)
    if not match:
        raise ValueError(f"Object key does not match expected pattern: {s3_key}")

    instrument_id = match.group(1)
    filename = match.group(2)

    if instrument_id == Instrument.AZURE_CIELO_QPCR.value:
        run_id = azure_cielo_qpcr.parse_run_id(filename)
        if not run_id:
            raise ValueError(f"No run ID found in filename: {filename}")
    elif instrument_id == Instrument.AGILENT_4150_TAPESTATION.value:
        run_id = agilent_4150_tapestation.parse_run_id_from_filename(filename)
    elif instrument_id == Instrument.AKTA_FPLC.value:
        run_id = filename.replace(".pdf", "")
    elif instrument_id in (
        Instrument.SPECTRAMAX_ID3_PLATE_READER.value,
        Instrument.SPECTRAMAX_ID5_PLATE_READER.value,
    ):
        run_id = filename.replace(".xls", "")
    elif instrument_id == Instrument.AZURE_600_GEL_DOC.value:
        run_id = filename.replace(".tif", "")
    else:
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
# Main handler
# ------------------------------------------------------------------


def lambda_handler(event: dict[str, Any], context: Context) -> None:
    """Top-level Lambda handler dispatching to instrument workflows."""
    logger.info("Received event: %s", pformat(event))

    # event_info is only populated for S3-triggered invocations; manual
    # invocations (GitHub Actions) don't carry S3 bucket/key details.
    event_info: S3EventInfo | None = None

    try:
        # S3 trigger — the primary invocation path for per-file processing.
        if "Records" in event:
            event_info = parse_s3_event(event)  # type: ignore[arg-type]
            instrument_id = event_info.instrument_id
            run_id = event_info.run_id

        # GitHub Actions manual trigger — provides instrument_name + run_id
        # directly, without S3 context. Used for re-processing or backfills.
        elif "instrument_name" in event and "run_id" in event:
            instrument_id = INSTRUMENT_NAME_TO_ID_MAP[event["instrument_name"]]
            run_id = event["run_id"]

        else:
            raise ValueError("Unsupported event type.")

    except Exception:
        logger.exception("Error handling event.")
        return

    logger.info("Instrument ID: '%s'", instrument_id)
    logger.info("Run ID: '%s'", run_id)
    instrument_name = INSTRUMENT_ID_TO_NAME_MAP[instrument_id]

    try:
        logger.info("Generating report for run %s...", run_id)

        if instrument_id == Instrument.AKTA_FPLC.value:
            if event_info is None:
                logger.warning(
                    "Manual invocation for Akta FPLC is not yet supported via the API path."
                )
                return

            result_url = akta_fplc.process_file(
                run_id=event_info.run_id,
                filename=event_info.filename,
            )

        elif instrument_id == Instrument.AGILENT_4150_TAPESTATION.value:
            if event_info is None:
                logger.warning(
                    "Manual invocation for Agilent 4150 TapeStation is not yet supported "
                    "via the API path."
                )
                return

            result_url = agilent_4150_tapestation.process_file(
                run_id=event_info.run_id,
                filename=event_info.filename,
            )

        elif instrument_id == Instrument.AZURE_600_GEL_DOC.value:
            if event_info is None:
                logger.warning(
                    "Manual invocation for Azure 600 Gel Doc is not yet supported via the API path."
                )
                return

            result_url = azure_600_gel_doc.process_file(
                run_id=event_info.run_id,
                filename=event_info.filename,
            )

        elif instrument_id == Instrument.AZURE_CIELO_QPCR.value:
            if event_info is None:
                logger.warning(
                    "Manual invocation for Azure Cielo qPCR is not yet supported via the API path."
                )
                return

            result_url = azure_cielo_qpcr.process_file(
                run_id=event_info.run_id,
                filename=event_info.filename,
            )

        elif (
            instrument_id == Instrument.SPECTRAMAX_ID3_PLATE_READER.value
            or instrument_id == Instrument.SPECTRAMAX_ID5_PLATE_READER.value
        ):
            if event_info is None:
                logger.warning(
                    "Manual invocation for SpectraMax iD3 is not yet supported via the API path."
                )
                return

            result_url = spectramax_plate_reader.process_file(
                instrument_id=event_info.instrument_id,
                run_id=event_info.run_id,
                filename=event_info.filename,
            )

        else:
            logger.error("Unsupported instrument: %s", instrument_id)
            return

        slack.send_message(
            f"*{instrument_name}*\n"
            f"A report was generated for run `{run_id}`!\n"
            f"<{result_url}|View in Data Hub>"
        )
    except Exception:
        logger.exception("Failed to generate report for run %s.", run_id)
        logs_url = get_cloudwatch_logs_url(context)
        slack.send_message(
            f"*{instrument_name}*\n"
            f"Failed to generate report for run `{run_id}`!\n"
            f"<{logs_url}|View CloudWatch logs>"
        )
