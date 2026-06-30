"""Integration tests: watcher registration and config management.

Tests the `data-hub-watcher init` and startup flows — registering a watcher
against an instrument, pushing YAML config, and verifying checksum round-trips.
"""

from __future__ import annotations

import pytest

from data_hub_shared.testing import IntegrationEnv, db_query, db_update
from data_hub_watcher.api_client import ApiError, DataHubClient

pytestmark = pytest.mark.integration


# ------------------------------------------------------------------
# Registration
# ------------------------------------------------------------------


class TestRegisterWatcher:
    def test_register_watcher(
        self,
        client: DataHubClient,
        instrument_id: str,
        integration_env: IntegrationEnv,
    ) -> None:
        result = client.register_watcher(instrument_id, hostname="LAB-PC-01", os_info="Windows 11")
        assert result.watcher_id

        rows = db_query(
            integration_env.db_dsn,
            "SELECT status FROM watchers WHERE id = %s",
            (result.watcher_id,),
        )
        assert rows[0][0] == "registered"

    def test_register_watcher_unknown_instrument_404(self, client: DataHubClient) -> None:
        with pytest.raises(ApiError) as exc_info:
            client.register_watcher("nonexistent-instrument")
        assert exc_info.value.status_code == 404

    def test_register_watcher_inactive_instrument_400(
        self,
        client: DataHubClient,
        instrument_id: str,
        integration_env: IntegrationEnv,
    ) -> None:
        db_update(
            integration_env.db_dsn,
            "UPDATE instruments SET status = 'inactive' WHERE id = %s",
            (instrument_id,),
        )
        try:
            with pytest.raises(ApiError) as exc_info:
                client.register_watcher(instrument_id)
            assert exc_info.value.status_code == 400
        finally:
            db_update(
                integration_env.db_dsn,
                "UPDATE instruments SET status = 'active' WHERE id = %s",
                (instrument_id,),
            )

    def test_register_watcher_increments_watcher_count(
        self, client: DataHubClient, instrument_id: str
    ) -> None:
        client.register_watcher(instrument_id, hostname="LAB-PC-01")
        detail = client.get_instrument(instrument_id)
        assert detail.watcher_count == 1

    def test_register_watcher_active_conflict_409(
        self, client: DataHubClient, instrument_id: str
    ) -> None:
        """A second registration for an instrument with an active watcher must
        be rejected with 409 and surface the existing watcher id in details."""
        first = client.register_watcher(instrument_id, hostname="LAB-PC-01")

        with pytest.raises(ApiError) as exc_info:
            client.register_watcher(instrument_id, hostname="LAB-PC-02")

        assert exc_info.value.status_code == 409
        detail = exc_info.value.detail
        assert detail is not None
        assert detail.code == "CONFLICT"
        assert detail.details is not None
        assert detail.details.get("existing_watcher_id") == first.watcher_id

    def test_register_watcher_succeeds_after_deregister(
        self,
        client: DataHubClient,
        instrument_id: str,
        integration_env: IntegrationEnv,
    ) -> None:
        """Once the prior active watcher is soft-deleted, a fresh registration
        for the same instrument should succeed and return a new watcher id."""
        first = client.register_watcher(instrument_id, hostname="LAB-PC-01")

        db_update(
            integration_env.db_dsn,
            "UPDATE watchers SET deleted_at = now() WHERE id = %s",
            (first.watcher_id,),
        )

        second = client.register_watcher(instrument_id, hostname="LAB-PC-02")
        assert second.watcher_id
        assert second.watcher_id != first.watcher_id


# ------------------------------------------------------------------
# Config push / checksum
# ------------------------------------------------------------------


class TestConfig:
    def test_push_config(self, client: DataHubClient, instrument_id: str) -> None:
        watcher = client.register_watcher(instrument_id)
        result = client.push_config(
            watcher.watcher_id,
            config_yaml="version: 1\nenvironment: staging\n",
            checksum="abc123",
        )
        assert result.config_checksum == "abc123"

    def test_get_config_checksum_round_trip(
        self, client: DataHubClient, instrument_id: str
    ) -> None:
        watcher = client.register_watcher(instrument_id)
        client.push_config(watcher.watcher_id, config_yaml="v: 1", checksum="round-trip-hash")
        result = client.get_config_checksum(watcher.watcher_id)
        assert result is not None
        assert result.config_checksum == "round-trip-hash"

    def test_push_config_overwrite(self, client: DataHubClient, instrument_id: str) -> None:
        watcher = client.register_watcher(instrument_id)
        client.push_config(watcher.watcher_id, config_yaml="old: true", checksum="old-hash")
        client.push_config(watcher.watcher_id, config_yaml="new: true", checksum="new-hash")
        result = client.get_config_checksum(watcher.watcher_id)
        assert result is not None
        assert result.config_checksum == "new-hash"

    def test_get_config_checksum_before_push_returns_none(
        self, client: DataHubClient, instrument_id: str
    ) -> None:
        watcher = client.register_watcher(instrument_id)
        result = client.get_config_checksum(watcher.watcher_id)
        assert result is None
