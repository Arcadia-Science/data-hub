"""Shared integration-test infrastructure for Lambda and Watcher test suites.

Provides server lifecycle management (DB creation, schema push, Next.js
build/start), auth seeding, instrument seeding, and direct-DB helpers so
that both suites spin up an identical environment with minimal boilerplate.

The harness runs on POSIX and on Windows. It uses a local Postgres server on
``127.0.0.1:5432`` unless ``DATA_HUB_TEST_PGHOST``, ``DATA_HUB_TEST_PGPORT``,
``DATA_HUB_TEST_PGUSER`` or ``DATA_HUB_TEST_PGPASSWORD`` say otherwise. The
standard ``PG*`` variables are deliberately ignored.
"""

from __future__ import annotations
import base64
import hashlib
import hmac
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from collections.abc import Generator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import TypedDict
from urllib.parse import quote

import psycopg2

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_TEST_DB = "data_hub_test"

# The harness reads its own variable names, not libpq's `PGHOST`, `PGPORT`, `PGUSER` and
# `PGPASSWORD`. Developers often leave those pointing `psql` at some other server, and the
# harness creates a database, runs `drizzle-kit push --force` and truncates tables, so it
# must only go to a server it was told about.
_PG_HOST_VAR = "DATA_HUB_TEST_PGHOST"
_PG_PORT_VAR = "DATA_HUB_TEST_PGPORT"
_PG_USER_VAR = "DATA_HUB_TEST_PGUSER"
_PG_PASSWORD_VAR = "DATA_HUB_TEST_PGPASSWORD"

_DEFAULT_PG_HOST = "127.0.0.1"
_DEFAULT_PG_PORT = 5432
_DEFAULT_PG_USER = "postgres"
_DEFAULT_PG_PASSWORD = "postgres"

_TOKEN_PREFIX = "dhub_"

# Key the test server signs session cookies with. Better Auth needs at least
# 32 characters. `seed_admin_session` signs with the same value by default.
AUTH_SECRET = "test-secret-at-least-32-characters-long!!"

# Shared secret for the cron routes. Tests send it as
# `Authorization: Bearer <secret>`, for example to
# `/api/cron/upload-queue-sweep`.
CRON_SECRET = "test-cron-secret"

# Name of the Better Auth session cookie. There is no `__Secure-` prefix
# because Better Auth only adds it when the base URL is https, and the test
# server's is http.
_SESSION_COOKIE_NAME = "better-auth.session_token"

# Variables set to an empty string in the server's environment, so nothing a developer has
# set locally can change what the tests see. They are blanked, not deleted. `next build`
# and `next start` read `web/.env`, `web/.env.local` and `web/.env.production` for every
# variable that is missing from the process environment, so a deleted variable would be
# filled in again from a `web/.env.local` made by `vercel env pull`. Next.js leaves a
# variable alone when it is set, even to "", and everything in `web/` that reads these
# treats "" like unset.
#
# - `VERCEL`: the S3 stand-in turns itself off when it is set.
# - `LAMBDA_FUNCTION_URL`: switches on the paths that call the Lambda function.
# - `STALLED_PROCESSING_AFTER_MINUTES`: changes when a file counts as stalled.
# - `AWS_ROLE_ARN`: makes the server try to assume a role instead of using the test keys.
# - `VERCEL_PROJECT_PRODUCTION_URL`: gives the app an https origin. Better Auth then
#   expects a `__Secure-` cookie name, and the cookie from `seed_admin_session` is refused.
#
# `BETTER_AUTH_URL` gets the same treatment by being set to the server's own URL.
_BLANKED_SERVER_ENV = (
    "AWS_ROLE_ARN",
    "LAMBDA_FUNCTION_URL",
    "STALLED_PROCESSING_AFTER_MINUTES",
    "VERCEL",
    "VERCEL_PROJECT_PRODUCTION_URL",
)

