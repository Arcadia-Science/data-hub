"""`DataHubClient.report_upload_failures` and how it splits a report into requests (1.4.5).

The watcher reports the files it gave up on with `POST /watchers/{id}/upload-failures`, up to
1000 per request. Data Hub writes one event and sends one notification per run and reason in
each request, so a run's files go in one request unless the run alone is larger. A server older
than 1.4.5 has no such route and answers with Next.js's HTML 404 page; the client returns `None`
for it, so the uploader falls back to cancelling each request. A JSON 404 with the code
`NOT_FOUND` is a watcher the server doesn't know, and is raised like any other error. The tests
send real requests through a `requests` session whose transport is replaced.
"""

from __future__ import annotations
import json
from collections.abc import Sequence
from typing import Any

import pytest
import requests
from requests.adapters import BaseAdapter

from data_hub_watcher.api_client import (
    ApiError,
    DataHubClient,
    UploadFailure,
    chunk_upload_failures,
    is_route_missing,
)
from data_hub_watcher.constants import (
    MAX_UPLOAD_FAILURES_PER_REQUEST,
    UPLOAD_FAILURE_DETAIL_MAX_LENGTH,
)
from data_hub_watcher.models import ApiErrorDetail

WATCHER_ID = "7d0e63a2-7a7c-4d4b-a3c4-0d9b9a3f5c11"
HTML_404 = "<html><body><h1>404 Not Found</h1></body></html>"


class _Adapter(BaseAdapter):
    """Answers requests in turn with the given (status, body, content type), and keeps them."""

    def __init__(self, answers: Sequence[tuple[int, str, str]]) -> None:
        super().__init__()
        self._answers = list(answers)
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
        status, body, content_type = self._answers[min(len(self.sent), len(self._answers)) - 1]
        response = requests.Response()
        response.status_code = status
        response.headers["Content-Type"] = content_type
        response._content = body.encode()
        response.request = request
        return response

    def close(self) -> None:
        pass

    def bodies(self) -> list[list[dict[str, Any]]]:
        return [json.loads(request.body or b"{}")["files"] for request in self.sent]


def _client(*answers: tuple[int, str, str]) -> tuple[DataHubClient, _Adapter]:
    client = DataHubClient("http://example.test/api/v1", api_key="dhub_test")
    adapter = _Adapter(answers)
    client._session.mount("http://", adapter)
    return client, adapter


def _ok(failed: int, skipped: int = 0) -> tuple[int, str, str]:
    return 200, json.dumps({"failed": failed, "skipped": skipped}), "application/json"


def _error(status: int, code: str) -> tuple[int, str, str]:
    body = json.dumps({"error": {"code": code, "message": f"{code} message"}})
    return status, body, "application/json"


def _auto(run_id: str, name: str) -> UploadFailure:
    return UploadFailure(run_id=run_id, reason="file_missing", relative_path=f"{run_id}/{name}")


def _runs(*sizes: int) -> list[UploadFailure]:
    """*sizes[i]* files of run ``R{i}``, run by run."""
    return [_auto(f"R{i}", f"f{n}.csv") for i, size in enumerate(sizes) for n in range(size)]


def _run_ids(chunk: list[UploadFailure]) -> list[str]:
    return list(dict.fromkeys(failure.run_id for failure in chunk))


class TestChunks:
    def test_a_small_report_is_one_request(self) -> None:
        failures = _runs(3, 2)

        assert chunk_upload_failures(failures) == [failures]

    def test_a_runs_files_go_together_even_when_they_were_given_up_on_apart(self) -> None:
        a1, b1, a2 = _auto("A", "1.csv"), _auto("B", "1.csv"), _auto("A", "2.csv")

        assert chunk_upload_failures([a1, b1, a2]) == [[a1, a2, b1]]

    def test_a_run_that_does_not_fit_starts_the_next_request(self) -> None:
        chunks = chunk_upload_failures(_runs(6, 5, 3), limit=10)

        # Six and five don't fit in ten, so the second run moves to its own request with the
        # third, instead of being split.
        assert [len(chunk) for chunk in chunks] == [6, 8]
        assert [_run_ids(chunk) for chunk in chunks] == [["R0"], ["R1", "R2"]]

    def test_a_run_larger_than_the_limit_is_split_and_its_rest_shares_a_request(self) -> None:
        chunks = chunk_upload_failures(_runs(2, 25, 3), limit=10)

        assert [len(chunk) for chunk in chunks] == [2, 10, 10, 8]
        assert [_run_ids(chunk) for chunk in chunks] == [["R0"], ["R1"], ["R1"], ["R1", "R2"]]

    def test_a_run_that_fills_a_request_exactly_is_not_split(self) -> None:
        chunks = chunk_upload_failures(_runs(10, 1), limit=10)

        assert [len(chunk) for chunk in chunks] == [10, 1]

    def test_the_default_limit_is_the_servers(self) -> None:
        chunks = chunk_upload_failures(_runs(MAX_UPLOAD_FAILURES_PER_REQUEST + 1))

        assert [len(chunk) for chunk in chunks] == [MAX_UPLOAD_FAILURES_PER_REQUEST, 1]

    def test_nothing_is_no_request(self) -> None:
        assert chunk_upload_failures([]) == []


