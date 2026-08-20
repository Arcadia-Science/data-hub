"""Session-scoped and function-scoped fixtures for Lambda -> API integration tests.

These fixtures spin up a real Next.js server backed by Postgres so that
`lambda_handler` -> `process_file` -> `DataHubClient` exercises the
full HTTP path with only S3 downloads mocked.
"""

from __future__ import annotations
import json
import os
import shutil
from collections.abc import Callable, Generator
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch
from urllib.parse import quote_plus

import pytest

from data_hub_shared.testing import (
    IntegrationEnv,
    seed_instruments,
    start_test_server,
    truncate_tables,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Instruments seeded at session scope. Types must match the Lambda
# processor registry keys in `data_hub_lambda.processors`.
_INSTRUMENTS: dict[str, str] = {
    "azure-cielo-qpcr": "Azure Cielo qPCR",
    "azure-600-gel-doc": "Azure 600 Gel Doc",
    "hina-microscope": "Hina Microscope",
    "spectramax-id3-plate-reader": "SpectraMax iD3 Plate Reader",
    "spectramax-id5-plate-reader": "SpectraMax iD5 Plate Reader",
    "dishcam": "DishCam",
}

_INSTRUMENT_TYPES: dict[str, str] = {
    "azure-cielo-qpcr": "qpcr",
    "azure-600-gel-doc": "gel_doc",
    "hina-microscope": "hina_microscope",
    "spectramax-id3-plate-reader": "plate_reader",
    "spectramax-id5-plate-reader": "plate_reader",
    "dishcam": "dishcam",
}


# ---------------------------------------------------------------------------
# Lambda-specific helpers
# ---------------------------------------------------------------------------


def _reset_singletons() -> None:
    """Re-initialize shared/lambda config objects *in place* and drop the
    cached API client so the next `get_client()` call picks up the new
    environment variables.

    Mutating the existing objects (rather than replacing them) is critical
    because other modules bind `config` / `lambda_config` via
    `from … import config` — a replacement would leave stale references.
    """
    import data_hub_lambda.api_client as _api_mod
    import data_hub_lambda.config as _lcfg_mod
    import data_hub_shared.config as _scfg_mod

    _api_mod._client = None
    _scfg_mod.config.__init__()  # type: ignore[misc]
    _lcfg_mod.lambda_config.__init__()  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Step 1 — session-scoped server fixture
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def integration_env(
    tmp_path_factory: pytest.TempPathFactory,
) -> Generator[IntegrationEnv, None, None]:
    """Start a real Next.js server, push the DB schema, and seed auth + instruments."""

    with start_test_server() as env:
        seed_instruments(env.db_dsn, _INSTRUMENTS, instrument_types=_INSTRUMENT_TYPES)

        # Set env vars for Lambda modules and reset singletons so
        # DataHubClient / Config pick up the test server URL.
        tmp_data = tmp_path_factory.mktemp("data")
        os.environ["DATA_HUB_API_URL"] = f"{env.base_url}/api/v1"
        os.environ["DATA_HUB_API_KEY"] = env.api_token
        os.environ["AWS_S3_RAW_DATA_BUCKET"] = "test-bucket"
        os.environ["AWS_S3_PROCESSED_DATA_BUCKET"] = "test-processed-bucket"
        os.environ["LOCAL_DATA_DIRPATH"] = str(tmp_data)

        _reset_singletons()

        yield env

        # Clear env vars so subsequent tests don't inherit them.
        for key in (
            "DATA_HUB_API_URL",
            "DATA_HUB_API_KEY",
            "AWS_S3_RAW_DATA_BUCKET",
            "AWS_S3_PROCESSED_DATA_BUCKET",
            "LOCAL_DATA_DIRPATH",
        ):
            os.environ.pop(key, None)


# ---------------------------------------------------------------------------
# Step 2 — per-test DB reset
# ---------------------------------------------------------------------------

# Leaf-first (children before parents) to respect FK ordering.
# Session-scoped rows (instruments, user, personal_access_tokens) are
# intentionally excluded so tests don't need to re-seed them.
_DATA_TABLES = ["files", "instrument_runs"]


@pytest.fixture(autouse=True)
def reset_db(integration_env: IntegrationEnv) -> None:
    """Truncate data tables between tests, preserving instruments and the PAT."""
    truncate_tables(integration_env.db_dsn, _DATA_TABLES)


# ---------------------------------------------------------------------------
# Step 3a — S3 event factory
# ---------------------------------------------------------------------------


@pytest.fixture()
def make_s3_event() -> Callable[..., dict[str, Any]]:
    """Factory fixture that builds realistic S3 event dicts.

    Usage::

        def test_example(make_s3_event):
            event = make_s3_event(
                "azure-cielo-qpcr", "Experiment_20260101", "CqValues.csv",
            )
    """

    def _factory(
        instrument_id: str,
        run_id: str,
        filename: str,
        bucket: str = "test-bucket",
    ) -> dict[str, Any]:
        s3_key = f"{instrument_id}/{run_id}/{filename}"
        # Real S3 event notifications form-encode object keys: spaces
        # become "+" and literal "+" becomes "%2B".  Match that exactly
        # with quote_plus so the event round-trips through the Lambda's
        # unquote_plus decoder the same way production events do.
        encoded_key = quote_plus(s3_key, safe="/")
        return {
            "Records": [
                {
                    "eventVersion": "2.1",
                    "eventSource": "aws:s3",
                    "awsRegion": "us-east-1",
                    "eventName": "ObjectCreated:Put",
                    "s3": {
                        "bucket": {"name": bucket},
                        "object": {"key": encoded_key, "size": 1024},
                    },
                }
            ]
        }

    return _factory


# ---------------------------------------------------------------------------
# Step 3a' — Function URL event factory
# ---------------------------------------------------------------------------


@pytest.fixture()
def make_function_url_event(
    make_s3_event: Callable[..., dict[str, Any]],
) -> Callable[..., dict[str, Any]]:
    """Factory fixture that wraps an S3 event inside a Function URL envelope.

    The handler no longer authenticates the inbound request — the Function
    URL is configured with ``AuthType: AWS_IAM`` so AWS itself enforces
    SigV4 in front of Lambda. Tests therefore don't need to plumb any
    bearer token through this fixture.

    Usage::

        def test_example(make_function_url_event):
            event = make_function_url_event(
                "azure-cielo-qpcr", "Experiment_20260101", "CqValues.csv",
            )
    """

    def _factory(
        instrument_id: str,
        run_id: str,
        filename: str,
        bucket: str = "test-bucket",
        body_override: str | None = None,
    ) -> dict[str, Any]:
        s3_event = make_s3_event(instrument_id, run_id, filename, bucket)

        return {
            "version": "2.0",
            "requestContext": {
                "http": {
                    "method": "POST",
                    "path": "/",
                    "sourceIp": "127.0.0.1",
                },
                "accountId": "123456789012",
            },
            "headers": {"content-type": "application/json"},
            "body": body_override if body_override is not None else json.dumps(s3_event),
            "isBase64Encoded": False,
        }

    return _factory


# ---------------------------------------------------------------------------
# Step 3b — S3 download patch
# ---------------------------------------------------------------------------


@pytest.fixture()
def s3_fixture_files() -> dict[str, Path]:
    """Registry mapping S3 keys to local fixture file paths.

    Tests populate this dict *before* calling `lambda_handler` so the
    patched `download_file` knows which local file to copy::

        s3_fixture_files["azure-cielo-qpcr/file.csv"] = Path("/path/to/fixture.csv")
    """
    return {}


@pytest.fixture(autouse=True)
def mock_s3_download(
    integration_env: IntegrationEnv,
    s3_fixture_files: dict[str, Path],
) -> Generator[MagicMock, None, None]:
    """Patch `s3_utils.download_file` to copy from local fixture files
    instead of hitting real S3."""

    def _fake_download(s3_uri: str, local_path: Path, **_: Any) -> None:
        key = s3_uri.split("//", 1)[1].split("/", 1)[1]
        src = s3_fixture_files.get(key)
        if src is None:
            raise FileNotFoundError(
                f"No fixture registered for S3 key '{key}'. "
                f"Registered keys: {list(s3_fixture_files)}"
            )
        local_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, local_path)

    with patch("data_hub_shared.s3_utils.download_file", side_effect=_fake_download) as mock:
        yield mock


