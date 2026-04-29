"""Integration tests: watcher update-check endpoint via DataHubClient.

The TS-side tests in `web-app/tests/integration/watchers.test.ts` cover
the HTTP shape; this file ensures the Python `DataHubClient` plumbing
parses the response into the typed `WatcherUpdateInfoResponse` model
correctly so the CLI / in-process updater can consume it.
"""

from __future__ import annotations

import pytest

from data_hub_shared.testing import IntegrationEnv, db_update
from data_hub_watcher.api_client import ApiError, DataHubClient

pytestmark = pytest.mark.integration


class TestUpdateCheck:
    def test_get_update_info_returns_seeded_release(
        self, client: DataHubClient, instrument_id: str
    ) -> None:
        watcher = client.register_watcher(instrument_id)
        info = client.get_update_info(watcher.watcher_id)

        # The seeded test server config (see data_hub_shared.testing)
        # advertises "9.9.9" so we always know what to compare against,
        # regardless of where the real release line is.
        assert info.latest_version == "9.9.9"
        assert info.min_supported_version == "0.1.0"
        assert info.channel == "stable"
        assert info.mandatory is False

    def test_get_update_info_returns_404_for_soft_deleted_watcher(
        self,
        client: DataHubClient,
        instrument_id: str,
        integration_env: IntegrationEnv,
    ) -> None:
        watcher = client.register_watcher(instrument_id)
        db_update(
            integration_env.db_dsn,
            "UPDATE watchers SET deleted_at = NOW() WHERE id = %s",
            (watcher.watcher_id,),
        )
        with pytest.raises(ApiError) as exc_info:
            client.get_update_info(watcher.watcher_id)
        assert exc_info.value.status_code == 404