class TestPayload:
    def test_a_requested_file_is_named_by_its_id_and_echoes_its_request(self) -> None:
        failure = UploadFailure(
            run_id="R1",
            reason="folder_missing",
            file_id=42,
            requested_at="2026-11-16T10:00:00.123Z",
        )

        assert failure.payload() == {
            "file_id": 42,
            "requested_at": "2026-11-16T10:00:00.123Z",
            "reason": "folder_missing",
        }

    def test_an_auto_mode_file_is_named_by_its_run_and_path(self) -> None:
        failure = UploadFailure(
            run_id="R1", reason="upload_error", relative_path="R1/a.csv", detail="boom"
        )

        assert failure.payload() == {
            "run_id": "R1",
            "relative_path": "R1/a.csv",
            "reason": "upload_error",
            "detail": "boom",
        }

    def test_a_long_detail_is_cut_to_what_the_server_takes(self) -> None:
        failure = UploadFailure(run_id="R1", reason="upload_error", file_id=1, detail="x" * 5000)

        assert len(failure.payload()["detail"]) == UPLOAD_FAILURE_DETAIL_MAX_LENGTH

    def test_a_request_time_the_queue_did_not_send_is_left_out(self) -> None:
        failure = UploadFailure(run_id="R1", reason="file_missing", file_id=1)

        assert failure.payload() == {"file_id": 1, "reason": "file_missing"}


class TestReportUploadFailures:
    def test_it_posts_the_items_and_returns_the_counts(self) -> None:
        client, adapter = _client(_ok(failed=2, skipped=1))
        failures = [
            UploadFailure(run_id="R1", reason="file_missing", file_id=1, requested_at="t1"),
            _auto("R1", "a.csv"),
            _auto("R2", "b.csv"),
        ]

        counts = client.report_upload_failures(WATCHER_ID, failures)

        assert counts is not None
        assert (counts.failed, counts.skipped) == (2, 1)
        [request] = adapter.sent
        assert request.method == "POST"
        assert request.url == f"http://example.test/api/v1/watchers/{WATCHER_ID}/upload-failures"
        assert adapter.bodies() == [[failure.payload() for failure in failures]]

    def test_each_request_of_a_large_report_is_sent_and_the_counts_add_up(self) -> None:
        client, adapter = _client(_ok(failed=900, skipped=100), _ok(failed=5))
        failures = _runs(MAX_UPLOAD_FAILURES_PER_REQUEST - 5, 10)

        counts = client.report_upload_failures(WATCHER_ID, failures)

        assert counts is not None
        assert (counts.failed, counts.skipped) == (905, 100)
        assert [len(body) for body in adapter.bodies()] == [
            MAX_UPLOAD_FAILURES_PER_REQUEST - 5,
            10,
        ]

    def test_a_server_without_the_route_gives_none(self) -> None:
        client, _adapter = _client((404, HTML_404, "text/html; charset=utf-8"))

        assert client.report_upload_failures(WATCHER_ID, [_auto("R1", "a.csv")]) is None

    def test_a_json_404_for_an_unknown_watcher_is_raised(self) -> None:
        client, _adapter = _client(_error(404, "NOT_FOUND"))

        with pytest.raises(ApiError) as caught:
            client.report_upload_failures(WATCHER_ID, [_auto("R1", "a.csv")])

        assert caught.value.status_code == 404

    def test_a_server_error_is_raised(self) -> None:
        client, _adapter = _client(_error(500, "INTERNAL_ERROR"))

        with pytest.raises(ApiError) as caught:
            client.report_upload_failures(WATCHER_ID, [_auto("R1", "a.csv")])

        assert caught.value.status_code == 500
        assert caught.value.is_transient

    def test_a_failure_of_a_later_request_is_raised_after_the_earlier_ones(self) -> None:
        client, adapter = _client(_ok(failed=1000), _error(503, "UNAVAILABLE"))

        with pytest.raises(ApiError):
            client.report_upload_failures(WATCHER_ID, _runs(MAX_UPLOAD_FAILURES_PER_REQUEST, 1))

        assert len(adapter.sent) == 2


class TestIsRouteMissing:
    @pytest.mark.parametrize(
        ("exc", "missing"),
        [
            (ApiError("<html>", status_code=404), True),
            (
                ApiError(
                    "x", status_code=404, detail=ApiErrorDetail(code="ROUTE_GONE", message="x")
                ),
                True,
            ),
            (
                ApiError(
                    "x", status_code=404, detail=ApiErrorDetail(code="NOT_FOUND", message="x")
                ),
                False,
            ),
            (ApiError("x", status_code=500), False),
            (ApiError("x", status_code=0), False),
        ],
        ids=["html-404", "other-code", "not-found", "500", "no-response"],
    )
    def test_only_a_404_that_is_not_a_missing_record(self, exc: ApiError, missing: bool) -> None:
        assert is_route_missing(exc) is missing
