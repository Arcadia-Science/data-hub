"""Session-scoped and function-scoped fixtures for Watcher -> API integration tests.

These fixtures spin up a real Next.js server backed by Postgres so that
`DataHubClient` methods exercise the full HTTP path — mirroring how the
watcher operates on a real lab instrument PC.
"""

from __future__ import annotations
from collections.abc import Generator

import pytest

from data_hub_shared.testing import (
    IntegrationEnv,
    db_query,
    db_update,
    seed_instruments,
    start_test_server,
    truncate_tables,
)
from data_hub_watcher.api_client import DataHubClient

INSTRUMENT_ID = "watcher-contract-test"

# ---------------------------------------------------------------------------
# Session-scoped fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def integration_env() -> Generator[IntegrationEnv, None, None]:
    """Start a real Next.js server, push the DB schema, and seed auth + instruments."""
    with start_test_server() as env:
        seed_instruments(env.db_dsn, {INSTRUMENT_ID: "Contract Test Instrument"})
        yield env


@pytest.fixture(scope="session")
def client(integration_env: IntegrationEnv) -> DataHubClient:
    """A DataHubClient wired to the test server."""
    return DataHubClient(
        base_url=f"{integration_env.base_url}/api/v1",
        api_key=integration_env.api_token,
    )


@pytest.fixture(scope="session")
def instrument_id() -> str:
    """The pre-seeded instrument ID shared across all watcher tests."""
    return INSTRUMENT_ID


# ---------------------------------------------------------------------------
# Per-test DB reset
# ---------------------------------------------------------------------------

_WATCHER_TABLES = [
    "run_report_data",
    "files",
    "instrument_runs",
    "watcher_events",
    "watcher_heartbeats",
    "watchers",
]


@pytest.fixture(autouse=True)
def reset_watcher_data(integration_env: IntegrationEnv) -> None:
    """Truncate watcher-related tables between tests, preserving the seeded instrument and PAT."""
    truncate_tables(integration_env.db_dsn, _WATCHER_TABLES)
    db_update(
        integration_env.db_dsn,
        "DELETE FROM instruments WHERE id != %s",
        (INSTRUMENT_ID,),
    )


__all__ = [
    "INSTRUMENT_ID",
    "DataHubClient",
    "IntegrationEnv",
    "db_query",
    "db_update",
    "integration_env",
    "client",
    "instrument_id",
    "reset_watcher_data",
]