# How long the server process tree gets to exit after SIGTERM before SIGKILL.
_SERVER_STOP_GRACE_SECONDS = 10.0

# testing.py lives at packages/shared/src/data_hub_shared/ — walk up 4 levels to the repo root.
_WEB_DIR = Path(__file__).resolve().parents[4] / "web"


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class IntegrationEnv:
    """Holds all parameters needed by integration tests.

    ``server_log`` is the file that receives the Next.js server's stdout and
    stderr. ``s3_mirror_root`` is the directory the server uses as its S3
    stand-in: objects land at ``<s3_mirror_root>/<bucket>/<key>``. Both live
    in a temp directory made for this session. ``cron_secret`` is the bearer
    token the cron routes accept, and ``auth_secret`` is the key that signs
    session cookies (see ``seed_admin_session``).
    """

    base_url: str
    api_token: str
    db_dsn: str
    server_log: Path
    s3_mirror_root: Path
    cron_secret: str
    auth_secret: str


@dataclass(frozen=True)
class AdminSession:
    """A seeded admin user and a ``Cookie`` header value that signs in as them."""

    user_id: str
    cookie_header: str


# ---------------------------------------------------------------------------
# Postgres settings
# ---------------------------------------------------------------------------


def _dsn_value(value: str) -> str:
    """Quote a libpq key/value DSN value when it needs it."""
    if value and not any(ch.isspace() or ch in "'\\" for ch in value):
        return value
    escaped = value.replace("\\", "\\\\").replace("'", "\\'")
    return f"'{escaped}'"


@dataclass(frozen=True)
class _PgSettings:
    host: str
    port: int
    user: str
    password: str

    def dsn(self, dbname: str) -> str:
        return (
            f"dbname={_dsn_value(dbname)} user={_dsn_value(self.user)} "
            f"password={_dsn_value(self.password)} host={_dsn_value(self.host)} port={self.port}"
        )

    def database_url(self, dbname: str) -> str:
        host = f"[{self.host}]" if ":" in self.host else self.host
        return (
            f"postgres://{quote(self.user, safe='')}:{quote(self.password, safe='')}"
            f"@{host}:{self.port}/{quote(dbname, safe='')}"
        )


