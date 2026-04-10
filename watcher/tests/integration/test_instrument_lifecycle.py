"""Integration tests: instrument management endpoints used during `data-hub-watcher init`.

Tests list, create, get-detail, duplicate conflict, and not-found flows
that the watcher CLI exercises when setting up a new instrument.
"""

from __future__ import annotations

import pytest

from data_hub_watcher.api_client import ApiError, DataHubClient

pytestmark = pytest.mark.integration


class TestListInstruments:
    def test_list_instruments(self, client: DataHubClient, instrument_id: str) -> None:
        instruments = client.list_instruments()
        ids = [inst.id for inst in instruments]
        assert instrument_id in ids


class TestCreateInstrument:
    def test_create_instrument(self, client: DataHubClient) -> None:
        result = client.create_instrument("new-test-instrument")
        assert result.id == "new-test-instrument"
        assert result.status == "pending"
        assert result.display_name  # auto-generated, non-empty

    def test_create_instrument_with_display_name(self, client: DataHubClient) -> None:
        result = client.create_instrument("named-instrument", display_name="My Custom Name")
        assert result.id == "named-instrument"
        assert result.display_name == "My Custom Name"

    def test_create_instrument_duplicate_409(
        self, client: DataHubClient, instrument_id: str
    ) -> None:
        with pytest.raises(ApiError) as exc_info:
            client.create_instrument(instrument_id)
        assert exc_info.value.status_code == 409


class TestGetInstrumentDetail:
    def test_get_instrument_detail(self, client: DataHubClient, instrument_id: str) -> None:
        detail = client.get_instrument(instrument_id)
        assert detail.id == instrument_id
        assert detail.display_name == "Contract Test Instrument"
        assert detail.run_count == 0
        assert detail.watcher_count == 0

    def test_get_instrument_not_found_404(self, client: DataHubClient) -> None:
        with pytest.raises(ApiError) as exc_info:
            client.get_instrument("nonexistent-instrument")
        assert exc_info.value.status_code == 404
