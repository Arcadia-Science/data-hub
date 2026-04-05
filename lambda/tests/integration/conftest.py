"""Session-scoped and function-scoped fixtures for Lambda -> API integration tests.

These fixtures spin up a real Next.js server backed by Postgres so that
`lambda_handler` -> `process_file` -> `DataHubClient` exercises the
full HTTP path with only S3 downloads and Slack mocked.
"""

from __future__ import annotations
import hashlib
import os
import secrets
import shutil
import socket
import subprocess
import time
from collections.abc import Callable, Generator
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import psycopg2
import pytest

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_TEST_DB = "data_hub_test"
_PG_HOST = "127.0.0.1"
_PG_PORT = 5432
_PG_USER = "postgres"
_PG_PASSWORD = "postgres"
_PG_ADMIN_DSN = (
    f"dbname=postgres user={_PG_USER} password={_PG_PASSWORD} host={_PG_HOST} port={_PG_PORT}"
)
_PG_TEST_DSN = (
    f"dbname={_TEST_DB} user={_PG_USER} password={_PG_PASSWORD} host={_PG_HOST} port={_PG_PORT}"
)
_DATABASE_URL = f"postgres://{_PG_USER}:{_PG_PASSWORD}@{_PG_HOST}:{_PG_PORT}/{_TEST_DB}"

# Must match the token generation logic in web-app/lib/tokens.ts
_TOKEN_PREFIX = "dhub_"
# conftest.py lives at lambda/tests/integration/ — walk up 3 levels to the repo root.
_WEB_APP_DIR = Path(__file__).resolve().parents[3] / "web-app"

# Instruments seeded at session scope — must match the kebab-case IDs used
# by the Python `Instrument` enum and the S3 key prefix convention.
_INSTRUMENTS: dict[str, str] = {
    "azure-cielo-qpcr": "Azure Cielo qPCR",
    "azure-600-gel-doc": "Azure 600 Gel Doc",
    "spectramax-id3-plate-reader": "SpectraMax iD3 Plate Reader",
    "spectramax-id5-plate-reader": "SpectraMax iD5 Plate Reader",
}


