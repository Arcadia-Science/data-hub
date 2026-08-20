"""Unit tests for shared S3 helpers."""

from __future__ import annotations
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from data_hub_shared.s3_utils import object_exists


def _client_error(code: str, status: int) -> ClientError:
    return ClientError(
        {
            "Error": {"Code": code, "Message": "nope"},
            "ResponseMetadata": {"HTTPStatusCode": status},
        },
        "HeadObject",
    )


def test_object_exists_true() -> None:
    client = MagicMock()
    assert object_exists("s3://bucket/key", s3_client=client) is True
    client.head_object.assert_called_once_with(Bucket="bucket", Key="key")


@pytest.mark.parametrize(
    ("code", "status"),
    [
        ("404", 404),
        ("NoSuchKey", 404),
        ("NotFound", 404),
    ],
)
def test_object_exists_missing(code: str, status: int) -> None:
    client = MagicMock()
    client.head_object.side_effect = _client_error(code, status)
    assert object_exists("s3://bucket/key", s3_client=client) is False


@pytest.mark.parametrize(
    ("code", "status"),
    [
        ("403", 403),
        ("AccessDenied", 403),
        ("Forbidden", 403),
    ],
)
def test_object_exists_403_is_missing(code: str, status: int) -> None:
    client = MagicMock()
    client.head_object.side_effect = _client_error(code, status)
    assert object_exists("s3://bucket/key", s3_client=client) is False


def test_object_exists_other_errors_raise() -> None:
    client = MagicMock()
    client.head_object.side_effect = _client_error("500", 500)
    with pytest.raises(ClientError):
        object_exists("s3://bucket/key", s3_client=client)
