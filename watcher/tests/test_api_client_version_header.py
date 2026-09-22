"""The watcher identifies its version on every API request."""

from data_hub_watcher.api_client import DataHubClient
from data_hub_watcher.constants import WATCHER_VERSION, WATCHER_VERSION_HEADER


def test_session_sends_the_watcher_version() -> None:
    client = DataHubClient("http://example.test/api/v1", api_key="dhub_test")
    assert client._session.headers[WATCHER_VERSION_HEADER] == WATCHER_VERSION