# ---------------------------------------------------------------------------
# Step 3b' — S3 upload patch
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def mock_s3_upload() -> Generator[MagicMock, None, None]:
    """Patch `s3_utils.upload_file` as a no-op so processors that write to the
    processed bucket (e.g. Azure 600 Gel Doc) don't hit real S3."""
    with patch("data_hub_shared.s3_utils.upload_file") as mock:
        yield mock


@pytest.fixture(autouse=True)
def mock_s3_object_exists(
    s3_fixture_files: dict[str, Path],
) -> Generator[MagicMock, None, None]:
    """HEAD exists when the key was registered on `s3_fixture_files`."""

    def _exists(s3_uri: str, **_: Any) -> bool:
        key = s3_uri.split("//", 1)[1].split("/", 1)[1]
        return key in s3_fixture_files

    with patch("data_hub_shared.s3_utils.object_exists", side_effect=_exists) as mock:
        yield mock


@pytest.fixture(autouse=True)
def mock_s3_list_objects(
    s3_fixture_files: dict[str, Path],
) -> Generator[MagicMock, None, None]:
    """List registered fixture keys under the requested prefix."""

    def _list(s3_uri_prefix: str, suffix: str = "", **_: Any) -> list[str]:
        rest = s3_uri_prefix.split("//", 1)[1]
        bucket, prefix = rest.split("/", 1)
        uris: list[str] = []
        for key in s3_fixture_files:
            if key.startswith(prefix) and (not suffix or key.endswith(suffix)):
                uris.append(f"s3://{bucket}/{key}")
        return uris

    with patch("data_hub_shared.s3_utils.list_objects", side_effect=_list) as mock:
        yield mock


# ---------------------------------------------------------------------------
# Step 5 — mock Lambda context
# ---------------------------------------------------------------------------


@pytest.fixture()
def mock_context() -> MagicMock:
    """Lightweight mock for `aws_lambda_typing.context.Context`."""
    from aws_lambda_typing.context import Context

    ctx = MagicMock(spec=Context)
    ctx.invoked_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:data-hub-lambda"
    ctx.log_group_name = "/aws/lambda/data-hub-lambda"
    ctx.log_stream_name = "2026/01/01/[$LATEST]abc123"
    ctx.function_name = "data-hub-lambda"
    ctx.function_version = "$LATEST"
    ctx.memory_limit_in_mb = "256"
    ctx.aws_request_id = "test-request-id"
    return ctx
