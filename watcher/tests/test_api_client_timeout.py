"""The timeouts of the requests a stop sends in a hurry: the final heartbeat and the events.

Windows gives the service about 10 s to stop at a restart, so those two requests take a short
timeout in place of the client's usual 5 s connect and 30 s read.
"""

from __future__ import annotations
import time
from unittest.mock import MagicMock

import pytest

from data_hub_watcher.api_client import DEFAULT_TIMEOUT, DataHubClient, timeout_until
from data_hub_watcher.constants import SYSTEM_SHUTDOWN_HTTP_TIMEOUT


def _client_answering(body: dict[str, object]) -> tuple[DataHubClient, MagicMock]:
    client = DataHubClient("http://example.test/api/v1", api_key="dhub_test")
    response = MagicMock()
    response.ok = True
    response.json.return_value = body
    request = MagicMock(return_value=response)
    client._session.request = request  # type: ignore[method-assign]
    return client, request


class TestTimeoutUntil:
    def test_a_distant_deadline_gives_the_shutdown_timeout(self) -> None:
        assert timeout_until(time.monotonic() + 60) == SYSTEM_SHUTDOWN_HTTP_TIMEOUT

    @pytest.mark.parametrize("left", [4.0, 2.0, 1.0])
    def test_the_connect_and_the_read_together_fit_in_what_is_left(self, left: float) -> None:
        connect, read = timeout_until(time.monotonic() + left)

        assert connect > 0
        assert read > 0
        assert connect + read <= left

    def test_a_deadline_that_has_passed_still_allows_a_short_request(self) -> None:
        connect, read = timeout_until(time.monotonic() - 10)

        assert 0 < connect + read <= 1


class TestRequestTimeouts:
    def test_the_heartbeat_takes_a_timeout_in_place_of_the_clients(self) -> None:
        client, request = _client_answering({"ok": True})

        client.send_heartbeat("w-1", {"status": "stopped"}, timeout=(2, 3))

        assert request.call_args.kwargs["timeout"] == (2, 3)

    def test_the_events_take_a_timeout_in_place_of_the_clients(self) -> None:
        client, request = _client_answering({"ok": True, "received": 1})

        client.send_events("w-1", [], timeout=(2, 3))

        assert request.call_args.kwargs["timeout"] == (2, 3)

    def test_without_one_the_clients_timeout_applies(self) -> None:
        client, request = _client_answering({"ok": True, "received": 1})

        client.send_heartbeat("w-1", {"status": "watching"})
        assert request.call_args.kwargs["timeout"] == DEFAULT_TIMEOUT
        client.send_events("w-1", [])
        assert request.call_args.kwargs["timeout"] == DEFAULT_TIMEOUT
