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
# Main handler
# ------------------------------------------------------------------


def lambda_handler(event: dict[str, Any], context: Context) -> None:
    """Top-level Lambda handler dispatching to instrument workflows."""
    logger.info("Received event: %s", pformat(event))

    try:
        event_info = parse_s3_event(event)  # type: ignore[arg-type]
    except Exception:
        logger.exception("Error handling event.")
        return

    instrument_id = event_info.instrument_id
    run_id = event_info.run_id
    logger.info("Instrument ID: '%s'", instrument_id)
    logger.info("Run ID: '%s'", run_id)
    instrument_name = INSTRUMENT_ID_TO_NAME_MAP[instrument_id]

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
            return

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
