"""
This Lambda function handler is used to trigger the appropriate data processing and/or
report generation workflow for a given instrument run.

In the AWS Console, the Lambda function is configured to receive several "New object created" events
from the S3 bucket that Ganymede copies raw data to.

Each S3 event trigger is configured for files with a specific prefix (the instrument ID e.g.
"azure-cielo-qpcr/") and suffix (the filename's suffix and/or the file extension e.g. ".csv").
This is to prevent multiple invocations of the Lambda function when multiple files are uploaded for
the same instrument run.

The Lambda function can also be invoked manually via the GitHub Actions workflow, which
receives user input for the instrument name and run ID. You can find the workflow here:
https://github.com/Arcadia-Science/2025-data-hub-utils/actions/workflows/run-processing-workflow.yml.
"""

import json
import re
import warnings
from pprint import pformat
from typing import Any
from urllib.parse import quote, unquote_plus

from aws_lambda_typing.context import Context
from aws_lambda_typing.events.s3 import S3Event
from data_hub_utils import slack
from data_hub_utils.config import config
from data_hub_utils.constants import (
    INSTRUMENT_ID_TO_NAME_MAP,
    INSTRUMENT_NAME_TO_ID_MAP,
)
from data_hub_utils.enums import Analysis, Instrument
from data_hub_utils.logger import get_named_logger
from data_hub_utils.notion import api as notion
from data_hub_utils.notion.utils import (
    get_instrument_run_page_id,
    get_notion_page_url,
)
from data_hub_utils.workflows import (
    agilent_4150_tapestation,
    akta_fplc,
    azure_600_gel_doc,
    azure_cielo_qpcr,
    spectramax_id3_plate_reader,
    spectramax_id5_plate_reader,
)

logger = get_named_logger(__name__)

# Suppress deprecation warnings.
warnings.filterwarnings("ignore", category=DeprecationWarning)


def parse_s3_event(event: S3Event) -> tuple[str, str]:
    """Parses the instrument ID and run ID from an S3 event.

    Reference: https://docs.aws.amazon.com/lambda/latest/dg/with-s3.html.

    Args:
        event (aws_lambda_typing.events.s3.S3Event):
            The event object passed to the Lambda function.

    Returns:
        tuple[str, str]:
            Tuple of (instrument_id, run_id) if pattern matches.

    Raises:
        ValueError:
            - If no records are found in the event payload.
            - If the object key does not match the expected pattern.
            - If the instrument is not currently supported.
    """
    # Check for the presence of a "Records" key in the event payload.
    record = event["Records"][0]
    if not record:
        raise ValueError("No records found in event payload.")

    object_key = record["s3"]["object"]["key"]  # type: ignore

    # Unquote the object key to handle special characters like spaces.
    object_key = unquote_plus(object_key)

    # Pattern to match "/[instrument_id]/[filename.ext]".
    pattern = r"^/?([^/]+)/([^/]+)$"
    match = re.match(pattern, object_key)

    if not match:
        raise ValueError(f"Object key does not match expected pattern: {object_key}")

    # Use the instrument ID and filename to parse the run ID.
    instrument_id = match.group(1)
    filename = match.group(2)

    if instrument_id == Instrument.AZURE_CIELO_QPCR.value:
        # The run ID is the "Experiment_YYYYMMDD" prefix in the filename.
        # For multiple runs on the same day, the prefix will be "Experiment_YYYYMMDDHHmmss".
        run_id = azure_cielo_qpcr.parse_run_id(filename)
        if not run_id:
            raise ValueError(f"No run ID found in filename: {filename}")

    elif instrument_id == Instrument.AGILENT_4150_TAPESTATION.value:
        # We define the run ID as the "YYYY-MM-DD - HH-MM-SS" prefix in all of the CSV files
        # for the same run.
        run_id = agilent_4150_tapestation.parse_run_id_from_filename(filename)

    elif instrument_id == Instrument.AKTA_FPLC.value:
        # The run ID is the filename without the extension.
        # All files for the same run are expected to have the same name.
        run_id = filename.replace(".pdf", "")

    elif (
        instrument_id == Instrument.SPECTRAMAX_ID3_PLATE_READER.value
        or instrument_id == Instrument.SPECTRAMAX_ID5_PLATE_READER.value
    ):
        # The run ID is the filename without the extension.
        run_id = filename.replace(".xls", "")

    elif instrument_id == Instrument.AZURE_600_GEL_DOC.value:
        # The run ID is the filename without the extension.
        run_id = filename.replace(".tif", "")

    else:
        raise ValueError(f"This instrument is not currently supported: {instrument_id}")

    return instrument_id, run_id


