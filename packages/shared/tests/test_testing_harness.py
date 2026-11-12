"""Unit tests for the integration-test harness in ``data_hub_shared.testing``.

These run without Postgres or a Next.js server. They cover the pure pieces
(session cookie, Postgres settings, server environment) and the process
handling, using small throwaway child processes.
"""

from __future__ import annotations
import binascii
import dataclasses
import hashlib
import hmac
import os
import select
import signal
import subprocess
import sys
import textwrap
import time
from collections.abc import Generator
from contextlib import contextmanager, suppress
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock
from urllib.parse import unquote

import pytest

from data_hub_shared import testing
from data_hub_shared.testing import (
    AUTH_SECRET,
    CRON_SECRET,
    AdminSession,
    IntegrationEnv,
    seed_admin_session,
    wait_for_server,
)

posix_only = pytest.mark.skipif(sys.platform == "win32", reason="POSIX process groups")

# ---------------------------------------------------------------------------
# Session cookie
# ---------------------------------------------------------------------------

# Produced by calling `makeSignature` from `better-auth/crypto` and
# `encodeURIComponent` (the code in web/tests/integration/helpers.ts) with this
# token and secret. The signature holds "+", "/" and a trailing "=".
_GOLDEN_SECRET = "test-secret-at-least-32-characters-long!!"
_GOLDEN_TOKEN = "jv1haKBV0eRYY8I36z_qsr6U8Qt8zcW_i7VDBcixn38"
_GOLDEN_SIGNATURE = "UiSc38kD8xMSM+LkbJ/oAsVsuJ71ZFi+CLp1QdbiG2w="
_GOLDEN_COOKIE = (
    "better-auth.session_token="
    "jv1haKBV0eRYY8I36z_qsr6U8Qt8zcW_i7VDBcixn38."
    "UiSc38kD8xMSM%2BLkbJ%2FoAsVsuJ71ZFi%2BCLp1QdbiG2w%3D"
)


def test_auth_secret_is_long_enough_for_better_auth() -> None:
    assert len(AUTH_SECRET) >= 32
    assert AUTH_SECRET == _GOLDEN_SECRET


def test_signature_matches_the_better_auth_value() -> None:
    assert testing._sign_session_token(_GOLDEN_TOKEN, _GOLDEN_SECRET) == _GOLDEN_SIGNATURE


def test_cookie_header_matches_the_web_helper_byte_for_byte() -> None:
    assert testing._session_cookie_header(_GOLDEN_TOKEN, _GOLDEN_SECRET) == _GOLDEN_COOKIE


def test_cookie_value_percent_encodes_plus_slash_and_equals() -> None:
    value = testing._session_cookie_header(_GOLDEN_TOKEN, _GOLDEN_SECRET).split("=", 1)[1]
    assert "+" not in value
    assert "/" not in value
    assert "=" not in value
    assert "%2B" in value
    assert "%2F" in value
    assert "%3D" in value


def test_cookie_leaves_the_characters_encode_uri_component_leaves() -> None:
    # JavaScript's encodeURIComponent keeps ! * ' ( ) as they are.
    cookie = testing._session_cookie_header("a!b*c'd(e)f", _GOLDEN_SECRET)
    assert cookie.startswith("better-auth.session_token=a!b*c'd(e)f.")


def test_cookie_signature_is_recomputed_independently() -> None:
    token = "some-token_with-url_safe-chars"
    secret = "another-secret-for-this-test-only-123456"
    digest = hmac.digest(secret.encode(), token.encode(), hashlib.sha256)
    expected = binascii.b2a_base64(digest, newline=False).decode()

    name, _, encoded = testing._session_cookie_header(token, secret).partition("=")
    assert name == "better-auth.session_token"
    signed_token, _, signature = unquote(encoded).rpartition(".")
    assert signed_token == token
    assert signature == expected
    assert signature.endswith("=")  # 32 bytes of digest give one padding character


def test_cookie_changes_with_the_secret() -> None:
    assert testing._session_cookie_header("tok", "secret-one-secret-one-secret-one-1") != (
        testing._session_cookie_header("tok", "secret-two-secret-two-secret-two-2")
    )


# ---------------------------------------------------------------------------
# seed_admin_session
# ---------------------------------------------------------------------------


