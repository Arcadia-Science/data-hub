"""Unit tests for the API client's error messages and retries.

Responses come from a mocked ``requests.Session.request``, so ``_request``,
``_handle_error``, and the retry loop all run for real. Sleeping and the
random jitter are patched, so the waits are fixed and nothing really waits.
"""

from __future__ import annotations
import json
import logging
from collections.abc import Callable, Iterator
from typing import Any
from unittest.mock import MagicMock, call, patch

import pytest
import requests

from data_hub_lambda.api_client import (
    _RETRY_DEADLINE_MARGIN_SECONDS,
    DEFAULT_TIMEOUT,
    ApiError,
    DataHubClient,
)
from data_hub_lambda.deadline import (
    ProcessingDeadlineError,
    check_deadline,
    set_deadline_from_remaining_ms,
)

BASE_URL = "https://example.test/api/v1"

RUN = {"id": "1", "instrument_id": "inst", "run_id": "run-1", "source": "lambda"}
FILE = {
    "id": 7,
    "instrument_run_id": "1",
    "filename": "a.nd2",
    "category": "raw",
    "status": "processing",
}


def _response(
    status: int,
    *,
    body: Any = None,
    text: str | None = None,
) -> requests.Response:
    """A real ``requests.Response``: ``body`` is sent as JSON, ``text`` as is."""
    resp = requests.Response()
    resp.status_code = status
    resp.encoding = "utf-8"
    if body is not None:
        resp._content = json.dumps(body).encode()
        resp.headers["Content-Type"] = "application/json"
    else:
        resp._content = (text or "").encode()
    return resp


def _unavailable() -> requests.Response:
    return _response(503, body={"error": {"code": "SERVICE_UNAVAILABLE", "message": "try later"}})


@pytest.fixture
def client() -> DataHubClient:
    return DataHubClient(base_url=BASE_URL, api_key="test-key")


@pytest.fixture(autouse=True)
def sleep() -> Iterator[MagicMock]:
    """Keep a retry from waiting for real, and let a test see the delays."""
    with patch("data_hub_lambda.api_client.time.sleep") as mock:
        yield mock


@pytest.fixture(autouse=True)
def jitter() -> Iterator[MagicMock]:
    """Add no jitter unless a test says otherwise.

    ``random.uniform(low, high)`` returns ``low``, which is 0, so every wait is
    its plain 1, 2, or 4 seconds. A test that needs jitter sets ``side_effect``.
    """
    with patch("data_hub_lambda.api_client.random.uniform") as mock:
        mock.side_effect = lambda low, high: low
        yield mock