def get_cloudwatch_logs_url(context: Context) -> str:
    """Generates the CloudWatch logs URL for the current Lambda execution.

    Args:
        context (aws_lambda_typing.context.Context):
            The Lambda context object containing log information.

    Returns:
        str: The CloudWatch logs URL.
    """
    # Extract region from the invoked function ARN.
    # ARN format: arn:aws:lambda:region:account-id:function:function-name
    arn_parts = context.invoked_function_arn.split(":")
    region = arn_parts[3] if len(arn_parts) > 3 else "us-east-1"

    # URL encode the log group and stream names to handle special characters.
    log_group_encoded = quote(context.log_group_name, safe="")
    log_stream_encoded = quote(context.log_stream_name, safe="")

    # Construct the CloudWatch logs URL.
    # Reference: https://docs.aws.amazon.com/lambda/latest/dg/python-context.html
    base_url = f"https://{region}.console.aws.amazon.com/cloudwatch/home"
    logs_path = f"log-groups/log-group/{log_group_encoded}/log-events/{log_stream_encoded}"

    return f"{base_url}?region={region}#logsV2:{logs_path}"


def is_authenticated_url_request(request_payload: dict[str, Any]) -> bool:
    """Authenticates the request payload for a Lambda function URL invocation.

    We expect the request payload to contain a header with the key "x-auth-token".
    This header's value should be the same as the `AWS_LAMBDA_FUNCTION_URL_AUTH_TOKEN`
    environment variable.

    Args:
        request_payload (dict[str, Any]):
            The request payload for a Lambda function URL invocation.

    Returns:
        bool: True if the request is authenticated, and False otherwise.
    """
    request_token = request_payload["headers"]["x-auth-token"]
    expected_token = config.AWS_LAMBDA_FUNCTION_URL_AUTH_TOKEN

    if not expected_token:
        raise ValueError("AWS_LAMBDA_FUNCTION_URL_AUTH_TOKEN is not set.")

    return request_token == expected_token


def handle_notion_webhook_event(request_payload: dict[str, Any], context: Context) -> None:
    """Handles Lambda function URL invocations made by Notion webhook events.

    Reference for Lambda function URL request payloads:
    https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html#urls-payloads

    Reference for Notion webhooks: https://www.notion.com/help/webhook-actions.

    Args:
        request_payload (dict[str, Any]):
            The request payload for a Lambda function URL invocation.
        context (aws_lambda_typing.context.Context):
            The context object passed to the Lambda function.
    """
    # Parse the request body.
    request_body = json.loads(request_payload["body"])

    notion_page_id = request_body["data"]["id"]
    notion_page_properties = request_body["data"]["properties"]

    run_id = notion_page_properties["Instrument Run ID"]["title"][0]["plain_text"]
    analysis_name = notion_page_properties["Analysis"]["select"]["name"]

    instrument_name = INSTRUMENT_ID_TO_NAME_MAP[Instrument.SPECTRAMAX_ID3_PLATE_READER.value]

    # Michaelis-Menten kinetics analysis.
    if analysis_name == Analysis.MICHAELIS_MENTEN_KINETICS.value:
        metadata_files = notion_page_properties["Related Files"]["files"]
        metadata_file_url = metadata_files[0]["file"]["url"]

        # Update the "Analysis Status" property for responsiveness.
        status_property = {"Analysis Status": {"select": {"name": "In Progress"}}}
        notion.update_page_properties(notion_page_id, status_property)

        try:
            spectramax_id3_plate_reader.run_kinetics_analysis(
                run_id, metadata_file_url, notion_page_id
            )
            logger.info("Kinetics analysis workflow completed for run %s", run_id)

            slack.send_message(
                f"*{instrument_name}*\n"
                f"Michaelis-Menten kinetics analysis completed for run `{run_id}`! 🥳\n"
                f"<{get_notion_page_url(notion_page_id)}|View in Notion>"
            )

            status_property["Analysis Status"]["select"]["name"] = "Completed"
            notion.update_page_properties(notion_page_id, status_property)

        except Exception:
            logger.exception("Kinetics analysis workflow failed for run %s", run_id)

            logs_url = get_cloudwatch_logs_url(context)
            slack.send_message(
                f"*🚨 {instrument_name}*\n"
                f"Failed to execute Michaelis-Menten kinetics analysis for run `{run_id}`! 😭\n"
                f"<{logs_url}|View CloudWatch logs>"
            )

            status_property["Analysis Status"]["select"]["name"] = "Failed"
            notion.update_page_properties(notion_page_id, status_property)
    else:
        logger.error("Unsupported analysis: %s", analysis_name)
        return


