"""The server's "watcher not found" reply, and `DataHubClient.get_watcher`.

A watcher whose registration was deleted on Data Hub gets a 404 whose JSON body has the error
code `NOT_FOUND` from every route that names it. Only that reply may mean "deregistered": an
HTML 404 page from a proxy or a failed deploy, another status and another code must not. The
tests send real requests through a `requests` session whose transport is replaced, so the
error is parsed by the client's own code, from a real `requests.Response`.
"""

from __future__ import annotations
import json
from typing import Any

import pytest
import requests
from requests.adapters import BaseAdapter

from data_hub_watcher.api_client import ApiError, DataHubClient

WATCHER_ID = "7d0e63a2-7a7c-4d4b-a3c4-0d9b9a3f5c11"

WATCHER = {
    "id": WATCHER_ID,
    "instrument_id": "example-instrument",
    "status": "watching",
    "config_yaml": None,
}

NOT_FOUND_BODY = json.dumps(
    {"error": {"code": "NOT_FOUND", "message": f"Watcher '{WATCHER_ID}' not found"}}
)


class _Adapter(BaseAdapter):
    """Answers every request with one status and body, and keeps the requests it got."""

    def __init__(self, status: int, body: str, content_type: str) -> None:
        super().__init__()
        self._status = status
        self._body = body
        self._content_type = content_type
        self.sent: list[requests.PreparedRequest] = []

    def send(
        self,
        request: requests.PreparedRequest,
        stream: bool = False,
        timeout: Any = None,
        verify: Any = True,
        cert: Any = None,
        proxies: Any = None,
    ) -> requests.Response:
        self.sent.append(request)
        response = requests.Response()
        response.status_code = self._status
        response.headers["Content-Type"] = self._content_type
        response._content = self._body.encode()
        response.request = request
        return response

    def close(self) -> None:
        pass


def _client_answering(
    status: int, body: str, content_type: str = "application/json"
) -> tuple[DataHubClient, _Adapter]:
    client = DataHubClient("http://example.test/api/v1", api_key="dhub_test")
    adapter = _Adapter(status, body, content_type)
    client._session.mount("http://", adapter)
    return client, adapter


def _error_of(status: int, body: str, content_type: str = "application/json") -> ApiError:
    client, _adapter = _client_answering(status, body, content_type)
    with pytest.raises(ApiError) as caught:
        client.get_watcher(WATCHER_ID)
    return caught.value


class TestIsNotFoundReply:
    def test_the_servers_own_not_found_reply_counts(self) -> None:
        error = _error_of(404, NOT_FOUND_BODY)

        assert error.status_code == 404
        assert error.detail is not None
        assert error.detail.code == "NOT_FOUND"
        assert error.is_not_found_reply is True

    def test_an_html_404_page_does_not_count(self) -> None:
        # What a proxy, a CDN or a deploy that is gone answers. There is no JSON error, so
        # there is no `detail` to read a code from.
        error = _error_of(
            404, "<html><body><h1>404 Not Found</h1></body></html>", "text/html; charset=utf-8"
        )

        assert error.status_code == 404
        assert error.detail is None
        assert error.is_not_found_reply is False

    @pytest.mark.parametrize(
        "body",
        [
            "",
            "null",
            "[]",
            '"not found"',
            '{"message": "Not Found"}',
            '{"error": "Not Found"}',
            # A code without a message is not the server's error shape.
            '{"error": {"code": "NOT_FOUND"}}',
        ],
        ids=["empty", "null", "list", "string", "no-error-key", "string-error", "no-message"],
    )
    def test_a_404_without_the_servers_error_body_does_not_count(self, body: str) -> None:
        error = _error_of(404, body)

        assert error.status_code == 404
        assert error.is_not_found_reply is False

    @pytest.mark.parametrize("code", ["VALIDATION_ERROR", "FORBIDDEN", "not_found", "NOT_FOUND "])
    def test_a_404_with_another_code_does_not_count(self, code: str) -> None:
        body = json.dumps({"error": {"code": code, "message": "something else"}})

        assert _error_of(404, body).is_not_found_reply is False

    @pytest.mark.parametrize("status", [400, 401, 403, 410, 500, 502, 503])
    def test_the_not_found_code_on_another_status_does_not_count(self, status: int) -> None:
        error = _error_of(status, NOT_FOUND_BODY)

        assert error.status_code == status
        assert error.detail is not None and error.detail.code == "NOT_FOUND"
        assert error.is_not_found_reply is False

    def test_a_connection_error_does_not_count(self) -> None:
        assert ApiError("Connection error: refused").is_not_found_reply is False


class TestGetWatcher:
    def test_it_gets_the_watcher_by_its_id(self) -> None:
        client, adapter = _client_answering(200, json.dumps(WATCHER))

        watcher = client.get_watcher(WATCHER_ID)

        (request,) = adapter.sent
        assert request.method == "GET"
        assert request.path_url == f"/api/v1/watchers/{WATCHER_ID}"
        assert watcher.id == WATCHER_ID

    def test_a_deregistered_watcher_raises_the_servers_not_found_error(self) -> None:
        client, _adapter = _client_answering(404, NOT_FOUND_BODY)

        with pytest.raises(ApiError) as caught:
            client.get_watcher(WATCHER_ID)

        assert caught.value.is_not_found_reply is True

    def test_a_heartbeat_gets_the_same_error_for_a_deregistered_watcher(self) -> None:
        client, _adapter = _client_answering(404, NOT_FOUND_BODY)

        with pytest.raises(ApiError) as caught:
            client.send_heartbeat(WATCHER_ID, {"status": "watching"})

        assert caught.value.is_not_found_reply is True