class _FakeCursor:
    def __init__(self, executed: list[tuple[str, tuple[Any, ...] | None]]) -> None:
        self._executed = executed

    def __enter__(self) -> _FakeCursor:
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def execute(self, sql: str, params: tuple[Any, ...] | None = None) -> None:
        self._executed.append((sql, params))


class _FakeConn:
    def __init__(self) -> None:
        self.executed: list[tuple[str, tuple[Any, ...] | None]] = []
        self.autocommit = False
        self.closed = False

    def cursor(self) -> _FakeCursor:
        return _FakeCursor(self.executed)

    def close(self) -> None:
        self.closed = True


def _install_fake_db(monkeypatch: pytest.MonkeyPatch) -> tuple[_FakeConn, list[str]]:
    conn = _FakeConn()
    dsns: list[str] = []

    def fake_connect(dsn: str) -> _FakeConn:
        dsns.append(dsn)
        return conn

    monkeypatch.setattr(testing.psycopg2, "connect", fake_connect)
    return conn, dsns


def test_seed_admin_session_inserts_an_admin_user_and_a_live_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn, dsns = _install_fake_db(monkeypatch)

    result = seed_admin_session("dbname=x")

    assert isinstance(result, AdminSession)
    assert dsns == ["dbname=x"]
    assert conn.autocommit is True
    assert conn.closed is True
    assert len(conn.executed) == 2

    user_sql, user_params = conn.executed[0]
    assert 'INSERT INTO "user"' in user_sql
    assert "is_admin" in user_sql
    assert user_params is not None
    assert user_params[0] == result.user_id
    assert user_params[-1] is True  # is_admin

    session_sql, session_params = conn.executed[1]
    assert 'INSERT INTO "session"' in session_sql
    assert "now() + interval" in session_sql  # expiresAt is in the future
    assert session_params is not None
    _session_id, token, session_user_id = session_params
    assert session_user_id == result.user_id

    # The cookie carries the stored token, signed with the default secret.
    assert result.cookie_header == testing._session_cookie_header(token, AUTH_SECRET)


def test_seed_admin_session_signs_with_the_given_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn, _ = _install_fake_db(monkeypatch)
    custom = "a-different-secret-that-is-long-enough-1234"

    result = seed_admin_session("dbname=x", auth_secret=custom)

    session_params = conn.executed[1][1]
    assert session_params is not None
    token = session_params[1]
    assert result.cookie_header == testing._session_cookie_header(token, custom)
    assert result.cookie_header != testing._session_cookie_header(token, AUTH_SECRET)