def _pg_settings_from_env(env: Mapping[str, str] | None = None) -> _PgSettings:
    """Read ``DATA_HUB_TEST_PGHOST``, ``DATA_HUB_TEST_PGPORT``, ``DATA_HUB_TEST_PGUSER``
    and ``DATA_HUB_TEST_PGPASSWORD``.

    Unset or empty values fall back to the defaults, except the password: an empty
    ``DATA_HUB_TEST_PGPASSWORD`` means an empty password. The standard ``PG*`` variables
    are not read at all.
    """
    source = os.environ if env is None else env
    raw_port = source.get(_PG_PORT_VAR) or str(_DEFAULT_PG_PORT)
    try:
        port = int(raw_port)
    except ValueError:
        raise ValueError(f"{_PG_PORT_VAR} must be an integer, got {raw_port!r}") from None
    host = source.get(_PG_HOST_VAR) or _DEFAULT_PG_HOST
    if host.startswith("/"):
        # libpq accepts a socket directory as a host, but it can't go into a URL.
        raise ValueError(
            f"{_PG_HOST_VAR} must be a host name or address, not a socket directory, got {host!r}"
        )
    return _PgSettings(
        host=host,
        port=port,
        user=source.get(_PG_USER_VAR) or _DEFAULT_PG_USER,
        password=source.get(_PG_PASSWORD_VAR, _DEFAULT_PG_PASSWORD),
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def get_free_port() -> int:
    """Bind to port 0, grab the OS-assigned port, then release it."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _read_log_tail(path: Path | None, max_bytes: int = 4000) -> str:
    """Return the last *max_bytes* of a log file, or a note saying why not."""
    if path is None:
        return "(no server log)"
    try:
        with path.open("rb") as fh:
            fh.seek(0, os.SEEK_END)
            fh.seek(max(0, fh.tell() - max_bytes))
            data = fh.read()
    except OSError as exc:
        return f"(could not read {path}: {exc})"
    return data.decode(errors="replace")


def wait_for_server(
    url: str,
    timeout: float = 120,
    proc: subprocess.Popen[bytes] | None = None,
    log_path: Path | None = None,
) -> None:
    """Poll *url* until it returns a non-5xx response.

    If *proc* is supplied the function checks whether the server process is
    still alive on every iteration. When it fails, the error message includes
    the tail of *log_path* (the file the server writes its stdout and stderr
    to) so the root cause is immediately visible.
    """
    import urllib.error
    import urllib.request

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc is not None and proc.poll() is not None:
            raise RuntimeError(
                f"Server process exited with code {proc.returncode} before becoming ready.\n"
                f"--- server log ({log_path}) ---\n{_read_log_tail(log_path)}"
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
        extra = f" (process still running: {proc.poll() is None})"
    raise TimeoutError(
        f"Server at {url} did not start within {timeout}s{extra}\n"
        f"--- server log ({log_path}) ---\n{_read_log_tail(log_path)}"
    )


# ---------------------------------------------------------------------------
# Process helpers
# ---------------------------------------------------------------------------


def _resolve_npx() -> str:
    """Return the full path to ``npx``.

    On Windows the program is ``npx.cmd``, which ``CreateProcess`` won't find
    from the bare name ``npx``. ``shutil.which`` applies ``PATHEXT`` and
    returns the real path.
    """
    path = shutil.which("npx")
    if path is None:
        raise RuntimeError(
            "Could not find `npx` on PATH. Install Node.js (it includes npx) "
            "and make sure its directory is on PATH."
        )
    return path


class _ProcessGroupKwargs(TypedDict, total=False):
    start_new_session: bool
    creationflags: int


def _process_group_kwargs(platform: str = sys.platform) -> _ProcessGroupKwargs:
    """``Popen`` options that put the child in its own process group."""
    if platform == "win32":
        return {"creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x200)}
    return {"start_new_session": True}


def _taskkill_command(pid: int) -> list[str]:
    """The Windows command that kills *pid* and every process it started."""
    return ["taskkill", "/T", "/F", "/PID", str(pid)]


def _signal_group(pgid: int, sig: int) -> None:
    try:
        os.killpg(pgid, sig)
    except (ProcessLookupError, PermissionError):
        # The group is already gone. macOS answers PermissionError when only
        # zombies are left in it.
        pass


def _kill_tree_posix(proc: subprocess.Popen[bytes], grace: float) -> None:
    # `start_new_session=True` made the child its own group leader, so the
    # group id equals the child's pid.
    pgid = proc.pid
    _signal_group(pgid, signal.SIGTERM)
    try:
        proc.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        _signal_group(pgid, signal.SIGKILL)
        proc.wait()
    else:
        # The wrapper exited. Sweep up anything it left behind.
        _signal_group(pgid, signal.SIGKILL)


def _kill_tree_windows(proc: subprocess.Popen[bytes], grace: float) -> None:
    try:
        subprocess.run(_taskkill_command(proc.pid), capture_output=True, check=False)
    except OSError:
        proc.kill()
    try:
        proc.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


def _terminate_process_tree(
    proc: subprocess.Popen[bytes], grace: float = _SERVER_STOP_GRACE_SECONDS
) -> None:
    """Stop *proc* and everything it started.

    *proc* must have been started with ``_process_group_kwargs()``. On POSIX
    this sends SIGTERM to the process group, waits up to *grace* seconds, then
    sends SIGKILL. On Windows it runs ``taskkill /T /F``.
    """
    if sys.platform == "win32":
        _kill_tree_windows(proc, grace)
    else:
        _kill_tree_posix(proc, grace)


def _run_npx(npx: str, args: list[str], *, what: str, env: Mapping[str, str]) -> None:
    """Run ``npx <args>`` in the web dir, raising with its output on failure."""
    result = subprocess.run(
        [npx, *args],
        cwd=str(_WEB_DIR),
        env=dict(env),
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"{what} failed (exit {result.returncode}).\n"
            f"--- stdout ---\n{result.stdout.decode(errors='replace')[-4000:]}\n"
            f"--- stderr ---\n{result.stderr.decode(errors='replace')[-4000:]}"
        )


def _start_server_process(
    npx: str, port: int, env: Mapping[str, str], log_path: Path
) -> subprocess.Popen[bytes]:
    """Start ``next start`` in its own process group, logging to *log_path*.

    The server writes straight to the file, so nothing has to read a pipe. A
    long run can't fill a pipe and stall the server.
    """
    with log_path.open("wb") as log_file:
        return subprocess.Popen(
            [npx, "next", "start", "-p", str(port)],
            cwd=str(_WEB_DIR),
            env=dict(env),
            stdin=subprocess.DEVNULL,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            **_process_group_kwargs(),
        )


def _build_server_env(
    base_env: Mapping[str, str],
    *,
    database_url: str,
    s3_mirror_root: Path,
    base_url: str,
) -> dict[str, str]:
    """Build the environment for ``next build`` and ``next start``.

    *base_url* is the origin the server will listen on, for example
    ``http://127.0.0.1:54321``. It becomes ``BETTER_AUTH_URL``, so the app's idea of its
    own address is the one the tests use, and plain http.
    """
    env = dict(base_env)
    env.update(dict.fromkeys(_BLANKED_SERVER_ENV, ""))
    env.update(
        {
            "DATABASE_URL": database_url,
            "AUTH_SECRET": AUTH_SECRET,
            "AUTH_GOOGLE_ID": "stub",
            "AUTH_GOOGLE_SECRET": "stub",
            "AWS_ACCESS_KEY_ID": base_env.get("AWS_ACCESS_KEY_ID", "test-key"),
            "AWS_SECRET_ACCESS_KEY": base_env.get("AWS_SECRET_ACCESS_KEY", "test-secret"),
            "AWS_REGION": base_env.get("AWS_REGION", "us-east-1"),
            "S3_RAW_DATA_BUCKET": base_env.get("S3_RAW_DATA_BUCKET", "data-hub-test-raw"),
            # `next start` is production, so LOCAL_S3_MIRROR stays off. This
            # stand-in lets multipart tests run without AWS. The small threshold
            # is test-only; production leaves these unset.
            "INTEGRATION_TEST_S3_MIRROR": str(s3_mirror_root),
            "MULTIPART_THRESHOLD_BYTES": "1024",
            "MULTIPART_PART_SIZE_BYTES": "1024",
            "CRON_SECRET": CRON_SECRET,
            "BETTER_AUTH_URL": base_url,
            # Watcher release defaults are seeded into watcher_release_config
            # (see seed_watcher_release); the env-var fallback is gone.
        }
    )
    return env


# ---------------------------------------------------------------------------
# Token helpers — must match web/lib/tokens.ts
# ---------------------------------------------------------------------------


def _generate_token() -> str:
    return _TOKEN_PREFIX + secrets.token_hex(32)


def _hash_token(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode()).hexdigest()


def _token_display_prefix(plaintext: str) -> str:
    return plaintext[: len(_TOKEN_PREFIX) + 4]


# ---------------------------------------------------------------------------
# Session cookie helpers — must match makeSignature in better-auth/crypto and
# seedSessionCookie in web/tests/integration/helpers.ts
# ---------------------------------------------------------------------------


def _sign_session_token(token: str, auth_secret: str) -> str:
    """HMAC-SHA256 of *token* keyed by *auth_secret*, as padded standard base64."""
    digest = hmac.new(auth_secret.encode(), token.encode(), hashlib.sha256).digest()
    return base64.b64encode(digest).decode("ascii")


def _session_cookie_header(token: str, auth_secret: str) -> str:
    """The ``Cookie`` header value Better Auth accepts for *token*.

    The cookie value is ``<token>.<signature>``, percent-encoded the way
    JavaScript's ``encodeURIComponent`` does it. Python's ``quote`` differs
    only in leaving ``!*'()`` alone, which ``safe`` restores.
    """
    signed = quote(f"{token}.{_sign_session_token(token, auth_secret)}", safe="!*'()")
    return f"{_SESSION_COOKIE_NAME}={signed}"


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------


def seed_auth(dsn: str, scopes: list[str] | None = None) -> str:
    """Insert a user and personal access token, returning the plaintext token.

    Args:
        dsn: Postgres DSN for the test database.
        scopes: Permission scopes for the minted PAT. Defaults to ``["*"]``
            (wildcard) so existing suites keep full access. Pass an explicit
            list (e.g. the Lambda preset) to exercise least-privilege paths.
    """
    token_plaintext = _generate_token()
    token_scopes = scopes if scopes is not None else ["*"]
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
                   (created_by, name, token_hash, token_prefix, scopes)
               VALUES (%s, %s, %s, %s, %s)""",
            (
                user_id,
                "integration-test-token",
                _hash_token(token_plaintext),
                _token_display_prefix(token_plaintext),
                token_scopes,
            ),
        )
    conn.close()
    return token_plaintext