# ---------------------------------------------------------------------------
# Data class yielded by the session fixture
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class IntegrationEnv:
    """Holds all parameters needed by integration tests."""

    base_url: str
    api_token: str
    db_dsn: str
    tmp_data_dir: Path


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_free_port() -> int:
    """Bind to port 0, grab the OS-assigned port, then release it.

    There is a TOCTOU race between releasing the socket and the server
    binding to the returned port — another process could claim it in
    between.  Extremely unlikely in CI (single job per runner) and rare
    on developer machines, but possible with parallel test runs.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for_server(
    url: str,
    timeout: float = 120,
    proc: subprocess.Popen[bytes] | None = None,
) -> None:
    """Poll *url* until it returns a non-5xx response.

    If *proc* is supplied the function checks whether the server process is
    still alive on every iteration.  When the process exits prematurely its
    stdout/stderr are included in the error message so the root cause is
    immediately visible.
    """
    import urllib.error
    import urllib.request

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc is not None and proc.poll() is not None:
            stdout = (proc.stdout.read() if proc.stdout else b"").decode(errors="replace")
            stderr = (proc.stderr.read() if proc.stderr else b"").decode(errors="replace")
            raise RuntimeError(
                f"Server process exited with code {proc.returncode} before becoming ready.\n"
                f"--- stdout ---\n{stdout[-4000:]}\n"
                f"--- stderr ---\n{stderr[-4000:]}"
            )
        try:
            resp = urllib.request.urlopen(url, timeout=5)  # noqa: S310
            if resp.status < 500:
                return
        except urllib.error.HTTPError:
            # Any HTTP response (even 5xx) proves the server is listening.
            return
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(0.5)

    extra = ""
    if proc is not None:
        alive = proc.poll() is None
        extra = f" (process still running: {alive})"
        if not alive:
            stdout = (proc.stdout.read() if proc.stdout else b"").decode(errors="replace")
            stderr = (proc.stderr.read() if proc.stderr else b"").decode(errors="replace")
            extra += f"\n--- stdout ---\n{stdout[-4000:]}\n--- stderr ---\n{stderr[-4000:]}"
    raise TimeoutError(f"Server at {url} did not start within {timeout}s{extra}")


def _generate_token() -> str:
    return _TOKEN_PREFIX + secrets.token_hex(32)


def _hash_token(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode()).hexdigest()


def _token_display_prefix(plaintext: str) -> str:
    # Stored in the DB for display (e.g. "dhub_a1b2…"). The server matches
    # this pattern: the full prefix ("dhub_") plus the first 4 hex chars.
    return plaintext[: len(_TOKEN_PREFIX) + 4]


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

    # Drop the cached HTTP client; get_client() will lazily create a new one
    # using the now-updated lambda_config values.
    _api_mod._client = None
    # Re-run __init__ on the *same* object instances rather than assigning new
    # ones.  This is necessary because process_file modules already hold
    # direct references via `from data_hub_shared.config import config`.
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

    # 1. Ensure the test database exists.
    admin_conn = psycopg2.connect(_PG_ADMIN_DSN)
    admin_conn.autocommit = True
    with admin_conn.cursor() as cur:
        cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (_TEST_DB,))
        if not cur.fetchone():
            cur.execute(f"CREATE DATABASE {_TEST_DB}")  # noqa: S608
    admin_conn.close()

    # 2. Push the Drizzle schema (mirrors web-app/tests/integration/global-setup.ts).
    # `--force` skips the interactive confirmation prompt for destructive changes.
    subprocess.run(
        ["npx", "drizzle-kit", "push", "--force"],
        cwd=str(_WEB_APP_DIR),
        env={**os.environ, "DATABASE_URL": _DATABASE_URL},
        check=True,
        capture_output=True,
    )

    # 3. Build and start the Next.js production server.
    port = _get_free_port()
    base_url = f"http://127.0.0.1:{port}"

    # AUTH_SECRET is required by NextAuth even though tests bypass sessions
    # (PAT auth).  AUTH_GOOGLE_* stubs prevent startup errors from the
    # Google OAuth provider config.  AWS creds are needed so the S3
    # pre-signer can compute HMAC signatures (it never makes network calls).
    server_env = {
        **os.environ,
        "DATABASE_URL": _DATABASE_URL,
        "AUTH_SECRET": "test-secret-at-least-32-characters-long!!",
        "AUTH_GOOGLE_ID": "stub",
        "AUTH_GOOGLE_SECRET": "stub",
        "AWS_ACCESS_KEY_ID": os.environ.get("AWS_ACCESS_KEY_ID", "test-key"),
        "AWS_SECRET_ACCESS_KEY": os.environ.get("AWS_SECRET_ACCESS_KEY", "test-secret"),
        "AWS_REGION": os.environ.get("AWS_REGION", "us-east-1"),
    }

    build_result = subprocess.run(
        ["npx", "next", "build"],
        cwd=str(_WEB_APP_DIR),
        env=server_env,
        capture_output=True,
    )
    if build_result.returncode != 0:
        raise RuntimeError(
            f"Next.js build failed (exit {build_result.returncode}).\n"
            f"--- stdout ---\n{build_result.stdout.decode(errors='replace')[-4000:]}\n"
            f"--- stderr ---\n{build_result.stderr.decode(errors='replace')[-4000:]}"
        )

    server_proc = subprocess.Popen(
        ["npx", "next", "start", "-p", str(port)],
        cwd=str(_WEB_APP_DIR),
        env=server_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    try:
        # 4. Wait for the server to become ready.
        _wait_for_server(base_url, proc=server_proc)

        # 5. Seed a user + personal access token directly via psycopg2.
        # We bypass the API for seeding because PAT creation requires an
        # authenticated session, and there is no session-based auth in tests.
        # The server only stores the SHA-256 hash — the plaintext is returned
        # here for use in `Authorization: Bearer dhub_…` headers.
        token_plaintext = _generate_token()
        conn = psycopg2.connect(_PG_TEST_DSN)
        conn.autocommit = True
        with conn.cursor() as cur:
            user_id = secrets.token_hex(16)
            cur.execute(
                'INSERT INTO "user" (id, name, email) VALUES (%s, %s, %s)',
                (user_id, "Integration Test User", f"integ-{user_id[:8]}@example.com"),
            )
            cur.execute(
                """INSERT INTO personal_access_tokens
                       (user_id, name, token_hash, token_prefix)
                   VALUES (%s, %s, %s, %s)""",
                (
                    user_id,
                    "integration-test-token",
                    _hash_token(token_plaintext),
                    _token_display_prefix(token_plaintext),
                ),
            )

            # 6. Seed instrument rows.
            for inst_id, display_name in _INSTRUMENTS.items():
                cur.execute(
                    """INSERT INTO instruments (id, display_name)
                       VALUES (%s, %s)
                       ON CONFLICT (id) DO NOTHING""",
                    (inst_id, display_name),
                )
        conn.close()

        # 7. Set env vars for Lambda modules and reset singletons so
        # DataHubClient / Config pick up the test server URL.
        tmp_data = tmp_path_factory.mktemp("data")
        os.environ["DATA_HUB_API_URL"] = f"{base_url}/api/v1"
        os.environ["DATA_HUB_API_KEY"] = token_plaintext
        os.environ["AWS_S3_RAW_DATA_BUCKET"] = "test-bucket"
        os.environ["AWS_S3_PROCESSED_DATA_BUCKET"] = "test-processed-bucket"
        os.environ["LOCAL_DATA_DIRPATH"] = str(tmp_data)

        _reset_singletons()

        yield IntegrationEnv(
            base_url=base_url,
            api_token=token_plaintext,
            db_dsn=_PG_TEST_DSN,
            tmp_data_dir=tmp_data,
        )
    finally:
        # 8. Teardown — kill the Next.js server.
        server_proc.terminate()
        try:
            server_proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server_proc.kill()

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
_DATA_TABLES = ["run_report_data", "files", "instrument_runs"]


@pytest.fixture(autouse=True)
def reset_db(integration_env: IntegrationEnv) -> None:
    """Truncate data tables between tests, preserving instruments and the PAT."""
    conn = psycopg2.connect(integration_env.db_dsn)
    conn.autocommit = True
    with conn.cursor() as cur:
        for table in _DATA_TABLES:
            cur.execute(f"TRUNCATE TABLE {table} CASCADE")  # noqa: S608
    conn.close()


# ---------------------------------------------------------------------------
# Step 3a — S3 event factory
# ---------------------------------------------------------------------------


@pytest.fixture()
def make_s3_event() -> Callable[..., dict[str, Any]]:
    """Factory fixture that builds realistic S3 event dicts.

    Usage::

        def test_example(make_s3_event):
            event = make_s3_event("azure-cielo-qpcr", "Experiment_20260101_CqValues.csv")
    """

    def _factory(
        instrument_id: str,
        filename: str,
        bucket: str = "test-bucket",
    ) -> dict[str, Any]:
        s3_key = f"{instrument_id}/{filename}"
        return {
            "Records": [
                {
                    "eventVersion": "2.1",
                    "eventSource": "aws:s3",
                    "awsRegion": "us-east-1",
                    "eventName": "ObjectCreated:Put",
                    "s3": {
                        "bucket": {"name": bucket},
                        "object": {"key": s3_key, "size": 1024},
                    },
                }
            ]
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
        # Extract the S3 key (everything after the bucket name) from the URI.
        # e.g. "s3://test-bucket/azure-cielo-qpcr/file.csv" -> "azure-cielo-qpcr/file.csv"
        key = s3_uri.split("//", 1)[1].split("/", 1)[1]
        src = s3_fixture_files.get(key)
        if src is None:
            raise FileNotFoundError(
                f"No fixture registered for S3 key '{key}'. "
                f"Registered keys: {list(s3_fixture_files)}"
            )
        local_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, local_path)

    # Patch at the *source module* rather than each import site. This works
    # because process_file modules import the module object
    # (`from data_hub_shared import s3_utils`) and resolve `download_file`
    # via attribute lookup at call time, so they see the patched version.
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


# ---------------------------------------------------------------------------
# Step 3c — Slack mock
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def mock_slack() -> Generator[MagicMock, None, None]:
    """Patch `slack.send_message` as a no-op (captures calls for assertions)."""
    with patch("data_hub_shared.slack.send_message") as mock:
        yield mock


# ---------------------------------------------------------------------------
# Step 5 — mock Lambda context
# ---------------------------------------------------------------------------


@pytest.fixture()
def mock_context() -> MagicMock:
    """Lightweight mock for `aws_lambda_typing.context.Context`.

    Provides the attributes accessed by `get_cloudwatch_logs_url` so it
    doesn't crash on the failure path.
    """
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