def lambda_handler(event: dict[str, Any], context: Context) -> None:
    """Handles Lambda function invocations.

    The Lambda function can be invoked in the following ways:

    1. S3 "New object created" events.
    2. Manual invocations made using the AWS CLI via the GitHub Actions workflow.
    3. Lambda function URL invocations made by Notion webhook events.

    Args:
        event (dict[str, Any]):
            The event object passed to the Lambda function.
        context (aws_lambda_typing.context.Context):
            The context object passed to the Lambda function.
    """
    logger.info("Received event: %s", pformat(event))

    try:
        # For S3 "New object created" events, the event payload is a list of records.
        if "Records" in event:
            params = parse_s3_event(event)  # type: ignore
            instrument_id, run_id = params

        # For manual invocations via the GitHub Actions workflow, the payload contains these keys.
        elif "instrument_name" in event and "run_id" in event:
            instrument_id = INSTRUMENT_NAME_TO_ID_MAP[event["instrument_name"]]
            run_id = event["run_id"]

        # We expect Lambda function URL invocations to be made by Notion webhook events. These are
        # triggered by Notion database automations, typically to run an analysis for a specific
        # instrument run.
        elif "body" in event:
            if is_authenticated_url_request(event):
                handle_notion_webhook_event(event, context)
            else:
                logger.error("Authentication failed for Lambda function URL invocation.")
            return

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

        if instrument_id == Instrument.AGILENT_4150_TAPESTATION.value:
            instrument_run_page_id = get_instrument_run_page_id(instrument_name, run_id)
            notion_page_url = agilent_4150_tapestation.generate_report(
                run_id, notion_page_id=instrument_run_page_id
            )
            # If the Notion page existed before the workflow was run, skip the Slack message.
            if instrument_run_page_id is not None:
                return

        elif instrument_id == Instrument.AKTA_FPLC.value:
            notion_page_url = akta_fplc.generate_report(run_id)

        elif instrument_id == Instrument.AZURE_600_GEL_DOC.value:
            notion_page_url = azure_600_gel_doc.generate_report(run_id)

        elif instrument_id == Instrument.AZURE_CIELO_QPCR.value:
            instrument_run_page_id = get_instrument_run_page_id(instrument_name, run_id)
            notion_page_url = azure_cielo_qpcr.generate_report(
                run_id, notion_page_id=instrument_run_page_id
            )
            # If the Notion page existed before the workflow was run, skip the Slack message.
            if instrument_run_page_id is not None:
                return

        elif instrument_id == Instrument.SPECTRAMAX_ID3_PLATE_READER.value:
            notion_page_url = spectramax_id3_plate_reader.generate_report(run_id)

        elif instrument_id == Instrument.SPECTRAMAX_ID5_PLATE_READER.value:
            notion_page_url = spectramax_id5_plate_reader.generate_report(run_id)

        slack.send_message(
            f"*{instrument_name}*\n"
            f"A report was generated for run `{run_id}`! 🥳\n"
            f"<{notion_page_url}|View in Notion>"  # type: ignore
        )
    except Exception:
        logger.exception("Failed to generate report for run %s.", run_id)
        logs_url = get_cloudwatch_logs_url(context)
        slack.send_message(
            f"🚨 *{instrument_name}*\n"
            f"Failed to generate report for run `{run_id}`! 😭\n"
            f"<{logs_url}|View CloudWatch logs>"
        )