def seed_admin_session(dsn: str, *, auth_secret: str = AUTH_SECRET) -> AdminSession:
    """Insert an admin user and a live session, returning a signed session cookie.

    Admin-only routes accept a Better Auth session cookie, not a personal
    access token. This mirrors ``seedSessionCookie`` in
    ``web/tests/integration/helpers.ts``. Send ``AdminSession.cookie_header``
    as the ``Cookie`` header.

    Args:
        dsn: Postgres DSN for the test database.
        auth_secret: The ``AUTH_SECRET`` the server runs with. Defaults to the
            value ``start_test_server()`` gives it.
    """
    user_id = secrets.token_hex(16)
    # Same shape as the web helper: 32 random bytes, base64url without padding.
    token = secrets.token_urlsafe(32)
    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO "user" (id, name, email, "emailVerified", is_admin)
                   VALUES (%s, %s, %s, %s, %s)""",
                (
                    user_id,
                    "Integration Test Admin",
                    f"admin-{user_id[:8]}@example.com",
                    True,
                    True,
                ),
            )
            cur.execute(
                """INSERT INTO "session"
                       (id, token, "userId", "expiresAt", "createdAt", "updatedAt")
                   VALUES (%s, %s, %s, now() + interval '7 days', now(), now())""",
                (str(uuid.uuid4()), token, user_id),
            )
    finally:
        conn.close()
    return AdminSession(
        user_id=user_id,
        cookie_header=_session_cookie_header(token, auth_secret),
    )


def seed_watcher_release(
    dsn: str,
    *,
    latest_version: str = "9.9.9",
    min_supported_version: str = "0.1.0",
    mandatory: bool = False,
) -> None:
    """Upsert the singleton ``watcher_release_config`` row.

    The ``update-check`` endpoint reads from this table; tests assert on
    the seeded values. Previously these were plumbed via ``WATCHER_*``
    env vars; the source of truth is now the DB, edited via the
    admin-only ``/settings/watchers`` page in the web app.
    """
    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO watcher_release_config
                   (id, latest_version, min_supported_version, mandatory)
               VALUES
                   (true, %s, %s, %s)
               ON CONFLICT (id) DO UPDATE SET
                   latest_version = EXCLUDED.latest_version,
                   min_supported_version = EXCLUDED.min_supported_version,
                   mandatory = EXCLUDED.mandatory,
                   updated_at = now()""",
            (latest_version, min_supported_version, mandatory),
        )
    conn.close()


