"""Tests for the fault-injecting proxy, run against a tiny local upstream server."""

from __future__ import annotations
import hashlib
import json
import re
import socket
import threading
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, cast
from urllib.parse import urlsplit

import pytest
import requests

from data_hub_shared.testing_proxy import FaultProxy

# ---------------------------------------------------------------------------
# A small upstream server that records what it receives
# ---------------------------------------------------------------------------


class _Received:
    """One request as the upstream server saw it."""

    def __init__(self, method: str, path: str, headers: dict[str, str], body: bytes) -> None:
        self.method = method
        self.path = path
        self.headers = headers
        self.body = body
        self.body_sha256 = hashlib.sha256(body).hexdigest()


class _UpstreamServer(ThreadingHTTPServer):
    daemon_threads = True
    fake_upstream: _FakeUpstream


class _UpstreamHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: object) -> None:
        pass

    def _serve(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        received = _Received(
            self.command,
            self.path,
            {name.lower(): value for name, value in self.headers.items()},
            body,
        )
        upstream = cast(_UpstreamServer, self.server).fake_upstream
        with upstream.lock:
            upstream.received.append(received)

        parts = urlsplit(self.path)
        if parts.path.startswith("/status/"):
            code = int(parts.path.rsplit("/", 1)[1])
            self._reply(code, f"status {code}".encode())
        elif parts.path == "/chunked":
            self.send_response(200)
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            for piece in (b"hello", b" ", b"chunked ", b"world"):
                self.wfile.write(f"{len(piece):x}\r\n".encode() + piece + b"\r\n")
            self.wfile.write(b"0\r\n\r\n")
        elif parts.path == "/big":
            size = int(parts.query.split("=")[1])
            data = (bytes(range(256)) * (size // 256 + 1))[:size]
            self._reply(200, data, head_only=self.command == "HEAD")
        elif parts.path == "/cookies":
            self.send_response(200)
            self.send_header("Set-Cookie", "a=1")
            self.send_header("Set-Cookie", "b=2")
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            payload = json.dumps(
                {
                    "method": self.command,
                    "path": self.path,
                    "body_length": len(body),
                    "body_sha256": received.body_sha256,
                }
            ).encode()
            self._reply(200, payload, content_type="application/json")

    def _reply(
        self,
        status: int,
        body: bytes,
        *,
        content_type: str = "application/octet-stream",
        head_only: bool = False,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Upstream", "yes")
        self.end_headers()
        if status not in (204, 304) and not head_only:
            self.wfile.write(body)

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = _serve


class _FakeUpstream:
    """A local HTTP server that answers a few canned routes and records every request."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.received: list[_Received] = []
        self._server = _UpstreamServer(("127.0.0.1", 0), _UpstreamHandler)
        self._server.fake_upstream = self
        self._thread = threading.Thread(
            target=self._server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
        )

    @property
    def port(self) -> int:
        return self._server.server_address[1]

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def __enter__(self) -> _FakeUpstream:
        self._thread.start()
        return self

    def __exit__(self, *exc_info: object) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)


@pytest.fixture
def upstream() -> Iterator[_FakeUpstream]:
    with _FakeUpstream() as server:
        yield server


@pytest.fixture
def proxy(upstream: _FakeUpstream) -> Iterator[FaultProxy]:
    with FaultProxy(upstream.url) as fault_proxy:
        yield fault_proxy


@pytest.fixture
def http() -> Iterator[requests.Session]:
    # Ignore proxy settings in the environment: these requests are for localhost.
    with requests.Session() as session:
        session.trust_env = False
        yield session


def _get(http: requests.Session, proxy: FaultProxy, path: str = "/echo", **kwargs: Any) -> Any:
    return http.get(proxy.base_url + path, timeout=10, **kwargs)


# ---------------------------------------------------------------------------
# Pass-through
# ---------------------------------------------------------------------------


def test_get_passes_through_path_query_and_status(
    proxy: FaultProxy, upstream: _FakeUpstream, http: requests.Session
) -> None:
    response = _get(http, proxy, "/echo?kind=part&n=1")

    assert response.status_code == 200
    assert response.json()["path"] == "/echo?kind=part&n=1"
    assert response.headers["X-Upstream"] == "yes"
    assert [r.path for r in upstream.received] == ["/echo?kind=part&n=1"]


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
def test_methods_with_bodies_pass_through(
    method: str, proxy: FaultProxy, upstream: _FakeUpstream, http: requests.Session
) -> None:
    body = b'{"hello": "world"}'

    response = http.request(
        method,
        proxy.base_url + "/echo?x=1",
        data=body,
        headers={"Content-Type": "application/json"},
        timeout=10,
    )

    assert response.status_code == 200
    echoed = response.json()
    assert echoed["method"] == method
    assert echoed["body_length"] == len(body)
    assert upstream.received[0].body == body
    assert upstream.received[0].headers["content-type"] == "application/json"


@pytest.mark.parametrize("status", [201, 204, 301, 404, 409, 500])
def test_status_codes_pass_through(status: int, proxy: FaultProxy, http: requests.Session) -> None:
    response = _get(http, proxy, f"/status/{status}", allow_redirects=False)

    assert response.status_code == status
    if status != 204:
        assert response.content == f"status {status}".encode()


def test_host_is_rewritten_and_connection_headers_are_dropped(
    proxy: FaultProxy, upstream: _FakeUpstream, http: requests.Session
) -> None:
    _get(
        http,
        proxy,
        headers={
            "Connection": "keep-alive, X-Secret",
            "X-Secret": "1",
            "Keep-Alive": "timeout=5",
            "X-Custom": "kept",
        },
    )

    seen = upstream.received[0].headers
    assert seen["host"] == f"127.0.0.1:{upstream.port}"
    assert seen["x-custom"] == "kept"
    assert "x-secret" not in seen
    assert "keep-alive" not in seen


def test_responses_close_the_connection_and_carry_content_length(
    proxy: FaultProxy, http: requests.Session
) -> None:
    response = _get(http, proxy)

    assert response.headers["Connection"] == "close"
    assert int(response.headers["Content-Length"]) == len(response.content)


def test_large_request_and_response_bodies(
    proxy: FaultProxy, upstream: _FakeUpstream, http: requests.Session
) -> None:
    size = 32 * 1024 * 1024
    payload = (b"0123456789abcdef" * (size // 16))[:size]

    uploaded = http.put(proxy.base_url + "/echo", data=payload, timeout=60)
    downloaded = _get(http, proxy, f"/big?size={size}")

    assert uploaded.json()["body_length"] == size
    assert upstream.received[0].body_sha256 == hashlib.sha256(payload).hexdigest()
    assert len(downloaded.content) == size
    assert downloaded.content[:300] == (bytes(range(256)) * 2)[:300]


def test_chunked_upstream_response_is_buffered_with_a_length(
    proxy: FaultProxy, http: requests.Session
) -> None:
    response = _get(http, proxy, "/chunked")

    assert response.content == b"hello chunked world"
    assert "Transfer-Encoding" not in response.headers
    assert response.headers["Content-Length"] == str(len(response.content))


def test_chunked_request_body_reaches_upstream_whole(
    proxy: FaultProxy, upstream: _FakeUpstream, http: requests.Session
) -> None:
    pieces = [b"a" * 1000, b"b" * 2000, b"c" * 3]

    response = http.put(proxy.base_url + "/echo", data=iter(pieces), timeout=10)

    assert response.json()["body_length"] == 3003
    assert upstream.received[0].body == b"".join(pieces)
    assert "transfer-encoding" not in upstream.received[0].headers
    assert upstream.received[0].headers["content-length"] == "3003"


def test_head_request_keeps_content_length_but_has_no_body(
    proxy: FaultProxy, http: requests.Session
) -> None:
    response = http.head(proxy.base_url + "/big?size=1234", timeout=10)

    assert response.status_code == 200
    assert response.headers["Content-Length"] == "1234"
    assert response.content == b""


def test_repeated_response_headers_survive(proxy: FaultProxy) -> None:
    # Use the standard library here: requests merges repeated headers into one value.
    host, port = proxy.base_url.removeprefix("http://").split(":")
    with socket.create_connection((host, int(port)), timeout=10) as sock:
        sock.sendall(b"GET /cookies HTTP/1.1\r\nHost: x\r\n\r\n")
        raw = b""
        while chunk := sock.recv(4096):
            raw += chunk

    assert raw.count(b"Set-Cookie:") == 2


def test_unreachable_upstream_gives_a_502() -> None:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        closed_port = probe.getsockname()[1]

    with FaultProxy(f"http://127.0.0.1:{closed_port}") as dead_end:
        with requests.Session() as http:
            http.trust_env = False
            response = http.get(dead_end.base_url + "/x", timeout=10)

        assert response.status_code == 502
        assert dead_end.requests[0].upstream_status is None


def test_invalid_upstream_is_rejected() -> None:
    for bad in ("127.0.0.1:3000", "https://example.com", "http://127.0.0.1:3000/base", "http://"):
        with pytest.raises(ValueError, match="upstream"):
            FaultProxy(bad)


# ---------------------------------------------------------------------------
# Faults
# ---------------------------------------------------------------------------


def test_status_fault_answers_without_contacting_upstream(
    proxy: FaultProxy, upstream: _FakeUpstream, http: requests.Session
) -> None:
    rule = proxy.add_fault("status")

    # The body is large so the proxy has to read it all before it answers. Answering
    # with an upload half sent would make the client see a reset instead of the 503.
    response = http.post(proxy.base_url + "/echo", data=b"x" * (8 * 1024 * 1024), timeout=30)

    assert response.status_code == 503
    assert response.json() == {"error": "fault_injected", "mode": "status", "status": 503}
    assert upstream.received == []
    assert rule.hits == 1


def test_status_fault_waits_for_the_whole_request_body_before_answering(proxy: FaultProxy) -> None:
    # Answering while the client is still sending would make it see a reset, not the 503.
    proxy.add_fault("status")

    with socket.create_connection(("127.0.0.1", proxy.port), timeout=10) as sock:
        sock.sendall(b"PUT /echo HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\n" + b"a" * 100)
        sock.settimeout(0.5)
        with pytest.raises(TimeoutError):
            sock.recv(1024)  # Nothing yet: the proxy is still waiting for the rest.

        sock.settimeout(10)
        sock.sendall(b"a" * 900)
        reply = b""
        while chunk := sock.recv(4096):
            reply += chunk

    assert reply.startswith(b"HTTP/1.1 503 ")


def test_status_fault_uses_the_requested_status(proxy: FaultProxy, http: requests.Session) -> None:
    proxy.add_fault("status", status=429)

    assert _get(http, proxy).status_code == 429


def test_delay_fault_waits_and_then_forwards(
    proxy: FaultProxy, upstream: _FakeUpstream, http: requests.Session
) -> None:
    proxy.add_fault("delay", delay_seconds=0.5)

    started = time.monotonic()
    response = _get(http, proxy)
    elapsed = time.monotonic() - started

    assert response.status_code == 200
    assert elapsed >= 0.45
    assert len(upstream.received) == 1
    assert proxy.requests[0].fault_mode == "delay"
    assert proxy.requests[0].upstream_status == 200


def test_reset_fault_closes_the_connection_without_a_response(
    proxy: FaultProxy, upstream: _FakeUpstream, http: requests.Session
) -> None:
    proxy.add_fault("reset")

    with pytest.raises(requests.ConnectionError):
        http.post(proxy.base_url + "/echo", data=b"payload", timeout=10)

    assert upstream.received == []
    assert proxy.requests[0].fault_mode == "reset"
    assert proxy.requests[0].upstream_status is None


def test_reset_fault_sends_a_tcp_reset_rather_than_a_clean_close(proxy: FaultProxy) -> None:
    proxy.add_fault("reset")

    with socket.create_connection(("127.0.0.1", proxy.port), timeout=10) as sock:
        sock.sendall(b"GET /echo HTTP/1.1\r\nHost: x\r\n\r\n")
        # A clean close would make recv() return b"" instead of raising.
        with pytest.raises((ConnectionResetError, ConnectionAbortedError)):
            sock.recv(1024)


def test_drop_response_fault_reaches_upstream_but_the_client_gets_nothing(
    proxy: FaultProxy, upstream: _FakeUpstream, http: requests.Session
) -> None:
    proxy.add_fault("drop_response", method="POST")

    with pytest.raises(requests.ConnectionError):
        http.post(proxy.base_url + "/echo?x=1", data=b"payload", timeout=10)

    assert [(r.method, r.path, r.body) for r in upstream.received] == [
        ("POST", "/echo?x=1", b"payload")
    ]
    logged = proxy.requests[0]
    assert logged.fault_mode == "drop_response"
    assert logged.upstream_status == 200


def test_faults_apply_to_a_client_that_reuses_its_session(
    proxy: FaultProxy, http: requests.Session
) -> None:
    assert _get(http, proxy).status_code == 200

    with proxy.fault("reset"), pytest.raises(requests.ConnectionError):
        _get(http, proxy)

    assert _get(http, proxy).status_code == 200


def test_count_limits_how_many_requests_a_rule_affects(
    proxy: FaultProxy, http: requests.Session
) -> None:
    rule = proxy.add_fault("status", count=2)

    statuses = [_get(http, proxy).status_code for _ in range(4)]

    assert statuses == [503, 503, 200, 200]
    assert rule.hits == 2
    assert rule.exhausted


def test_path_is_a_regex_searched_in_path_and_query(
    proxy: FaultProxy, http: requests.Session
) -> None:
    proxy.add_fault("status", path=r"/files/\d+/complete$|kind=part")

    assert _get(http, proxy, "/files/12/complete").status_code == 503
    assert _get(http, proxy, "/echo?kind=part&n=1").status_code == 503
    assert _get(http, proxy, "/files/abc/complete").status_code == 200
    assert _get(http, proxy, "/files/12/complete/extra").status_code == 200
    assert _get(http, proxy, "/other").status_code == 200


def test_method_limits_a_rule_to_one_http_method(proxy: FaultProxy, http: requests.Session) -> None:
    proxy.add_fault("status", method="post")

    assert _get(http, proxy).status_code == 200
    assert http.post(proxy.base_url + "/echo", timeout=10).status_code == 503
    assert http.put(proxy.base_url + "/echo", timeout=10).status_code == 200


def test_the_first_matching_rule_wins_and_used_up_rules_fall_through(
    proxy: FaultProxy, http: requests.Session
) -> None:
    first = proxy.add_fault("status", status=500, count=1)
    proxy.add_fault("status", status=502)

    assert [_get(http, proxy).status_code for _ in range(3)] == [500, 502, 502]
    assert first.hits == 1


def test_remove_fault_and_clear_faults(proxy: FaultProxy, http: requests.Session) -> None:
    rule = proxy.add_fault("status", status=500)
    proxy.add_fault("status", status=502)

    assert _get(http, proxy).status_code == 500
    proxy.remove_fault(rule)
    proxy.remove_fault(rule)  # Removing twice does nothing.
    assert _get(http, proxy).status_code == 502
    proxy.clear_faults()
    assert _get(http, proxy).status_code == 200


def test_fault_context_manager_removes_its_rule(proxy: FaultProxy, http: requests.Session) -> None:
    with proxy.fault("status", status=418) as rule:
        assert _get(http, proxy).status_code == 418
    assert rule.hits == 1
    assert _get(http, proxy).status_code == 200


@pytest.mark.parametrize(
    "kwargs",
    [
        {"mode": "bogus"},
        {"mode": "status", "status": 99},
        {"mode": "status", "status": 600},
        {"mode": "delay", "delay_seconds": -1},
        {"mode": "status", "count": 0},
    ],
)
def test_add_fault_rejects_bad_arguments(proxy: FaultProxy, kwargs: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        proxy.add_fault(**kwargs)


def test_add_fault_rejects_an_invalid_regex(proxy: FaultProxy) -> None:
    with pytest.raises(re.error):
        proxy.add_fault("status", path="(")


# ---------------------------------------------------------------------------
# Going down and coming back up
# ---------------------------------------------------------------------------


def _connect(proxy: FaultProxy) -> socket.socket:
    return socket.create_connection(("127.0.0.1", proxy.port), timeout=10)


def test_go_down_refuses_connections_and_come_up_reuses_the_port(
    proxy: FaultProxy, http: requests.Session
) -> None:
    port, base_url = proxy.port, proxy.base_url
    assert _get(http, proxy).status_code == 200

    proxy.go_down()

    assert not proxy.is_up
    with pytest.raises(ConnectionRefusedError):
        _connect(proxy)
    with pytest.raises(requests.ConnectionError):
        _get(http, proxy)

    proxy.come_up()

    assert proxy.is_up
    assert (proxy.port, proxy.base_url) == (port, base_url)
    assert _get(http, proxy).status_code == 200


def test_go_down_and_come_up_can_cycle_repeatedly_and_are_idempotent(
    proxy: FaultProxy, http: requests.Session
) -> None:
    port = proxy.port
    proxy.come_up()  # Already up: nothing happens.
    for _ in range(3):
        proxy.go_down()
        proxy.go_down()
        proxy.come_up()
        proxy.come_up()
        assert proxy.port == port
        assert _get(http, proxy).status_code == 200


def test_go_down_keeps_fault_rules_and_the_log(proxy: FaultProxy, http: requests.Session) -> None:
    proxy.add_fault("status", status=500)
    _get(http, proxy)

    proxy.go_down()
    proxy.come_up()

    assert _get(http, proxy).status_code == 500
    assert len(proxy.requests) == 2


def test_go_down_closes_open_client_connections(proxy: FaultProxy) -> None:
    sock = _connect(proxy)
    sock.sendall(b"GET /echo HTTP/1.1\r\nHost: x\r\n")  # The request is never finished.

    proxy.go_down()

    try:
        data = sock.recv(1)
    except ConnectionError:
        data = b""
    sock.close()
    assert data == b""


def test_go_down_abandons_a_request_that_is_being_delayed(
    proxy: FaultProxy, upstream: _FakeUpstream
) -> None:
    proxy.add_fault("delay", delay_seconds=1.0)

    def slow_request() -> int:
        with requests.Session() as session:
            session.trust_env = False
            return session.get(proxy.base_url + "/echo", timeout=20).status_code

    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(slow_request)
        proxy.wait_for_request(lambda r: r.fault_mode == "delay", timeout=10)

        proxy.go_down()

        with pytest.raises(requests.ConnectionError):
            future.result(timeout=10)

    # Wait out the whole delay, with room to spare: the abandoned request must not be
    # sent upstream once the delay is over.
    time.sleep(2.0)
    assert upstream.received == []


def test_stop_refuses_connections_and_cannot_be_undone(proxy: FaultProxy) -> None:
    proxy.stop()
    proxy.stop()  # Stopping twice does nothing.

    with pytest.raises(ConnectionRefusedError):
        _connect(proxy)
    with pytest.raises(RuntimeError, match="stopped"):
        proxy.come_up()
    with pytest.raises(RuntimeError):
        proxy.start()


def test_context_manager_stops_the_proxy(upstream: _FakeUpstream) -> None:
    with FaultProxy(upstream.url) as proxy:
        port = proxy.port
        assert proxy.is_up

    assert not proxy.is_up
    with pytest.raises(ConnectionRefusedError):
        socket.create_connection(("127.0.0.1", port), timeout=10)


def test_lifecycle_calls_before_start_are_rejected(upstream: _FakeUpstream) -> None:
    unstarted = FaultProxy(upstream.url)

    with pytest.raises(RuntimeError, match="not been started"):
        _ = unstarted.base_url
    with pytest.raises(RuntimeError, match="not been started"):
        unstarted.go_down()
    with pytest.raises(RuntimeError, match="not been started"):
        unstarted.come_up()
    unstarted.stop()  # Harmless.


def test_start_twice_is_rejected(proxy: FaultProxy) -> None:
    with pytest.raises(RuntimeError):
        proxy.start()


# ---------------------------------------------------------------------------
# Request log
# ---------------------------------------------------------------------------


def test_log_records_each_request(proxy: FaultProxy, http: requests.Session) -> None:
    before = time.time()
    _get(http, proxy, "/echo?a=1")
    http.post(proxy.base_url + "/status/404", timeout=10)

    first, second = proxy.requests
    assert (first.method, first.path) == ("GET", "/echo?a=1")
    assert (first.fault_mode, first.upstream_status) == (None, 200)
    assert before <= first.timestamp <= second.timestamp <= time.time()
    assert (second.method, second.path, second.upstream_status) == ("POST", "/status/404", 404)


def test_log_records_fault_mode_without_an_upstream_status(
    proxy: FaultProxy, http: requests.Session
) -> None:
    proxy.add_fault("status", path="/events")

    _get(http, proxy, "/events")

    (entry,) = proxy.requests
    assert (entry.fault_mode, entry.upstream_status) == ("status", None)


def test_requests_returns_a_snapshot_and_clear_log_empties_the_log(
    proxy: FaultProxy, http: requests.Session
) -> None:
    _get(http, proxy)
    snapshot = proxy.requests

    proxy.clear_log()
    _get(http, proxy, "/second")

    assert len(snapshot) == 1
    assert [r.path for r in proxy.requests] == ["/second"]


def test_wait_for_request_returns_a_request_already_logged(
    proxy: FaultProxy, http: requests.Session
) -> None:
    _get(http, proxy, "/one")
    _get(http, proxy, "/two")

    found = proxy.wait_for_request(lambda r: r.path == "/two", timeout=1)

    assert found.path == "/two"


def test_wait_for_request_returns_the_oldest_match(
    proxy: FaultProxy, http: requests.Session
) -> None:
    _get(http, proxy, "/echo?n=1")
    _get(http, proxy, "/echo?n=2")

    assert proxy.wait_for_request(lambda r: "echo" in r.path, timeout=1).path == "/echo?n=1"


def test_wait_for_request_waits_for_a_request_that_arrives_later(
    proxy: FaultProxy, http: requests.Session
) -> None:
    def later() -> None:
        time.sleep(0.3)
        with requests.Session() as session:
            session.trust_env = False
            session.get(proxy.base_url + "/late", timeout=10)

    thread = threading.Thread(target=later)
    thread.start()
    started = time.monotonic()
    try:
        found = proxy.wait_for_request(lambda r: r.path == "/late", timeout=10)
    finally:
        thread.join()

    assert found.method == "GET"
    assert time.monotonic() - started < 5, "the wait should end as soon as the request arrives"


def test_wait_for_request_times_out_and_lists_what_was_seen(
    proxy: FaultProxy, http: requests.Session
) -> None:
    _get(http, proxy, "/something")

    with pytest.raises(TimeoutError, match="/something"):
        proxy.wait_for_request(lambda r: r.path == "/never", timeout=0.2)


def test_wait_for_request_sees_a_request_that_is_still_being_delayed(
    proxy: FaultProxy, http: requests.Session
) -> None:
    proxy.add_fault("delay", delay_seconds=1.0)
    outcome: list[int] = []
    thread = threading.Thread(target=lambda: outcome.append(_get(http, proxy).status_code))
    thread.start()
    try:
        in_flight = proxy.wait_for_request(lambda r: r.fault_mode == "delay", timeout=10)
        assert in_flight.upstream_status is None
    finally:
        thread.join()

    assert outcome == [200]
    assert proxy.requests[0].upstream_status == 200


def test_wait_for_request_notices_the_upstream_status_arriving(
    proxy: FaultProxy, http: requests.Session
) -> None:
    proxy.add_fault("delay", delay_seconds=0.5)
    thread = threading.Thread(target=lambda: _get(http, proxy))
    thread.start()
    started = time.monotonic()
    try:
        done = proxy.wait_for_request(lambda r: r.upstream_status == 200, timeout=10)
    finally:
        thread.join()

    assert done.fault_mode == "delay"
    assert time.monotonic() - started < 5, "the wait should end as soon as the answer arrives"
