"""Integration tests: the harness's admin session cookie and cron secret.

`seed_admin_session` and `CRON_SECRET` in `data_hub_shared.testing` are only unit-tested
against a fake database. These tests send them to the real server, so a change to how
Better Auth signs cookies, or to how the cron route checks its secret, fails here.
"""

from __future__ import annotations
from collections.abc import Iterator

import pytest
import requests

from data_hub_shared.testing import IntegrationEnv, seed_admin_session

pytestmark = pytest.mark.integration

# Admin-only: it answers with `requireAdmin()`, which accepts a session cookie but not a
# personal access token.
ADMIN_ONLY_PATH = "/api/v1/settings/watcher-release"
CRON_PATH = "/api/cron/upload-queue-sweep"


@pytest.fixture
def http() -> Iterator[requests.Session]:
    with requests.Session() as session:
        # Ignore proxy settings in the environment: these requests are for localhost.
        session.trust_env = False
        yield session


class TestAdminSession:
    def test_the_cookie_signs_in_an_admin_and_no_cookie_is_refused(
        self, http: requests.Session, integration_env: IntegrationEnv
    ) -> None:
        admin = seed_admin_session(integration_env.db_dsn, auth_secret=integration_env.auth_secret)
        url = integration_env.base_url + ADMIN_ONLY_PATH

        signed_in = http.get(url, headers={"Cookie": admin.cookie_header}, timeout=30)
        anonymous = http.get(url, timeout=30)

        assert signed_in.status_code == 200
        # The harness seeds this release config row when it starts the server.
        assert signed_in.json()["latest_version"] == "9.9.9"
        assert anonymous.status_code == 401

    def test_a_personal_access_token_does_not_reach_an_admin_only_route(
        self, http: requests.Session, integration_env: IntegrationEnv
    ) -> None:
        response = http.get(
            integration_env.base_url + ADMIN_ONLY_PATH,
            headers={"Authorization": f"Bearer {integration_env.api_token}"},
            timeout=30,
        )

        assert response.status_code == 401

    def test_a_cookie_signed_with_another_secret_is_refused(
        self, http: requests.Session, integration_env: IntegrationEnv
    ) -> None:
        forged = seed_admin_session(
            integration_env.db_dsn, auth_secret="a-different-secret-that-is-long-enough-1234"
        )

        response = http.get(
            integration_env.base_url + ADMIN_ONLY_PATH,
            headers={"Cookie": forged.cookie_header},
            timeout=30,
        )

        assert response.status_code == 401


class TestCronSecret:
    def test_the_bearer_secret_is_accepted_and_no_secret_is_refused(
        self, http: requests.Session, integration_env: IntegrationEnv
    ) -> None:
        url = integration_env.base_url + CRON_PATH

        accepted = http.get(
            url, headers={"Authorization": f"Bearer {integration_env.cron_secret}"}, timeout=30
        )
        anonymous = http.get(url, timeout=30)
        wrong = http.get(url, headers={"Authorization": "Bearer not-the-secret"}, timeout=30)

        assert accepted.status_code == 200
        assert accepted.json() == {
            "swept_instruments": 0,
            "reverted_files": 0,
            "failed_instruments": 0,
        }
        assert anonymous.status_code == 401
        assert wrong.status_code == 401
