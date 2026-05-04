"""Shared integration-test infrastructure for Lambda and Watcher test suites.

Provides server lifecycle management (DB creation, schema push, Next.js
build/start), auth seeding, instrument seeding, and direct-DB helpers so
that both suites spin up an identical environment with minimal boilerplate.
"""

from __future__ import annotations
import hashlib
import os
import secrets
import socket
import subprocess
import time
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

import psycopg2

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

_TOKEN_PREFIX = "dhub_"

# testing.py lives at packages/shared/src/data_hub_shared/ — walk up 4 levels to the repo root.
_WEB_APP_DIR = Path(__file__).resolve().parents[4] / "web-app"


# ---------------------------------------------------------------------------
# Data class yielded by the session fixture
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class IntegrationEnv:
    """Holds all parameters needed by integration tests."""

    base_url: str
    api_token: str
    db_dsn: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def get_free_port() -> int:
    """Bind to port 0, grab the OS-assigned port, then release it."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for_server(
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


# ---------------------------------------------------------------------------
# Token helpers — must match web-app/lib/tokens.ts
# ---------------------------------------------------------------------------


def _generate_token() -> str:
    return _TOKEN_PREFIX + secrets.token_hex(32)


def _hash_token(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode()).hexdigest()


def _token_display_prefix(plaintext: str) -> str:
    return plaintext[: len(_TOKEN_PREFIX) + 4]


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------


def seed_auth(dsn: str) -> str:
    """Insert a user and personal access token, returning the plaintext token."""
    token_plaintext = _generate_token()
    conn = psycopg2.connect(dsn)
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
    conn.close()
    return token_plaintext


def seed_instruments(dsn: str, instruments: dict[str, str]) -> None:
    """Insert instrument rows (ON CONFLICT DO NOTHING)."""
    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    with conn.cursor() as cur:
        for inst_id, display_name in instruments.items():
            cur.execute(
                """INSERT INTO instruments (id, display_name)
                   VALUES (%s, %s)
                   ON CONFLICT (id) DO NOTHING""",
                (inst_id, display_name),
            )
    conn.close()


def truncate_tables(dsn: str, tables: list[str]) -> None:
    """Truncate the given tables with CASCADE."""
    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    with conn.cursor() as cur:
        for table in tables:
            cur.execute(f"TRUNCATE TABLE {table} CASCADE")  # noqa: S608
    conn.close()


def db_query(
    dsn: str, sql: str, params: tuple[object, ...] | None = None
) -> list[tuple[object, ...]]:
    """Execute a SELECT and return all rows."""
    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute(sql, params)
        rows: list[tuple[object, ...]] = cur.fetchall()
    conn.close()
    return rows


def db_update(dsn: str, sql: str, params: tuple[object, ...] | None = None) -> None:
    """Execute an UPDATE/INSERT directly for simulating server-side actions."""
    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute(sql, params)
    conn.close()


# ---------------------------------------------------------------------------
# Server lifecycle context manager
# ---------------------------------------------------------------------------


@contextmanager
def start_test_server() -> Generator[IntegrationEnv, None, None]:
    """Create the test DB, push schema, build + start Next.js, seed auth, and yield."""

    # 1. Ensure the test database exists.
    admin_conn = psycopg2.connect(_PG_ADMIN_DSN)
    admin_conn.autocommit = True
    with admin_conn.cursor() as cur:
        cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (_TEST_DB,))
        if not cur.fetchone():
            cur.execute(f"CREATE DATABASE {_TEST_DB}")  # noqa: S608
    admin_conn.close()

    # 2. Push the Drizzle schema.
    subprocess.run(
        ["npx", "drizzle-kit", "push", "--force"],
        cwd=str(_WEB_APP_DIR),
        env={**os.environ, "DATABASE_URL": _DATABASE_URL},
        check=True,
        capture_output=True,
    )

    # 3. Build and start the Next.js production server.
    port = get_free_port()
    base_url = f"http://127.0.0.1:{port}"

    server_env = {
        **os.environ,
        "DATABASE_URL": _DATABASE_URL,
        "AUTH_SECRET": "test-secret-at-least-32-characters-long!!",
        "AUTH_GOOGLE_ID": "stub",
        "AUTH_GOOGLE_SECRET": "stub",
        "AWS_ACCESS_KEY_ID": os.environ.get("AWS_ACCESS_KEY_ID", "test-key"),
        "AWS_SECRET_ACCESS_KEY": os.environ.get("AWS_SECRET_ACCESS_KEY", "test-secret"),
        "AWS_REGION": os.environ.get("AWS_REGION", "us-east-1"),
        "S3_RAW_DATA_BUCKET": os.environ.get("S3_RAW_DATA_BUCKET", "data-hub-test-raw"),
        # Stable defaults for the watcher update-check endpoint so Python
        # integration tests can assert on a known target version.
        "WATCHER_LATEST_VERSION": os.environ.get("WATCHER_LATEST_VERSION", "9.9.9"),
        "WATCHER_MIN_SUPPORTED_VERSION": os.environ.get("WATCHER_MIN_SUPPORTED_VERSION", "0.1.0"),
        "WATCHER_RELEASE_CHANNEL": os.environ.get("WATCHER_RELEASE_CHANNEL", "stable"),
        "WATCHER_MANDATORY_UPDATE": os.environ.get("WATCHER_MANDATORY_UPDATE", "false"),
        # Shared bearer token for Lambda → web-app callbacks (e.g. the
        # ``PATCH /api/v1/archive-jobs/:id`` callback issued by the
        # archive-builder code path). Defaulted to the same value the
        # Lambda conftest sets so both sides validate against each other
        # without the parent process needing to plumb anything.
        "LAMBDA_INVOKE_TOKEN": os.environ.get("LAMBDA_INVOKE_TOKEN", "test-invoke-token"),
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
        wait_for_server(base_url, proc=server_proc)

        # 5. Seed auth.
        token_plaintext = seed_auth(_PG_TEST_DSN)

        yield IntegrationEnv(
            base_url=base_url,
            api_token=token_plaintext,
            db_dsn=_PG_TEST_DSN,
        )
    finally:
        server_proc.terminate()
        try:
            server_proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server_proc.kill()