def test_seed_admin_session_makes_a_new_user_and_token_each_time(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_fake_db(monkeypatch)

    first = seed_admin_session("dbname=x")
    second = seed_admin_session("dbname=x")

    assert first.user_id != second.user_id
    assert first.cookie_header != second.cookie_header


def test_seed_admin_session_closes_the_connection_when_an_insert_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn, _ = _install_fake_db(monkeypatch)

    def boom(self: _FakeCursor, sql: str, params: tuple[Any, ...] | None = None) -> None:
        raise RuntimeError("insert failed")

    monkeypatch.setattr(_FakeCursor, "execute", boom)

    with pytest.raises(RuntimeError, match="insert failed"):
        seed_admin_session("dbname=x")
    assert conn.closed is True


# ---------------------------------------------------------------------------
# Postgres settings
# ---------------------------------------------------------------------------


def test_postgres_defaults_match_the_old_hard_coded_values() -> None:
    pg = testing._pg_settings_from_env({})

    assert pg.dsn("postgres") == (
        "dbname=postgres user=postgres password=postgres host=127.0.0.1 port=5432"
    )
    assert pg.dsn(testing._TEST_DB) == (
        "dbname=data_hub_test user=postgres password=postgres host=127.0.0.1 port=5432"
    )
    assert pg.database_url(testing._TEST_DB) == (
        "postgres://postgres:postgres@127.0.0.1:5432/data_hub_test"
    )


def test_postgres_settings_come_from_the_harness_environment_variables() -> None:
    pg = testing._pg_settings_from_env(
        {
            "DATA_HUB_TEST_PGHOST": "db.example.test",
            "DATA_HUB_TEST_PGPORT": "6543",
            "DATA_HUB_TEST_PGUSER": "tester",
            "DATA_HUB_TEST_PGPASSWORD": "s3cret",
        }
    )

    assert pg.dsn(testing._TEST_DB) == (
        "dbname=data_hub_test user=tester password=s3cret host=db.example.test port=6543"
    )
    assert pg.database_url(testing._TEST_DB) == (
        "postgres://tester:s3cret@db.example.test:6543/data_hub_test"
    )


def test_the_standard_libpq_variables_are_ignored() -> None:
    # A shell that points `psql` at another server must not send the harness there:
    # it creates a database, force-pushes a schema and truncates tables.
    pg = testing._pg_settings_from_env(
        {
            "PGHOST": "prod-db.example.test",
            "PGPORT": "6543",
            "PGUSER": "someone-else",
            "PGPASSWORD": "not-the-harness-password",
            "PGDATABASE": "something_else",
        }
    )

    assert (pg.host, pg.port, pg.user, pg.password) == ("127.0.0.1", 5432, "postgres", "postgres")


def test_postgres_settings_use_defaults_for_the_variables_that_are_unset() -> None:
    pg = testing._pg_settings_from_env({"DATA_HUB_TEST_PGPORT": "6543"})

    assert (pg.host, pg.port, pg.user, pg.password) == ("127.0.0.1", 6543, "postgres", "postgres")


def test_empty_host_port_and_user_fall_back_to_the_defaults() -> None:
    pg = testing._pg_settings_from_env(
        {"DATA_HUB_TEST_PGHOST": "", "DATA_HUB_TEST_PGPORT": "", "DATA_HUB_TEST_PGUSER": ""}
    )

    assert (pg.host, pg.port, pg.user) == ("127.0.0.1", 5432, "postgres")


def test_an_empty_password_variable_means_an_empty_password() -> None:
    pg = testing._pg_settings_from_env({"DATA_HUB_TEST_PGPASSWORD": ""})

    assert pg.password == ""
    assert "password=''" in pg.dsn("postgres")
    assert pg.database_url("postgres") == "postgres://postgres:@127.0.0.1:5432/postgres"


def test_postgres_settings_quote_special_characters() -> None:
    pg = testing._pg_settings_from_env({"DATA_HUB_TEST_PGPASSWORD": "p w'd\\/@:"})

    assert "password='p w\\'d\\\\/@:'" in pg.dsn("postgres")
    assert pg.database_url("postgres") == (
        "postgres://postgres:p%20w%27d%5C%2F%40%3A@127.0.0.1:5432/postgres"
    )


def test_postgres_url_brackets_an_ipv6_host() -> None:
    pg = testing._pg_settings_from_env({"DATA_HUB_TEST_PGHOST": "::1"})

    assert pg.database_url("postgres") == "postgres://postgres:postgres@[::1]:5432/postgres"


def test_postgres_port_must_be_an_integer() -> None:
    with pytest.raises(ValueError, match="DATA_HUB_TEST_PGPORT must be an integer"):
        testing._pg_settings_from_env({"DATA_HUB_TEST_PGPORT": "not-a-port"})


def test_a_socket_directory_is_not_a_valid_host() -> None:
    with pytest.raises(ValueError, match="not a socket directory"):
        testing._pg_settings_from_env({"DATA_HUB_TEST_PGHOST": "/var/run/postgresql"})


class _StopHere(Exception):
    pass


def test_start_test_server_reads_the_harness_variables_when_it_is_called(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DATA_HUB_TEST_PGHOST", "db.example.test")
    monkeypatch.setenv("DATA_HUB_TEST_PGPORT", "6543")
    monkeypatch.setenv("DATA_HUB_TEST_PGUSER", "tester")
    monkeypatch.setenv("DATA_HUB_TEST_PGPASSWORD", "s3cret")
    # The standard variables are set to something else, and must have no effect.
    monkeypatch.setenv("PGHOST", "elsewhere.example.test")
    monkeypatch.setenv("PGPORT", "1")
    monkeypatch.setenv("PGUSER", "someone-else")
    monkeypatch.setenv("PGPASSWORD", "nope")
    monkeypatch.setattr(testing.shutil, "which", lambda name: f"/fake/{name}")
    monkeypatch.setattr(testing, "_resolve_next_cli", lambda: Path("/fake/next"))
    dsns: list[str] = []

    def fake_connect(dsn: str) -> None:
        dsns.append(dsn)
        raise _StopHere

    monkeypatch.setattr(testing.psycopg2, "connect", fake_connect)

    with pytest.raises(_StopHere), testing.start_test_server():
        pass

    assert dsns == ["dbname=postgres user=tester password=s3cret host=db.example.test port=6543"]


# ---------------------------------------------------------------------------
# npx
# ---------------------------------------------------------------------------


def test_resolve_npx_returns_the_path_shutil_finds(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[str] = []

    def fake_which(name: str) -> str:
        seen.append(name)
        return r"C:\Program Files\nodejs\npx.cmd"

    monkeypatch.setattr(testing.shutil, "which", fake_which)

    assert testing._resolve_npx() == r"C:\Program Files\nodejs\npx.cmd"
    assert seen == ["npx"]


def test_resolve_npx_fails_with_a_clear_error_when_npx_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(testing.shutil, "which", lambda _name: None)

    with pytest.raises(RuntimeError, match=r"Could not find `npx` on PATH"):
        testing._resolve_npx()


def test_start_test_server_checks_for_npx_before_touching_postgres(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(testing.shutil, "which", lambda _name: None)

    def fail_connect(dsn: str) -> None:
        raise AssertionError("connected to Postgres before checking for npx")

    monkeypatch.setattr(testing.psycopg2, "connect", fail_connect)

    with pytest.raises(RuntimeError, match="npx"), testing.start_test_server():
        pass


def test_resolve_node_returns_the_path_shutil_finds(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[str] = []

    def fake_which(name: str) -> str:
        seen.append(name)
        return r"C:\Program Files\nodejs\node.exe"

    monkeypatch.setattr(testing.shutil, "which", fake_which)

    assert testing._resolve_node() == r"C:\Program Files\nodejs\node.exe"
    assert seen == ["node"]


def test_resolve_node_fails_with_a_clear_error_when_node_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(testing.shutil, "which", lambda _name: None)

    with pytest.raises(RuntimeError, match=r"Could not find `node` on PATH"):
        testing._resolve_node()


def test_the_next_cli_is_the_script_in_the_web_dir() -> None:
    assert testing._NEXT_CLI == (
        testing._WEB_DIR / "node_modules" / "next" / "dist" / "bin" / "next"
    )


def test_resolve_next_cli_returns_the_script_when_it_exists(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    script = tmp_path / "next"
    script.write_text("")
    monkeypatch.setattr(testing, "_NEXT_CLI", script)

    assert testing._resolve_next_cli() == script


def test_resolve_next_cli_says_to_install_the_web_packages_when_it_is_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    missing = tmp_path / "node_modules" / "next" / "dist" / "bin" / "next"
    monkeypatch.setattr(testing, "_NEXT_CLI", missing)

    with pytest.raises(RuntimeError, match=r"Could not find Next\.js at .*npm ci"):
        testing._resolve_next_cli()


@pytest.mark.parametrize("missing", ["node", "next"])
def test_start_test_server_checks_for_node_and_next_before_touching_postgres(
    missing: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(
        testing.shutil, "which", lambda name: None if name == missing else f"/fake/{name}"
    )
    monkeypatch.setattr(testing, "_NEXT_CLI", tmp_path / "missing-next")
    if missing == "node":
        (tmp_path / "missing-next").write_text("")  # Only node is missing.

    def fail_connect(dsn: str) -> None:
        raise AssertionError("connected to Postgres before checking for node and Next.js")

    monkeypatch.setattr(testing.psycopg2, "connect", fail_connect)

    with pytest.raises(RuntimeError, match=r"`node`|Next\.js"), testing.start_test_server():
        pass


def test_run_npx_runs_the_resolved_path_and_reports_output_on_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[list[str]] = []

    def fake_run(cmd: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 2, b"the stdout", b"the stderr")

    monkeypatch.setattr(testing.subprocess, "run", fake_run)

    with pytest.raises(RuntimeError, match=r"Next\.js build failed \(exit 2\)") as exc:
        testing._run_npx("/fake/npx", ["next", "build"], what="Next.js build", env={})

    assert calls == [["/fake/npx", "next", "build"]]
    assert "the stdout" in str(exc.value)
    assert "the stderr" in str(exc.value)


# ---------------------------------------------------------------------------
# Server environment
# ---------------------------------------------------------------------------


_BASE_URL = "http://127.0.0.1:4321"


def _server_env(
    base: dict[str, str], mirror: Path = Path("/mirror"), base_url: str = _BASE_URL
) -> dict[str, str]:
    return testing._build_server_env(
        base, database_url="postgres://db/x", s3_mirror_root=mirror, base_url=base_url
    )


_BLANKED = [
    "AWS_ROLE_ARN",
    "LAMBDA_FUNCTION_URL",
    "STALLED_PROCESSING_AFTER_MINUTES",
    "VERCEL",
    "VERCEL_PROJECT_PRODUCTION_URL",
]


def test_the_list_of_blanked_variables_is_what_these_tests_expect() -> None:
    assert sorted(testing._BLANKED_SERVER_ENV) == _BLANKED


@pytest.mark.parametrize("name", _BLANKED)
def test_server_env_blanks_the_variables_that_change_server_behavior(name: str) -> None:
    # Present in the inherited environment, the variable is emptied...
    inherited = _server_env({name: "from-the-developers-shell", "PATH": "/usr/bin"})
    # ...and absent from it, the variable is still there, empty. `next build` and
    # `next start` fill in a variable that is missing from `web/.env.local`, but leave one
    # alone that is set to an empty string.
    absent = _server_env({"PATH": "/usr/bin"})

    assert inherited[name] == ""
    assert absent[name] == ""
    assert inherited["PATH"] == "/usr/bin"


def test_server_env_keeps_the_other_inherited_variables() -> None:
    env = _server_env({"PATH": "/usr/bin", "SOMETHING_ELSE": "kept", "HOME": "/home/dev"})

    assert env["PATH"] == "/usr/bin"
    assert env["SOMETHING_ELSE"] == "kept"
    assert env["HOME"] == "/home/dev"


def test_server_env_points_better_auth_at_the_servers_own_http_address() -> None:
    inherited = _server_env({"BETTER_AUTH_URL": "https://data-hub.example.test"})

    assert inherited["BETTER_AUTH_URL"] == _BASE_URL
    assert _server_env({}, base_url="http://127.0.0.1:55555")["BETTER_AUTH_URL"] == (
        "http://127.0.0.1:55555"
    )
    # A `https` origin would make Better Auth look for a `__Secure-` session cookie.
    assert inherited["BETTER_AUTH_URL"].startswith("http://")


def test_server_env_does_not_change_the_environment_it_was_given() -> None:
    base = {"VERCEL": "1", "AUTH_SECRET": "mine", "BETTER_AUTH_URL": "https://x.example.test"}

    _server_env(base)

    assert base == {
        "VERCEL": "1",
        "AUTH_SECRET": "mine",
        "BETTER_AUTH_URL": "https://x.example.test",
    }


def test_server_env_sets_the_test_secrets_and_stand_in_settings(tmp_path: Path) -> None:
    env = _server_env({"AUTH_SECRET": "inherited", "CRON_SECRET": "inherited"}, tmp_path)

    assert env["DATABASE_URL"] == "postgres://db/x"
    assert env["AUTH_SECRET"] == AUTH_SECRET
    assert env["CRON_SECRET"] == CRON_SECRET
    assert env["INTEGRATION_TEST_S3_MIRROR"] == str(tmp_path)
    assert env["MULTIPART_THRESHOLD_BYTES"] == "1024"
    assert env["MULTIPART_PART_SIZE_BYTES"] == "1024"
    assert env["AUTH_GOOGLE_ID"] == "stub"
    assert env["AUTH_GOOGLE_SECRET"] == "stub"


def test_server_env_uses_stub_aws_settings_unless_the_caller_has_its_own() -> None:
    stubbed = _server_env({})
    assert stubbed["AWS_ACCESS_KEY_ID"] == "test-key"
    assert stubbed["AWS_SECRET_ACCESS_KEY"] == "test-secret"
    assert stubbed["AWS_REGION"] == "us-east-1"
    assert stubbed["S3_RAW_DATA_BUCKET"] == "data-hub-test-raw"

    inherited = _server_env(
        {
            "AWS_ACCESS_KEY_ID": "real-key",
            "AWS_SECRET_ACCESS_KEY": "real-secret",
            "AWS_REGION": "eu-west-1",
            "S3_RAW_DATA_BUCKET": "other-bucket",
        }
    )
    assert inherited["AWS_ACCESS_KEY_ID"] == "real-key"
    assert inherited["AWS_SECRET_ACCESS_KEY"] == "real-secret"
    assert inherited["AWS_REGION"] == "eu-west-1"
    assert inherited["S3_RAW_DATA_BUCKET"] == "other-bucket"


# ---------------------------------------------------------------------------
# IntegrationEnv
# ---------------------------------------------------------------------------


def test_integration_env_keeps_the_original_fields_first_and_adds_the_new_ones() -> None:
    assert [f.name for f in dataclasses.fields(IntegrationEnv)] == [
        "base_url",
        "api_token",
        "db_dsn",
        "server_log",
        "s3_mirror_root",
        "cron_secret",
        "auth_secret",
        "raw_bucket",
    ]


def test_integration_env_is_frozen(tmp_path: Path) -> None:
    env = IntegrationEnv(
        base_url="http://127.0.0.1:1",
        api_token="t",
        db_dsn="d",
        server_log=tmp_path / "server.log",
        s3_mirror_root=tmp_path / "s3",
        cron_secret=CRON_SECRET,
        auth_secret=AUTH_SECRET,
        raw_bucket="data-hub-test-raw",
    )
    with pytest.raises(dataclasses.FrozenInstanceError):
        env.base_url = "other"  # pyright: ignore[reportAttributeAccessIssue]


# ---------------------------------------------------------------------------
# Server log
# ---------------------------------------------------------------------------


def test_read_log_tail_returns_only_the_end_of_a_long_log(tmp_path: Path) -> None:
    log = tmp_path / "server.log"
    log.write_text("head-marker " + "x" * 10_000 + " tail-marker")

    tail = testing._read_log_tail(log, max_bytes=100)

    assert "tail-marker" in tail
    assert "head-marker" not in tail
    assert len(tail) <= 100


def test_read_log_tail_says_why_when_there_is_no_log(tmp_path: Path) -> None:
    assert "no server log" in testing._read_log_tail(None)
    assert "could not read" in testing._read_log_tail(tmp_path / "missing.log")


def test_wait_for_server_includes_the_log_tail_when_the_process_exits(tmp_path: Path) -> None:
    log = tmp_path / "server.log"
    log.write_text("boot error: port already in use\n")
    proc = subprocess.Popen([sys.executable, "-c", "import sys; sys.exit(3)"])
    proc.wait()

    with pytest.raises(RuntimeError) as exc:
        wait_for_server("http://127.0.0.1:9", timeout=5, proc=proc, log_path=log)

    assert "exited with code 3" in str(exc.value)
    assert "boot error: port already in use" in str(exc.value)


def test_wait_for_server_includes_the_log_tail_on_timeout(tmp_path: Path) -> None:
    log = tmp_path / "server.log"
    log.write_text("still compiling, please wait\n")
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        url = f"http://127.0.0.1:{testing.get_free_port()}"
        with pytest.raises(TimeoutError) as exc:
            wait_for_server(url, timeout=1, proc=proc, log_path=log)
    finally:
        proc.kill()
        proc.wait()

    assert "did not start within 1s" in str(exc.value)
    assert "process still running: True" in str(exc.value)
    assert "still compiling, please wait" in str(exc.value)


# ---------------------------------------------------------------------------
# Process groups and teardown
# ---------------------------------------------------------------------------


def test_posix_children_start_in_their_own_session() -> None:
    assert testing._process_group_kwargs("linux") == {"start_new_session": True}
    assert testing._process_group_kwargs("darwin") == {"start_new_session": True}


def test_windows_children_start_in_a_new_process_group() -> None:
    kwargs = testing._process_group_kwargs("win32")

    assert kwargs == {"creationflags": 0x200}  # CREATE_NEW_PROCESS_GROUP
    assert "start_new_session" not in kwargs


def test_taskkill_command_kills_the_whole_tree_by_pid() -> None:
    assert testing._taskkill_command(4321) == ["taskkill", "/T", "/F", "/PID", "4321"]


def test_windows_teardown_runs_taskkill_and_waits(monkeypatch: pytest.MonkeyPatch) -> None:
    run = MagicMock()
    monkeypatch.setattr(testing.subprocess, "run", run)
    proc = MagicMock()
    proc.pid = 4321

    testing._kill_tree_windows(proc, 7)

    assert run.call_args.args[0] == ["taskkill", "/T", "/F", "/PID", "4321"]
    proc.wait.assert_called_once_with(timeout=7)
    proc.kill.assert_not_called()


def test_windows_teardown_kills_the_server_directly_if_taskkill_does_not_finish_the_job(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(testing.subprocess, "run", MagicMock())
    proc = MagicMock()
    proc.pid = 4321
    proc.wait.side_effect = [subprocess.TimeoutExpired("node", 7), None]

    testing._kill_tree_windows(proc, 7)

    proc.kill.assert_called_once_with()


def test_windows_teardown_kills_the_server_directly_if_taskkill_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(testing.subprocess, "run", MagicMock(side_effect=FileNotFoundError))
    proc = MagicMock()
    proc.pid = 4321

    testing._kill_tree_windows(proc, 7)

    proc.kill.assert_called_once_with()


def test_terminate_process_tree_uses_the_teardown_for_this_platform(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    posix = MagicMock()
    windows = MagicMock()
    monkeypatch.setattr(testing, "_kill_tree_posix", posix)
    monkeypatch.setattr(testing, "_kill_tree_windows", windows)
    proc = MagicMock()

    testing._terminate_process_tree(proc, 3)

    if sys.platform == "win32":
        windows.assert_called_once_with(proc, 3)
        posix.assert_not_called()
    else:
        posix.assert_called_once_with(proc, 3)
        windows.assert_not_called()


# A process that starts one child and waits, like a server that forks a worker.
# Both print a line once their SIGTERM handling is set up, so a test can wait
# for that. The child holds the same stdout pipe as the wrapper, so the pipe
# reaches end-of-file only when both are gone. That makes the check immune to
# zombie processes, unlike `os.kill(pid, 0)`.
_WRAPPER_SRC = textwrap.dedent(
    """
    import signal, subprocess, sys, time

    if sys.argv[1] == "wrapper-ignores-sigterm":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    print("wrapper-ready", flush=True)
    subprocess.Popen([sys.executable, "-c", sys.argv[2]])
    time.sleep(120)
    """
)
_CHILD_IGNORES_SIGTERM_SRC = textwrap.dedent(
    """
    import signal, time
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    print("child-ready", flush=True)
    time.sleep(120)
    """
)
_CHILD_DEFAULT_SRC = textwrap.dedent(
    """
    import time
    print("child-ready", flush=True)
    time.sleep(120)
    """
)


@contextmanager
def _wrapper(mode: str, child_src: str) -> Generator[subprocess.Popen[bytes], None, None]:
    proc = subprocess.Popen(
        [sys.executable, "-c", _WRAPPER_SRC, mode, child_src],
        stdout=subprocess.PIPE,
        stdin=subprocess.DEVNULL,
        **testing._process_group_kwargs(),
    )
    try:
        assert proc.stdout is not None
        seen: set[bytes] = set()
        while seen != {b"wrapper-ready", b"child-ready"}:
            line = proc.stdout.readline().strip()
            assert line, f"wrapper exited early; saw {seen!r}"
            seen.add(line)
        yield proc
    finally:
        # Never leave test processes behind, even when an assertion fails.
        with suppress(ProcessLookupError, PermissionError):
            os.killpg(proc.pid, signal.SIGKILL)
        proc.wait()
        if proc.stdout is not None:
            proc.stdout.close()


def _pipe_reaches_eof(proc: subprocess.Popen[bytes], timeout: float) -> bool:
    assert proc.stdout is not None
    fd = proc.stdout.fileno()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if ready and os.read(fd, 4096) == b"":
            return True
    return False


@posix_only
def test_teardown_stops_the_wrapper_and_a_child_that_ignores_sigterm() -> None:
    with _wrapper("wrapper-default", _CHILD_IGNORES_SIGTERM_SRC) as proc:
        testing._terminate_process_tree(proc, grace=5)

        assert proc.poll() is not None
        assert _pipe_reaches_eof(proc, timeout=5), "the child outlived the wrapper"


@posix_only
def test_teardown_stops_the_whole_group_not_only_the_wrapper() -> None:
    with _wrapper("wrapper-default", _CHILD_DEFAULT_SRC) as proc:
        testing._terminate_process_tree(proc, grace=5)

        assert _pipe_reaches_eof(proc, timeout=5), "the child outlived the wrapper"


@posix_only
def test_teardown_escalates_to_sigkill_after_the_grace_period() -> None:
    with _wrapper("wrapper-ignores-sigterm", _CHILD_IGNORES_SIGTERM_SRC) as proc:
        started = time.monotonic()
        testing._terminate_process_tree(proc, grace=1)
        elapsed = time.monotonic() - started

        assert proc.returncode == -signal.SIGKILL
        assert elapsed >= 1  # it waited the full grace period first
        assert _pipe_reaches_eof(proc, timeout=5), "the child outlived the wrapper"


@posix_only
def test_teardown_is_quiet_when_the_process_is_already_gone() -> None:
    proc = subprocess.Popen([sys.executable, "-c", "pass"], **testing._process_group_kwargs())
    proc.wait()

    testing._terminate_process_tree(proc, grace=1)

    assert proc.returncode == 0


def _fake_node(tmp_path: Path, body: str) -> Path:
    script = tmp_path / "node"
    script.write_text(f"#!/bin/sh\n{body}\n")
    script.chmod(0o755)
    return script


_FAKE_NEXT = Path("/fake/web/node_modules/next/dist/bin/next")


@posix_only
def test_server_output_goes_to_the_log_file_instead_of_pipes(tmp_path: Path) -> None:
    # About 1 MB on each stream. Pipes that nobody reads would fill up and
    # block the process long before it finished.
    node = _fake_node(
        tmp_path,
        "head -c 1000000 /dev/zero | tr '\\0' o\n"
        "echo STDOUT-END\n"
        "head -c 1000000 /dev/zero | tr '\\0' e >&2\n"
        "echo STDERR-END >&2",
    )
    log = tmp_path / "server.log"

    proc = testing._start_server_process(str(node), _FAKE_NEXT, 12345, dict(os.environ), log)
    try:
        assert proc.wait(timeout=30) == 0
    finally:
        if proc.poll() is None:
            proc.kill()

    assert proc.stdout is None
    assert proc.stderr is None
    content = log.read_text()
    assert "STDOUT-END" in content
    assert "STDERR-END" in content
    assert len(content) > 2_000_000


@posix_only
def test_server_process_leads_its_own_process_group(tmp_path: Path) -> None:
    node = _fake_node(tmp_path, "exec sleep 60")
    proc = testing._start_server_process(
        str(node), _FAKE_NEXT, 12345, dict(os.environ), tmp_path / "server.log"
    )
    try:
        assert os.getpgid(proc.pid) == proc.pid
        assert os.getpgid(proc.pid) != os.getpgrp()
    finally:
        testing._terminate_process_tree(proc, grace=5)

    assert proc.poll() is not None


@posix_only
def test_server_is_node_running_the_next_script_on_localhost_only(tmp_path: Path) -> None:
    # The process that is started is `node` itself, with no `npx` wrapper in between, and it
    # is told to listen on 127.0.0.1. `next start` listens on every interface by default.
    node = _fake_node(tmp_path, 'echo "args: $*"')
    log = tmp_path / "server.log"

    proc = testing._start_server_process(str(node), _FAKE_NEXT, 4567, dict(os.environ), log)
    proc.wait(timeout=30)

    assert f"args: {_FAKE_NEXT} start -H 127.0.0.1 -p 4567" in log.read_text()


@posix_only
def test_server_runs_in_the_web_dir_with_the_given_environment(tmp_path: Path) -> None:
    node = _fake_node(tmp_path, 'echo "cwd: $(pwd -P)"; echo "marker: $SERVER_ENV_MARKER"')
    log = tmp_path / "server.log"

    proc = testing._start_server_process(
        str(node), _FAKE_NEXT, 4567, {**os.environ, "SERVER_ENV_MARKER": "set"}, log
    )
    proc.wait(timeout=30)

    content = log.read_text()
    assert f"cwd: {testing._WEB_DIR.resolve()}" in content
    assert "marker: set" in content
