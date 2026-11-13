"""The timeouts of the requests a stop sends in a hurry: the final heartbeat and the events.

A stop has a limited time, so those two requests take the client's usual 5 s connect and 30 s
read timeout cut down to fit the time they have, or the shorter `SYSTEM_SHUTDOWN_HTTP_TIMEOUT`
when Windows is shutting down and gives the service about 10 s. A read timeout is marked on
the `ApiError`, so that a flush with a deadline doesn't send its batch again.
"""

from __future__ import annotations
import time
from unittest.mock import MagicMock

import pytest
import requests

from data_hub_watcher.api_client import DEFAULT_TIMEOUT, ApiError, DataHubClient, timeout_until
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
    @pytest.mark.parametrize("cap", [DEFAULT_TIMEOUT, SYSTEM_SHUTDOWN_HTTP_TIMEOUT, (1, 1.5)])
    def test_a_distant_deadline_gives_the_cap(self, cap: tuple[float, float]) -> None:
        assert timeout_until(time.monotonic() + 60, cap) == cap

    @pytest.mark.parametrize("cap", [DEFAULT_TIMEOUT, SYSTEM_SHUTDOWN_HTTP_TIMEOUT])
    @pytest.mark.parametrize("left", [4.0, 2.0, 1.0])
    def test_the_connect_and_the_read_together_fit_in_what_is_left(
        self, left: float, cap: tuple[float, float]
    ) -> None:
        connect, read = timeout_until(time.monotonic() + left, cap)

        assert connect > 0
        assert read > 0
        assert connect + read <= left

    @pytest.mark.parametrize("left", [20.0, 12.0])
    def test_a_slow_server_gets_the_time_that_is_left_not_a_smaller_cap(self, left: float) -> None:
        # The usual read timeout of 30 s is cut down only as far as the deadline needs, so a
        # server that takes 6 s to answer is waited for while the stop still has the time.
        connect, read = timeout_until(time.monotonic() + left, DEFAULT_TIMEOUT)

        assert connect == DEFAULT_TIMEOUT[0]
        assert read > 6
        assert connect + read == pytest.approx(left, abs=0.5)

    def test_a_deadline_that_has_passed_still_allows_a_short_request(self) -> None:
        connect, read = timeout_until(time.monotonic() - 10, DEFAULT_TIMEOUT)

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


class TestReadTimeoutIsMarked:
    """A read timeout means the request was sent, so the server may have acted on it."""

    @staticmethod
    def _client_failing_with(error: Exception) -> DataHubClient:
        client = DataHubClient("http://example.test/api/v1", api_key="dhub_test")
        client._session.request = MagicMock(side_effect=error)  # type: ignore[method-assign]
        return client

    def test_a_read_timeout_is_marked(self) -> None:
        client = self._client_failing_with(requests.ReadTimeout("slow"))

        with pytest.raises(ApiError) as raised:
            client.send_events("w-1", [])

        assert raised.value.read_timed_out is True
        assert raised.value.status_code == 0

    @pytest.mark.parametrize(
        "error",
        [requests.ConnectTimeout("no route"), requests.ConnectionError("refused")],
        ids=["connect-timeout", "connection-error"],
    )
    def test_a_failure_to_connect_is_not(self, error: Exception) -> None:
        client = self._client_failing_with(error)

        with pytest.raises(ApiError) as raised:
            client.send_events("w-1", [])

        assert raised.value.read_timed_out is False
        assert raised.value.is_transient

    def test_an_error_answer_is_not(self) -> None:
        client, request = _client_answering({})
        request.return_value.ok = False
        request.return_value.status_code = 503
        request.return_value.json.side_effect = ValueError("not JSON")
        request.return_value.text = "unavailable"

        with pytest.raises(ApiError) as raised:
            client.send_events("w-1", [])

        assert raised.value.read_timed_out is False
        assert raised.value.status_code == 503
