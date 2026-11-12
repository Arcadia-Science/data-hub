"""The handler logs a summary of each event, never the caller's credentials."""

from __future__ import annotations
import json
import logging
from collections.abc import Iterator
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from data_hub_lambda.api_client import ApiError
from data_hub_lambda.handler import lambda_handler

# Synthetic stand-ins for what a SigV4-signed Function URL request carries.
SESSION_TOKEN = "FAKE-SESSION-TOKEN-must-not-be-logged"
ACCESS_KEY_ID = "ASIAFAKEACCESSKEYID0"
SIGNATURE = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0"
CALLER_ID = "AROAFAKECALLERID0000:fake-session"
CALLER_ARN = "arn:aws:sts::123456789012:assumed-role/data-hub-webapp-test/fake-session"
SECRETS = [SESSION_TOKEN, ACCESS_KEY_ID, SIGNATURE, CALLER_ID, CALLER_ARN]


def _s3_event(bucket: str, key: str) -> dict[str, Any]:
    return {"Records": [{"s3": {"bucket": {"name": bucket}, "object": {"key": key}}}]}


def _function_url_event(body: dict[str, Any]) -> dict[str, Any]:
    """A Function URL event as Lambda delivers it to the handler."""
    return {
        "version": "2.0",
        "routeKey": "$default",
        "rawPath": "/",
        "rawQueryString": "",
        "headers": {
            "authorization": (
                f"AWS4-HMAC-SHA256 Credential={ACCESS_KEY_ID}/20260101/us-west-1/lambda/"
                "aws4_request, SignedHeaders=content-type;host;x-amz-date;"
                f"x-amz-security-token, Signature={SIGNATURE}"
            ),
            "content-type": "application/json",
            "host": "example.lambda-url.us-west-1.on.aws",
            "x-amz-date": "20260101T000000Z",
            "x-amz-security-token": SESSION_TOKEN,
        },
        "requestContext": {
            "accountId": "123456789012",
            "apiId": "example",
            "authorizer": {
                "iam": {
                    "accessKey": ACCESS_KEY_ID,
                    "accountId": "123456789012",
                    "callerId": CALLER_ID,
                    "cognitoIdentity": None,
                    "principalOrgId": None,
                    "userArn": CALLER_ARN,
                    "userId": CALLER_ID,
                }
            },
            "domainName": "example.lambda-url.us-west-1.on.aws",
            "http": {
                "method": "POST",
                "path": "/",
                "protocol": "HTTP/1.1",
                "sourceIp": "203.0.113.10",
                "userAgent": "node",
            },
            "requestId": "00000000-0000-0000-0000-000000000000",
            "routeKey": "$default",
            "stage": "$default",
            "time": "01/Jan/2026:00:00:00 +0000",
            "timeEpoch": 1767225600000,
        },
        "body": json.dumps(body),
        "isBase64Encoded": False,
    }


@pytest.fixture
def lambda_logs(caplog: pytest.LogCaptureFixture) -> Iterator[pytest.LogCaptureFixture]:
    """Capture every Data Hub logger.

    `get_named_logger` turns off propagation, so caplog's root handler would
    miss these records unless it is attached to each logger.
    """
    loggers = [
        logger
        for name, logger in logging.Logger.manager.loggerDict.items()
        if name.startswith("data_hub") and isinstance(logger, logging.Logger)
    ]
    for logger in loggers:
        logger.addHandler(caplog.handler)
    yield caplog
    for logger in loggers:
        logger.removeHandler(caplog.handler)


def _assert_no_credentials(text: str) -> None:
    for secret in SECRETS:
        assert secret not in text


def test_reprocess_request_logs_object_but_not_credentials(
    lambda_logs: pytest.LogCaptureFixture,
) -> None:
    client = MagicMock()
    client.get_instrument.side_effect = ApiError("not found", status_code=404)
    event = _function_url_event(_s3_event("raw-bucket", "inst-1/run-1/plate.xls"))

    with (
        patch("data_hub_lambda.handler.get_client", return_value=client),
        patch("data_hub_lambda.handler._cleanup_tmp"),
    ):
        lambda_handler(event, MagicMock())

    assert "Received Function URL request for s3://raw-bucket/inst-1/run-1/plate.xls" in (
        lambda_logs.text
    )
    _assert_no_credentials(lambda_logs.text)


def test_archive_request_logs_run_but_not_credentials(
    lambda_logs: pytest.LogCaptureFixture,
) -> None:
    # Missing fields make the build fail fast, before any S3 call.
    event = _function_url_event(
        {"type": "build_archive", "instrument_id": "inst-1", "run_id": "run-1"}
    )

    result = lambda_handler(event, MagicMock())

    assert result is not None
    assert result["statusCode"] == 400
    assert "build an archive of run inst-1/run-1" in lambda_logs.text
    _assert_no_credentials(lambda_logs.text)


def test_s3_notification_logs_bucket_and_key(lambda_logs: pytest.LogCaptureFixture) -> None:
    # S3 URL-encodes keys in notifications; the log shows the decoded key.
    event = _s3_event("raw-bucket", "inst-1/run-1/Experiment_Cq+Values.txt")

    with patch("data_hub_lambda.handler._cleanup_tmp"):
        lambda_handler(event, MagicMock())

    assert (
        "Received S3 notification for s3://raw-bucket/inst-1/run-1/Experiment_Cq Values.txt"
        in lambda_logs.text
    )


def test_malformed_records_are_summarised_without_raising(
    lambda_logs: pytest.LogCaptureFixture,
) -> None:
    lambda_handler({"Records": [{"s3": {}}, "not-a-record"]}, MagicMock())

    assert "Received S3 notification for s3://?/?, s3://?/?" in lambda_logs.text
