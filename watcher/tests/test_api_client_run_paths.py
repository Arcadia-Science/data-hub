"""A run ID is sent as one literal segment of the URL path.

Run IDs come from folder names, file names and custom patterns, so they can hold characters that
mean something in a URL. The tests send real requests through a `requests` session whose
transport is replaced, so they check the path that goes on the wire, after `requests` has had its
say.
"""

from __future__ import annotations
import json
import re
from typing import Any
from urllib.parse import unquote

import pytest
import requests
from requests.adapters import BaseAdapter

from data_hub_watcher.api_client import DataHubClient

INSTRUMENT_ID = "example-instrument"
RUNS_PATH = f"/api/v1/instruments/{INSTRUMENT_ID}/runs"

RUN_DETAIL = {
    "id": "00000000-0000-0000-0000-000000000001",
    "instrument_id": INSTRUMENT_ID,
    "instrument_display_name": "Example instrument",
    "run_id": "RUN001",
    "source": "watcher",
    "created_at": "2026-01-01T00:00:00Z",
    "updated_at": "2026-01-01T00:00:00Z",
}
UPLOAD = {
    "upload_url": "https://s3.example.test/put",
    "upload_type": "single",
    "s3_bucket": "raw",
    "s3_key": f"{INSTRUMENT_ID}/RUN001/a.csv",
    "file_id": 1,
}

# Run IDs with characters that mean something in a URL. `.` and `..` are left out, because
# `urllib3` removes them from the path as dot segments.
AWKWARD_RUN_IDS = [
    "Plate#3",
    "Q%41",
    "100%",
    "50%25",
    "%2F",
    "a/b",
    "a?b=c",
    "a&b",
    "a;b",
    "a+b",
    "a b",
    "café",
    "ラン",
    "#",
    "%",
]

# A segment that is encoded all the way: each character is unreserved or a `%XX` escape.
ENCODED_SEGMENT = re.compile(r"(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})*")


class _RecordingAdapter(BaseAdapter):
    """Answers every request with `body` and keeps the request it got."""

    def __init__(self, body: dict[str, Any]) -> None:
        super().__init__()
        self._body = body
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
        response.status_code = 200
        response._content = json.dumps(self._body).encode()
        response.request = request
        return response

    def close(self) -> None:
        pass


def _client(body: dict[str, Any]) -> tuple[DataHubClient, _RecordingAdapter]:
    client = DataHubClient("http://example.test/api/v1", api_key="dhub_test")
    adapter = _RecordingAdapter(body)
    client._session.mount("http://", adapter)
    return client, adapter


def _only_request(adapter: _RecordingAdapter) -> requests.PreparedRequest:
    assert len(adapter.sent) == 1
    return adapter.sent[0]


def _run_segment(request: requests.PreparedRequest, suffix: str = "") -> str:
    """The run ID segment of the path that was sent, which must be followed by `suffix`."""
    path = request.path_url
    assert path.startswith(RUNS_PATH + "/")
    assert path.endswith(suffix)
    assert "?" not in path, f"part of the run ID went out as a query string: {path}"
    segments = path.removeprefix(RUNS_PATH + "/").removesuffix(suffix).split("/")
    assert len(segments) == 1, f"the run ID spread over several segments: {path}"
    # Also require every character to be unreserved or a `%XX` escape, which `unquote` doesn't
    # check, so that nothing is left for a server to read differently.
    assert ENCODED_SEGMENT.fullmatch(segments[0]), f"the run ID is not fully encoded: {path}"
    return segments[0]


@pytest.mark.parametrize("run_id", AWKWARD_RUN_IDS)
def test_an_update_names_the_run_by_its_exact_id(run_id: str) -> None:
    client, adapter = _client(RUN_DETAIL)

    client.update_run(INSTRUMENT_ID, run_id, {"detected_files": []})

    request = _only_request(adapter)
    assert request.method == "PATCH"
    # A server that decodes the path once reads the ID the watcher meant.
    assert unquote(_run_segment(request)) == run_id


@pytest.mark.parametrize("run_id", AWKWARD_RUN_IDS)
def test_an_upload_url_request_names_the_run_by_its_exact_id(run_id: str) -> None:
    client, adapter = _client(UPLOAD)

    client.request_upload_url(INSTRUMENT_ID, run_id, "a.csv")

    request = _only_request(adapter)
    assert request.method == "POST"
    assert unquote(_run_segment(request, "/request-upload-url")) == run_id


def test_a_hash_does_not_cut_the_path_short() -> None:
    client, adapter = _client(RUN_DETAIL)

    client.update_run(INSTRUMENT_ID, "Plate#3", {})

    assert _only_request(adapter).path_url == f"{RUNS_PATH}/Plate%233"


def test_a_percent_escape_in_the_id_is_not_decoded() -> None:
    client, adapter = _client(UPLOAD)

    client.request_upload_url(INSTRUMENT_ID, "Q%41", "a.csv")

    # `Q%41` is a run of its own, not `QA`.
    assert _only_request(adapter).path_url == f"{RUNS_PATH}/Q%2541/request-upload-url"


@pytest.mark.parametrize("run_id", ["RUN001", "2026-01-05_plate-3", "Run.v2", "a~b"])
def test_a_plain_id_is_sent_unchanged(run_id: str) -> None:
    client, adapter = _client(RUN_DETAIL)

    client.update_run(INSTRUMENT_ID, run_id, {})

    assert _only_request(adapter).path_url == f"{RUNS_PATH}/{run_id}"