class FakeClock:
    """A monotonic clock that only moves when a test or a retry wait moves it."""

    def __init__(self) -> None:
        self.now = 1000.0

    def monotonic(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


@pytest.fixture
def clock(sleep: MagicMock) -> Iterator[FakeClock]:
    """Time for the deadline module, moved forward by each retry's sleep.

    A test sets how much time the invocation has with ``_time_left``, and the
    retry waits then use it up, as they do in a real invocation.
    """
    fake = FakeClock()
    sleep.side_effect = fake.advance
    with patch("data_hub_lambda.deadline.time", fake):
        yield fake


def _time_left(seconds: float) -> None:
    """Record an invocation that the Lambda runtime kills in *seconds*."""
    set_deadline_from_remaining_ms(round(seconds * 1000))


def _send(client: DataHubClient, *outcomes: requests.Response | Exception) -> MagicMock:
    """Make the session return these outcomes in order. Returns the mock."""
    mock = MagicMock(side_effect=list(outcomes))
    client._session.request = mock
    return mock


class TestErrorMessage:
    def test_empty_500_body_names_the_status(self, client: DataHubClient) -> None:
        # What Next.js sends when a route handler throws.
        _send(client, _response(500))

        with pytest.raises(ApiError) as exc_info:
            client._request("GET", "/files/1")

        assert str(exc_info.value) == "Data Hub API returned HTTP 500 with no error message"
        assert exc_info.value.message == str(exc_info.value)
        assert exc_info.value.status_code == 500
        assert exc_info.value.detail is None

    def test_whitespace_only_body_counts_as_empty(self, client: DataHubClient) -> None:
        _send(client, _response(502, text=" \n"))

        with pytest.raises(ApiError) as exc_info:
            client._request("GET", "/files/1")

        assert str(exc_info.value) == "Data Hub API returned HTTP 502 with no error message"
        assert exc_info.value.status_code == 502

    def test_empty_message_in_error_envelope_uses_the_fallback(self, client: DataHubClient) -> None:
        _send(client, _response(500, body={"error": {"code": "INTERNAL_ERROR", "message": ""}}))

        with pytest.raises(ApiError) as exc_info:
            client._request("GET", "/files/1")

        assert str(exc_info.value) == "Data Hub API returned HTTP 500 with no error message"
        assert exc_info.value.detail is not None
        assert exc_info.value.detail.code == "INTERNAL_ERROR"

    def test_error_envelope_keeps_its_message(self, client: DataHubClient) -> None:
        _send(
            client,
            _response(404, body={"error": {"code": "NOT_FOUND", "message": "File '1' not found"}}),
        )

        with pytest.raises(ApiError) as exc_info:
            client._request("GET", "/files/1")

        assert str(exc_info.value) == "File '1' not found"
        assert exc_info.value.status_code == 404
        assert exc_info.value.detail is not None
        assert exc_info.value.detail.code == "NOT_FOUND"

    def test_plain_text_body_keeps_its_text(self, client: DataHubClient) -> None:
        _send(client, _response(502, text="Bad Gateway\n"))

        with pytest.raises(ApiError) as exc_info:
            client._request("GET", "/files/1")

        assert str(exc_info.value) == "Bad Gateway"
        assert exc_info.value.status_code == 502

    def test_json_body_without_an_error_key_keeps_its_text(self, client: DataHubClient) -> None:
        _send(client, _response(500, body={"detail": "boom"}))

        with pytest.raises(ApiError) as exc_info:
            client._request("GET", "/files/1")

        assert json.loads(str(exc_info.value)) == {"detail": "boom"}

    def test_public_calls_raise_the_same_message(self, client: DataHubClient) -> None:
        # Processors store str(error) as the file's error_message. The call
        # retries, so the last of its four attempts is the one that raises.
        _send(client, *[_response(500) for _ in range(4)])

        with pytest.raises(ApiError) as exc_info:
            client.update_file(7, status="failed", error_message="x")

        assert str(exc_info.value) == "Data Hub API returned HTTP 500 with no error message"


# A run ID is a folder name in the S3 key, so it can hold characters that mean
# something in a URL. Each pair is the ID and how it must appear in the path.
AWKWARD_RUN_IDS = [
    pytest.param("Plate#3", "Plate%233", id="hash"),
    pytest.param("Q%41", "Q%2541", id="percent-escape"),
    pytest.param("a?b", "a%3Fb", id="question-mark"),
    pytest.param("two words", "two%20words", id="space"),
    pytest.param("50%", "50%25", id="trailing-percent"),
    pytest.param("plus+sign", "plus%2Bsign", id="plus"),
    pytest.param("caf\u00e9", "caf%C3%A9", id="non-ascii"),
]


def _sent_url(session: MagicMock) -> str:
    """The URL of the one request that the mocked session received."""
    assert session.call_count == 1
    return session.call_args.args[1]


class TestRunIdInThePath:
    @pytest.mark.parametrize(("run_id", "encoded"), AWKWARD_RUN_IDS)
    def test_get_run_encodes_the_run_id(
        self, client: DataHubClient, run_id: str, encoded: str
    ) -> None:
        session = _send(client, _response(200, body={**RUN, "files": []}))

        client.get_run("inst", run_id)

        assert session.call_args.args[0] == "GET"
        assert _sent_url(session) == f"{BASE_URL}/instruments/inst/runs/{encoded}"

    @pytest.mark.parametrize(("run_id", "encoded"), AWKWARD_RUN_IDS)
    def test_update_run_encodes_the_run_id(
        self, client: DataHubClient, run_id: str, encoded: str
    ) -> None:
        session = _send(client, _response(200, body=RUN))

        client.update_run("inst", run_id, metadata={"k": 1})

        assert session.call_args.args[0] == "PATCH"
        assert _sent_url(session) == f"{BASE_URL}/instruments/inst/runs/{encoded}"

    @pytest.mark.parametrize(("run_id", "encoded"), AWKWARD_RUN_IDS)
    def test_create_file_encodes_the_run_id(
        self, client: DataHubClient, run_id: str, encoded: str
    ) -> None:
        session = _send(client, _response(201, body=FILE))

        client.create_file("inst", run_id, "bucket", f"inst/{run_id}/a.nd2", "a.nd2")

        assert session.call_args.args[0] == "POST"
        assert _sent_url(session) == f"{BASE_URL}/instruments/inst/runs/{encoded}/files"
        # The key in the body is data, not a path, so it stays as it is.
        assert session.call_args.kwargs["json"]["s3_key"] == f"inst/{run_id}/a.nd2"

    @pytest.mark.parametrize(("run_id", "encoded"), AWKWARD_RUN_IDS)
    def test_ensure_run_sends_the_run_id_in_the_body_unchanged(
        self, client: DataHubClient, run_id: str, encoded: str
    ) -> None:
        session = _send(client, _response(201, body=RUN))

        client.ensure_run("inst", run_id)

        assert _sent_url(session) == f"{BASE_URL}/instruments/inst/runs"
        assert session.call_args.kwargs["json"] == {"run_id": run_id, "source": "lambda"}

    def test_a_plain_run_id_is_unchanged(self, client: DataHubClient) -> None:
        session = _send(client, _response(200, body={**RUN, "files": []}))

        client.get_run("inst", "Experiment_2026-01-01.v2")

        assert _sent_url(session) == f"{BASE_URL}/instruments/inst/runs/Experiment_2026-01-01.v2"

    def test_an_encoded_url_reaches_the_server_as_built(self, client: DataHubClient) -> None:
        """`requests` must not decode the escapes again on the way out."""
        session = _send(client, _response(200, body={**RUN, "files": []}))

        client.get_run("inst", "Plate#3 Q%41")
        prepared = requests.Request("GET", _sent_url(session)).prepare()

        assert prepared.url == f"{BASE_URL}/instruments/inst/runs/Plate%233%20Q%2541"

    def test_a_slash_in_the_run_id_stays_inside_one_segment(self, client: DataHubClient) -> None:
        session = _send(client, _response(200, body={**RUN, "files": []}))

        client.get_run("inst", "a/b")

        assert _sent_url(session) == f"{BASE_URL}/instruments/inst/runs/a%2Fb"

    def test_the_instrument_id_is_encoded_too(self, client: DataHubClient) -> None:
        session = _send(client, _response(200, body={**RUN, "files": []}))

        client.get_run("in st", "run-1")

        assert _sent_url(session) == f"{BASE_URL}/instruments/in%20st/runs/run-1"

    def test_a_retry_sends_the_same_encoded_url(self, client: DataHubClient) -> None:
        session = _send(client, _unavailable(), _response(200, body={**RUN, "files": []}))

        client.get_run("inst", "Plate#3")

        urls = [c.args[1] for c in session.call_args_list]
        assert urls == [f"{BASE_URL}/instruments/inst/runs/Plate%233"] * 2


# Every call the client makes, each with the response body it parses.
_Call = Callable[[DataHubClient], object]
RETRIED_CALLS: list[tuple[str, _Call, dict[str, Any] | None]] = [
    ("ensure_run", lambda c: c.ensure_run("inst", "run-1"), RUN),
    (
        "create_file",
        lambda c: c.create_file("inst", "run-1", "bucket", "inst/run-1/a.nd2", "a.nd2"),
        FILE,
    ),
    ("update_run", lambda c: c.update_run("inst", "run-1", metadata={"k": 1}), RUN),
    ("get_run", lambda c: c.get_run("inst", "run-1"), {**RUN, "files": []}),
    ("update_file_processing", lambda c: c.update_file(7, status="processing"), FILE),
    ("update_file_no_status", lambda c: c.update_file(7, size_bytes=10, content_type="x/y"), FILE),
    ("update_file_metadata", lambda c: c.update_file(7, metadata={"k": 1}), FILE),
    ("update_file_completed", lambda c: c.update_file(7, status="completed"), FILE),
    (
        "update_file_completed_with_metadata",
        lambda c: c.update_file(7, status="completed", metadata={"k": 1}),
        FILE,
    ),
    (
        "update_file_failed",
        lambda c: c.update_file(7, status="failed", error_message="boom"),
        FILE,
    ),
    (
        "update_archive_job_ready",
        lambda c: c.update_archive_job("job", status="ready", archive_bucket="b", archive_key="k"),
        None,
    ),
    (
        "update_archive_job_failed",
        lambda c: c.update_archive_job("job", status="failed", error_message="boom"),
        None,
    ),
]


class TestRetries:
    @pytest.mark.parametrize(
        ("make_call", "payload"),
        [pytest.param(make, payload, id=name) for name, make, payload in RETRIED_CALLS],
    )
    def test_503_then_200_succeeds_after_one_retry(
        self,
        client: DataHubClient,
        sleep: MagicMock,
        make_call: _Call,
        payload: dict[str, Any] | None,
    ) -> None:
        session = _send(client, _unavailable(), _response(200, body=payload or {}))

        make_call(client)

        assert session.call_count == 2
        # Both attempts send the same request.
        assert session.call_args_list[0] == session.call_args_list[1]
        assert sleep.call_args_list == [call(1.0)]

    def test_every_attempt_sends_the_full_request(
        self, client: DataHubClient, sleep: MagicMock
    ) -> None:
        session = _send(client, _unavailable(), _unavailable(), _response(200, body=RUN))

        client.ensure_run("inst", "run-1")

        expected = call(
            "POST",
            f"{BASE_URL}/instruments/inst/runs",
            json={"run_id": "run-1", "source": "lambda"},
            timeout=DEFAULT_TIMEOUT,
        )
        assert session.call_args_list == [expected, expected, expected]

    def test_returns_the_parsed_response_of_the_retry(
        self, client: DataHubClient, sleep: MagicMock
    ) -> None:
        _send(client, _unavailable(), _response(200, body=RUN))

        run = client.ensure_run("inst", "run-1")

        assert run.run_id == "run-1"

    @pytest.mark.parametrize(
        "failure",
        [
            pytest.param(requests.ConnectionError("reset by peer"), id="connection-error"),
            pytest.param(requests.ConnectTimeout("connect timed out"), id="connect-timeout"),
            pytest.param(requests.ReadTimeout("read timed out"), id="read-timeout"),
        ],
    )
    def test_connection_failure_then_200_retries(
        self, client: DataHubClient, sleep: MagicMock, failure: Exception
    ) -> None:
        session = _send(client, failure, _response(200, body=FILE))

        record = client.create_file("inst", "run-1", "bucket", "inst/run-1/a.nd2", "a.nd2")

        assert record.id == 7
        assert session.call_count == 2
        assert sleep.call_args_list == [call(1.0)]

    def test_backs_off_1_2_4_seconds_across_mixed_failures(
        self, client: DataHubClient, sleep: MagicMock
    ) -> None:
        session = _send(
            client,
            requests.ConnectionError("reset"),
            _response(500),
            _response(502, text="Bad Gateway"),
            _response(200, body=RUN),
        )

        client.ensure_run("inst", "run-1")

        assert session.call_count == 4
        assert sleep.call_args_list == [call(1.0), call(2.0), call(4.0)]

    @pytest.mark.parametrize("status", [400, 403, 404, 409])
    @pytest.mark.parametrize(
        "make_call",
        [pytest.param(make, id=name) for name, make, _ in RETRIED_CALLS],
    )
    def test_4xx_is_raised_without_retrying(
        self, client: DataHubClient, sleep: MagicMock, make_call: _Call, status: int
    ) -> None:
        session = _send(
            client,
            _response(status, body={"error": {"code": "NOPE", "message": "nope"}}),
        )

        with pytest.raises(ApiError) as exc_info:
            make_call(client)

        assert exc_info.value.status_code == status
        assert str(exc_info.value) == "nope"
        assert session.call_count == 1
        sleep.assert_not_called()

    def test_4xx_after_a_transient_error_stops_the_retries(
        self, client: DataHubClient, sleep: MagicMock
    ) -> None:
        session = _send(client, _unavailable(), _response(404, text="gone"), _response(200))

        with pytest.raises(ApiError) as exc_info:
            client.ensure_run("inst", "run-1")

        assert exc_info.value.status_code == 404
        assert session.call_count == 2
        assert sleep.call_args_list == [call(1.0)]

    def test_raises_the_last_error_after_four_attempts(
        self, client: DataHubClient, sleep: MagicMock
    ) -> None:
        session = _send(
            client,
            _response(503, text="first"),
            requests.ConnectionError("second"),
            _response(500, text="third"),
            _response(502, text="fourth"),
            _response(200, body=RUN),  # Never reached.
        )

        with pytest.raises(ApiError) as exc_info:
            client.ensure_run("inst", "run-1")

        assert exc_info.value.status_code == 502
        assert str(exc_info.value) == "fourth"
        assert session.call_count == 4
        # No wait after the last attempt.
        assert sleep.call_args_list == [call(1.0), call(2.0), call(4.0)]

    def test_exhausted_connection_errors_raise_with_status_zero(
        self, client: DataHubClient
    ) -> None:
        session = _send(client, *[requests.ConnectionError(f"down {i}") for i in range(4)])

        with pytest.raises(ApiError, match="Connection error: down 3") as exc_info:
            client.ensure_run("inst", "run-1")

        assert exc_info.value.status_code == 0
        assert session.call_count == 4

    def test_each_retry_logs_a_warning(
        self, client: DataHubClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        _send(client, _response(500), _response(503, text="busy"), _response(200, body=RUN))

        with caplog.at_level(logging.WARNING, logger="data_hub_lambda.api_client"):
            client.ensure_run("inst", "run-1")

        warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
        assert len(warnings) == 2
        assert "attempt 1/4" in warnings[0]
        assert "HTTP 500 with no error message" in warnings[0]
        assert "retrying in 1.0s" in warnings[0]
        assert "attempt 2/4" in warnings[1]
        assert "busy" in warnings[1]
        assert "retrying in 2.0s" in warnings[1]


class TestFinalFileStatusIsRetried:
    """The API accepts a repeat of a final status, so a lost response can be retried."""

    @pytest.mark.parametrize("status", ["completed", "failed"])
    @pytest.mark.parametrize(
        "failure",
        [
            pytest.param(_unavailable, id="503"),
            pytest.param(lambda: _response(500), id="empty-500"),
            pytest.param(lambda: requests.ReadTimeout("read timed out"), id="timeout"),
            pytest.param(lambda: requests.ConnectionError("reset by peer"), id="connection-error"),
        ],
    )
    def test_transient_error_is_retried(
        self,
        client: DataHubClient,
        sleep: MagicMock,
        status: str,
        failure: Callable[[], requests.Response | Exception],
    ) -> None:
        session = _send(client, failure(), _response(200, body={**FILE, "status": status}))

        record = client.update_file(7, status=status, error_message="boom")

        assert record.status == status
        assert session.call_count == 2
        assert session.call_args_list[0] == session.call_args_list[1]
        assert sleep.call_args_list == [call(1.0)]

    def test_exhausted_retries_raise_the_last_error(
        self, client: DataHubClient, sleep: MagicMock
    ) -> None:
        session = _send(client, *[_unavailable() for _ in range(4)])

        with pytest.raises(ApiError) as exc_info:
            client.update_file(7, status="completed")

        assert exc_info.value.status_code == 503
        assert str(exc_info.value) == "try later"
        assert session.call_count == 4

    def test_a_409_on_a_final_status_is_not_retried(
        self, client: DataHubClient, sleep: MagicMock
    ) -> None:
        # What an API that does not accept the repeat answers.
        session = _send(
            client,
            _response(
                409,
                body={"error": {"code": "CONFLICT", "message": "Cannot transition"}},
            ),
        )

        with pytest.raises(ApiError) as exc_info:
            client.update_file(7, status="completed")

        assert exc_info.value.status_code == 409
        assert session.call_count == 1
        sleep.assert_not_called()


class TestJitter:
    def test_each_wait_gets_up_to_half_again(
        self, client: DataHubClient, sleep: MagicMock, jitter: MagicMock
    ) -> None:
        jitter.side_effect = lambda low, high: high
        _send(client, *[_unavailable() for _ in range(3)], _response(200, body=RUN))

        client.ensure_run("inst", "run-1")

        assert jitter.call_args_list == [call(0, 0.5), call(0, 1.0), call(0, 2.0)]
        assert sleep.call_args_list == [call(1.5), call(3.0), call(6.0)]

    def test_the_extra_is_added_to_the_wait(
        self, client: DataHubClient, sleep: MagicMock, jitter: MagicMock
    ) -> None:
        jitter.side_effect = lambda low, high: high / 2
        _send(client, *[_unavailable() for _ in range(3)], _response(200, body=RUN))

        client.ensure_run("inst", "run-1")

        assert sleep.call_args_list == [call(1.25), call(2.5), call(5.0)]

    def test_the_logged_wait_is_the_jittered_wait(
        self,
        client: DataHubClient,
        jitter: MagicMock,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        jitter.side_effect = lambda low, high: high
        _send(client, _unavailable(), _response(200, body=RUN))

        with caplog.at_level(logging.WARNING, logger="data_hub_lambda.api_client"):
            client.ensure_run("inst", "run-1")

        assert "retrying in 1.5s" in caplog.messages[0]


class TestDeadline:
    """A retry only starts when the invocation has time to finish it."""

    # The wait before the first retry, one read timeout, and the margin.
    FIRST_RETRY_NEEDS = 1.0 + DEFAULT_TIMEOUT[1] + _RETRY_DEADLINE_MARGIN_SECONDS

    def test_with_no_deadline_every_retry_runs(
        self, client: DataHubClient, sleep: MagicMock
    ) -> None:
        # The CLI and the unit tests set no deadline.
        session = _send(client, *[_unavailable() for _ in range(3)], _response(200, body=RUN))

        client.ensure_run("inst", "run-1")

        assert session.call_count == 4
        assert sleep.call_args_list == [call(1.0), call(2.0), call(4.0)]

    def test_with_plenty_of_time_every_retry_runs(
        self, client: DataHubClient, sleep: MagicMock, clock: FakeClock
    ) -> None:
        _time_left(15 * 60)
        session = _send(client, *[_unavailable() for _ in range(3)], _response(200, body=RUN))

        client.ensure_run("inst", "run-1")

        assert session.call_count == 4
        assert sleep.call_args_list == [call(1.0), call(2.0), call(4.0)]

    def test_stops_when_the_first_retry_cannot_finish(
        self, client: DataHubClient, sleep: MagicMock, clock: FakeClock
    ) -> None:
        _time_left(self.FIRST_RETRY_NEEDS - 0.1)
        session = _send(client, _response(503, text="first"), _response(200, body=RUN))

        with pytest.raises(ApiError) as exc_info:
            client.ensure_run("inst", "run-1")

        assert str(exc_info.value) == "first"
        assert exc_info.value.status_code == 503
        assert session.call_count == 1
        sleep.assert_not_called()

    def test_retries_when_exactly_enough_time_is_left(
        self, client: DataHubClient, sleep: MagicMock, clock: FakeClock
    ) -> None:
        _time_left(self.FIRST_RETRY_NEEDS)
        session = _send(client, _unavailable(), _response(200, body=RUN))

        client.ensure_run("inst", "run-1")

        assert session.call_count == 2
        assert sleep.call_args_list == [call(1.0)]

    def test_stops_partway_when_the_waits_use_the_time_up(
        self, client: DataHubClient, sleep: MagicMock, clock: FakeClock
    ) -> None:
        read_timeout = DEFAULT_TIMEOUT[1]
        # Enough for the first two retries (1 s and 2 s) but not the third (4 s).
        _time_left(2.0 + read_timeout + _RETRY_DEADLINE_MARGIN_SECONDS + 1.0)
        session = _send(
            client,
            _response(503, text="first"),
            _response(503, text="second"),
            _response(503, text="third"),
            _response(200, body=RUN),  # Never reached.
        )

        with pytest.raises(ApiError) as exc_info:
            client.ensure_run("inst", "run-1")

        assert str(exc_info.value) == "third"
        assert session.call_count == 3
        assert sleep.call_args_list == [call(1.0), call(2.0)]

    def test_compares_the_jittered_wait(
        self,
        client: DataHubClient,
        sleep: MagicMock,
        jitter: MagicMock,
        clock: FakeClock,
    ) -> None:
        jitter.side_effect = lambda low, high: high
        # Enough for a 1.0 s wait, not for the 1.5 s wait it got.
        _time_left(self.FIRST_RETRY_NEEDS + 0.25)
        session = _send(client, _unavailable(), _response(200, body=RUN))

        with pytest.raises(ApiError):
            client.ensure_run("inst", "run-1")

        assert session.call_count == 1
        sleep.assert_not_called()

    def test_uses_the_clients_read_timeout(self, sleep: MagicMock, clock: FakeClock) -> None:
        short = DataHubClient(base_url=BASE_URL, api_key="test-key", timeout=(5, 10))
        _time_left(1.0 + 10 + _RETRY_DEADLINE_MARGIN_SECONDS)
        session = _send(short, _unavailable(), _response(200, body=RUN))

        short.ensure_run("inst", "run-1")

        # 16 s is too little with the default 30 s read timeout, and enough here.
        assert session.call_count == 2

    def test_logs_why_it_stopped(
        self,
        client: DataHubClient,
        clock: FakeClock,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        _time_left(10)
        _send(client, _unavailable())

        with (
            caplog.at_level(logging.WARNING, logger="data_hub_lambda.api_client"),
            pytest.raises(ApiError),
        ):
            client.ensure_run("inst", "run-1")

        assert len(caplog.messages) == 1
        assert "not retrying" in caplog.messages[0]
        assert "try later" in caplog.messages[0]

    def test_a_4xx_is_still_raised_at_once(
        self, client: DataHubClient, sleep: MagicMock, clock: FakeClock
    ) -> None:
        _time_left(15 * 60)
        session = _send(client, _response(404, text="gone"), _response(200, body=RUN))

        with pytest.raises(ApiError) as exc_info:
            client.ensure_run("inst", "run-1")

        assert exc_info.value.status_code == 404
        assert session.call_count == 1

    def test_the_failure_write_can_retry_after_the_processing_deadline(
        self, client: DataHubClient, sleep: MagicMock, clock: FakeClock
    ) -> None:
        # With 50 s left, `check_deadline` already stops new work: it leaves 60 s
        # to write the failure. The retries of that write can use those seconds.
        _time_left(50)
        with pytest.raises(ProcessingDeadlineError):
            check_deadline("parsing")
        session = _send(client, _unavailable(), _response(200, body={**FILE, "status": "failed"}))

        record = client.update_file(7, status="failed", error_message="Stopped before the limit")

        assert record.status == "failed"
        assert session.call_count == 2