def seed_instruments(
    dsn: str,
    instruments: dict[str, str],
    *,
    instrument_types: dict[str, str] | None = None,
) -> None:
    """Insert instrument rows (ON CONFLICT DO NOTHING).

    Args:
        dsn: Postgres DSN for the test database.
        instruments: Mapping of instrument ID → display name.
        instrument_types: Optional mapping of instrument ID → ``instrument_type``
            enum value. Instruments omitted default to ``generic``.
    """
    types = instrument_types or {}
    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    with conn.cursor() as cur:
        for inst_id, display_name in instruments.items():
            instrument_type = types.get(inst_id, "generic")
            cur.execute(
                """INSERT INTO instruments (id, display_name, instrument_type)
                   VALUES (%s, %s, %s)
                   ON CONFLICT (id) DO NOTHING""",
                (inst_id, display_name, instrument_type),
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
    """Create the test DB, push schema, build + start Next.js, seed auth, and yield.

    Postgres comes from ``DATA_HUB_TEST_PGHOST``, ``DATA_HUB_TEST_PGPORT``,
    ``DATA_HUB_TEST_PGUSER`` and ``DATA_HUB_TEST_PGPASSWORD`` (read when this is
    called), and defaults to ``postgres:postgres@127.0.0.1:5432``. The server's output goes to
    ``IntegrationEnv.server_log`` and its S3 stand-in to
    ``IntegrationEnv.s3_mirror_root``, both in a temp directory that is left
    in place after the run so a failure can be inspected.
    """
    npx = _resolve_npx()
    pg = _pg_settings_from_env()
    admin_dsn = pg.dsn("postgres")
    test_dsn = pg.dsn(_TEST_DB)
    database_url = pg.database_url(_TEST_DB)

    # 1. Ensure the test database exists.
    admin_conn = psycopg2.connect(admin_dsn)
    admin_conn.autocommit = True
    with admin_conn.cursor() as cur:
        cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (_TEST_DB,))
        if not cur.fetchone():
            cur.execute(f"CREATE DATABASE {_TEST_DB}")  # noqa: S608
    admin_conn.close()

    # 2. Push the Drizzle schema.
    _run_npx(
        npx,
        ["drizzle-kit", "push", "--force"],
        what="drizzle-kit push",
        env={**os.environ, "DATABASE_URL": database_url},
    )

    # 2a. Seed the singleton watcher_release_config row so the
    #     update-check endpoint returns deterministic values during
    #     integration tests. Previously this came from WATCHER_* env
    #     vars; the source of truth is now the DB.
    seed_watcher_release(test_dsn)

    # 3. Build and start the Next.js production server.
    session_dir = Path(tempfile.mkdtemp(prefix="data-hub-it-")).resolve()
    server_log = session_dir / "server.log"
    s3_mirror_root = session_dir / "s3-mirror"
    s3_mirror_root.mkdir()

    port = get_free_port()
    base_url = f"http://127.0.0.1:{port}"

    server_env = _build_server_env(
        os.environ, database_url=database_url, s3_mirror_root=s3_mirror_root, base_url=base_url
    )
    _run_npx(npx, ["next", "build"], what="Next.js build", env=server_env)

    server_proc = _start_server_process(npx, port, server_env, server_log)

    try:
        # 4. Wait for the server to become ready.
        wait_for_server(base_url, proc=server_proc, log_path=server_log)

        # 5. Seed auth.
        token_plaintext = seed_auth(test_dsn)

        yield IntegrationEnv(
            base_url=base_url,
            api_token=token_plaintext,
            db_dsn=test_dsn,
            server_log=server_log,
            s3_mirror_root=s3_mirror_root,
            cron_secret=CRON_SECRET,
            auth_secret=AUTH_SECRET,
        )
    finally:
        _terminate_process_tree(server_proc)
