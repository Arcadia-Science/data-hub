"""A reverse proxy that can break on purpose, for end-to-end tests of the watcher.

``FaultProxy`` sits between a client (the watcher) and a real HTTP server (the Next.js
test server). By default it passes every request straight through. Tests then switch
on faults to see how the client copes: error responses, slow responses, connections
that die, replies that never arrive, or the whole server going away and coming back
on the same port.

Only the standard library is used, so the proxy works the same on POSIX and Windows.
"""

from __future__ import annotations
import contextlib
import http.client
import json
import re
import socket
import struct
import sys
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Literal, cast
from urllib.parse import urlsplit

__all__ = ["FaultMode", "FaultProxy", "FaultRule", "RecordedRequest"]

FaultMode = Literal["status", "delay", "reset", "drop_response"]
"""What a fault rule does to a matching request.

- ``"status"``: answer with a fixed status code and a small JSON body, without
  contacting the upstream server.
- ``"delay"``: wait, then forward the request as usual.
- ``"reset"``: close the client's connection abruptly, without any response, and
  without contacting the upstream server.
- ``"drop_response"``: forward the request so the upstream server fully processes it,
  then close the client's connection without sending the reply.
"""

_FAULT_MODES: tuple[str, ...] = ("status", "delay", "reset", "drop_response")

# Headers that describe a single connection rather than the request or response, so a
# proxy must not copy them from one side to the other (RFC 9110 section 7.6.1).
_HOP_BY_HOP_HEADERS = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "proxy-connection",
        "te",
        "trailer",
        "trailers",
        "transfer-encoding",
        "upgrade",
    }
)

# The bytes for SO_LINGER with "on" and a zero timeout, which makes close() send a TCP
# reset instead of a clean shutdown. Windows' ``struct linger`` uses two shorts where
# POSIX uses two ints.
_LINGER_RESET = struct.pack("hh", 1, 0) if sys.platform == "win32" else struct.pack("ii", 1, 0)

# How long a bind to a just-released port is retried before giving up. On a busy machine
# the OS can take a moment to let go of the port after a listener closes.
_REBIND_TIMEOUT_SECONDS = 10.0

_MAX_HEADER_LINE = 65536


@dataclass(frozen=True)
class RecordedRequest:
    """One request the proxy received from a client.

    ``path`` is the request target exactly as the client sent it, so it includes the
    query string (for example ``/api/v1/files?limit=5``). ``fault_mode`` is the mode of
    the fault rule that applied to the request, or ``None`` if it passed through
    untouched. ``upstream_status`` is the status code the upstream server answered
    with, or ``None`` when the upstream server was not contacted (or never answered).

    A request is logged as soon as it arrives, and ``upstream_status`` is filled in once
    the upstream server answers. So a request that is still being delayed or is still
    waiting on the upstream server is already visible in the log.
    """

    timestamp: float
    method: str
    path: str
    fault_mode: FaultMode | None
    upstream_status: int | None


@dataclass(eq=False)
class FaultRule:
    """A switch that makes matching requests fail in a chosen way.

    Create rules with :meth:`FaultProxy.add_fault` or :meth:`FaultProxy.fault`, not
    directly. ``path`` is searched (``re.search``) in the request target, which is the
    path followed by the query string. ``method`` is compared without regard to case.
    ``count`` limits how many requests the rule affects, and ``hits`` is how many it
    has affected so far. A rule with ``count`` set stops matching once it has used up
    its count.
    """

    mode: FaultMode
    path: re.Pattern[str] | None = None
    method: str | None = None
    status: int = 503
    delay_seconds: float = 0.0
    count: int | None = None
    hits: int = 0

    @property
    def exhausted(self) -> bool:
        """True once a rule with a ``count`` has affected that many requests."""
        return self.count is not None and self.hits >= self.count

    def matches(self, method: str, target: str) -> bool:
        """True if this rule applies to a request with this method and target."""
        if self.exhausted:
            return False
        if self.method is not None and self.method != method.upper():
            return False
        return self.path is None or self.path.search(target) is not None


class FaultProxy:
    """A threaded HTTP reverse proxy with switchable faults and a request log.

    ``upstream`` is the server to forward to, such as ``http://127.0.0.1:3000``.
    Clients talk to :attr:`base_url`. The port is chosen when the proxy first starts and
    stays the same for the proxy's whole lifetime, including across
    :meth:`go_down` and :meth:`come_up`.

    Requests are forwarded with their method, path, query, headers and body unchanged,
    except that ``Host`` is rewritten to the upstream's and headers that only describe
    one connection are dropped. The whole upstream response is read, then sent back with a
    ``Content-Length`` and ``Connection: close``. Closing every connection after each
    response means a client can never keep an idle connection that would skip a
    fault change.

    Use it as a context manager, or call :meth:`start` and :meth:`stop`::

        with FaultProxy(env.base_url) as proxy:
            with proxy.fault("status", path=r"^/api/v1/events", count=2):
                ...  # the next two matching requests get a 503
    """

    def __init__(self, upstream: str, *, upstream_timeout: float = 330.0) -> None:
        parts = urlsplit(upstream)
        if parts.scheme != "http" or not parts.hostname:
            raise ValueError(f"upstream must look like http://host:port, got {upstream!r}")
        if parts.path not in ("", "/") or parts.query or parts.fragment:
            raise ValueError(f"upstream must not include a path or query, got {upstream!r}")
        self._upstream = upstream
        self._upstream_host = parts.hostname
        self._upstream_port = parts.port or 80
        self._upstream_netloc = parts.netloc
        self._upstream_timeout = upstream_timeout

        self._lock = threading.RLock()
        self._log_changed = threading.Condition(self._lock)
        self._rules: list[FaultRule] = []
        self._log: dict[int, RecordedRequest] = {}
        self._next_log_id = 0

        # The lifecycle lock keeps start, stop, go_down and come_up from overlapping.
        self._lifecycle_lock = threading.RLock()
        self._state: Literal["new", "up", "down", "stopped"] = "new"
        self._port: int | None = None
        self._server: _ProxyServer | None = None
        self._thread: threading.Thread | None = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    @property
    def upstream(self) -> str:
        """The server requests are forwarded to."""
        return self._upstream

    @property
    def port(self) -> int:
        """The proxy's listening port. Only available once :meth:`start` has run."""
        if self._port is None:
            raise RuntimeError("The proxy has not been started yet.")
        return self._port

    @property
    def base_url(self) -> str:
        """The URL clients should use, such as ``http://127.0.0.1:54321``."""
        return f"http://127.0.0.1:{self.port}"

    @property
    def is_up(self) -> bool:
        """True while the proxy is accepting connections."""
        return self._state == "up"

    def start(self) -> None:
        """Pick a free port and start accepting connections. Call this once."""
        with self._lifecycle_lock:
            if self._state != "new":
                raise RuntimeError(f"The proxy cannot be started from state {self._state!r}.")
            self._listen(0)
            self._state = "up"

    def stop(self) -> None:
        """Stop the proxy for good: refuse new connections and close open ones.

        Safe to call more than once, or on a proxy that never started.
        """
        with self._lifecycle_lock:
            if self._state == "up":
                self._close_listener()
            self._state = "stopped"

    def go_down(self) -> None:
        """Simulate the server disappearing.

        The listening socket and every open client connection are closed, so new
        connections get "connection refused" until :meth:`come_up` is called. Requests
        still in flight are abandoned. Calling it when already down does nothing.
        """
        with self._lifecycle_lock:
            if self._state == "up":
                self._close_listener()
                self._state = "down"
            elif self._state == "new":
                raise RuntimeError("The proxy has not been started yet.")

    def come_up(self) -> None:
        """Start accepting connections again on the same port as before.

        Calling it when already up does nothing.
        """
        with self._lifecycle_lock:
            if self._state == "down":
                self._listen(self.port)
                self._state = "up"
            elif self._state == "new":
                raise RuntimeError("The proxy has not been started yet.")
            elif self._state == "stopped":
                raise RuntimeError("The proxy was stopped and cannot come back up.")

    def __enter__(self) -> FaultProxy:
        self.start()
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.stop()

    def _listen(self, port: int) -> None:
        """Bind the listening socket (retrying briefly) and start the serving thread."""
        deadline = time.monotonic() + _REBIND_TIMEOUT_SECONDS
        while True:
            try:
                server = _ProxyServer(("127.0.0.1", port), _ProxyHandler, self)
                break
            except OSError:
                # A port that was just released can take a moment to become free.
                if port == 0 or time.monotonic() >= deadline:
                    raise
                time.sleep(0.05)
        self._port = server.server_address[1]
        self._server = server
        self._thread = threading.Thread(
            target=server.serve_forever,
            kwargs={"poll_interval": 0.05},
            name=f"fault-proxy-{self._port}",
            daemon=True,
        )
        self._thread.start()

    def _close_listener(self) -> None:
        server, thread = self._server, self._thread
        self._server = None
        self._thread = None
        if server is None or thread is None:
            return
        # Wake up delayed requests so they give up instead of forwarding later.
        server.closing.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        server.abort_connections()

    # ------------------------------------------------------------------
    # Faults
    # ------------------------------------------------------------------

    def add_fault(
        self,
        mode: FaultMode,
        *,
        path: str | None = None,
        method: str | None = None,
        status: int = 503,
        delay_seconds: float = 0.0,
        count: int | None = None,
    ) -> FaultRule:
        """Make matching requests fail in the chosen ``mode``.

        ``path`` is a regular expression searched in the request path plus query string.
        ``method`` limits the rule to one HTTP method. Leave either out to match all.
        ``status`` is the status code for ``"status"`` mode. ``delay_seconds`` is the
        wait for ``"delay"`` mode. ``count`` limits how many requests the rule affects,
        and ``None`` means no limit. When several rules match a request, the one added
        first wins. Returns the rule so it can be removed later.
        """
        if mode not in _FAULT_MODES:
            raise ValueError(f"Unknown fault mode {mode!r}. Use one of {_FAULT_MODES}.")
        if not 100 <= status <= 599:
            raise ValueError(f"status must be between 100 and 599, got {status}.")
        if delay_seconds < 0:
            raise ValueError(f"delay_seconds must not be negative, got {delay_seconds}.")
        if count is not None and count < 1:
            raise ValueError(f"count must be at least 1 (or None for no limit), got {count}.")
        rule = FaultRule(
            mode=mode,
            path=re.compile(path) if path is not None else None,
            method=method.upper() if method is not None else None,
            status=status,
            delay_seconds=delay_seconds,
            count=count,
        )
        with self._lock:
            self._rules.append(rule)
        return rule

    def remove_fault(self, rule: FaultRule) -> None:
        """Remove one rule. Does nothing if it was already removed."""
        with self._lock:
            if rule in self._rules:
                self._rules.remove(rule)

    def clear_faults(self) -> None:
        """Remove every rule, so all requests pass through again."""
        with self._lock:
            self._rules.clear()

    @contextlib.contextmanager
    def fault(
        self,
        mode: FaultMode,
        *,
        path: str | None = None,
        method: str | None = None,
        status: int = 503,
        delay_seconds: float = 0.0,
        count: int | None = None,
    ) -> Iterator[FaultRule]:
        """Add a fault for the length of a ``with`` block. Takes the same arguments as
        :meth:`add_fault` and yields the rule."""
        rule = self.add_fault(
            mode,
            path=path,
            method=method,
            status=status,
            delay_seconds=delay_seconds,
            count=count,
        )
        try:
            yield rule
        finally:
            self.remove_fault(rule)

    def _claim_fault(self, method: str, target: str) -> FaultRule | None:
        """Find the first rule that applies to a request and count it as a hit."""
        with self._lock:
            for rule in self._rules:
                if rule.matches(method, target):
                    rule.hits += 1
                    return rule
        return None

    # ------------------------------------------------------------------
    # Request log
    # ------------------------------------------------------------------

    @property
    def requests(self) -> list[RecordedRequest]:
        """A snapshot of every request received since the last :meth:`clear_log`,
        oldest first."""
        with self._lock:
            return list(self._log.values())

    def clear_log(self) -> None:
        """Forget all recorded requests."""
        with self._lock:
            self._log.clear()

    def wait_for_request(
        self, predicate: Callable[[RecordedRequest], bool], timeout: float
    ) -> RecordedRequest:
        """Wait until a logged request satisfies ``predicate`` and return the oldest one.

        Requests already in the log count. The log is re-checked whenever a request
        arrives or the upstream server answers one. Raises ``TimeoutError`` after
        ``timeout`` seconds, with the recorded requests in the message.
        """
        deadline = time.monotonic() + timeout
        with self._log_changed:
            while True:
                for entry in self._log.values():
                    if predicate(entry):
                        return entry
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    seen = "\n".join(
                        f"  {e.method} {e.path} fault={e.fault_mode} upstream={e.upstream_status}"
                        for e in self._log.values()
                    )
                    raise TimeoutError(
                        f"No matching request within {timeout} s. "
                        f"Recorded {len(self._log)} request(s):\n{seen or '  (none)'}"
                    )
                self._log_changed.wait(remaining)

    def _log_request(self, method: str, target: str, mode: FaultMode | None) -> int:
        with self._lock:
            log_id = self._next_log_id
            self._next_log_id += 1
            self._log[log_id] = RecordedRequest(time.time(), method, target, mode, None)
            self._log_changed.notify_all()
            return log_id

    def _log_upstream_status(self, log_id: int, status: int) -> None:
        with self._lock:
            entry = self._log.get(log_id)
            if entry is not None:  # The log may have been cleared meanwhile.
                self._log[log_id] = replace(entry, upstream_status=status)
                self._log_changed.notify_all()


class _ProxyServer(ThreadingHTTPServer):
    """The listening server. Remembers open client connections so they can be cut."""

    daemon_threads = True
    # The default backlog of 5 can drop connections when several uploads start at once.
    request_queue_size = 128
    # On POSIX, SO_REUSEADDR is what lets the proxy re-bind a port it just released. On
    # Windows the same option would let another process share the port, and rebinding
    # a just-released port works without it.
    allow_reuse_address = sys.platform != "win32"

    def __init__(
        self,
        address: tuple[str, int],
        handler: type[BaseHTTPRequestHandler],
        proxy: FaultProxy,
    ) -> None:
        self.proxy = proxy
        # Set when the server goes down, to release requests that are waiting.
        self.closing = threading.Event()
        self._connections_lock = threading.Lock()
        self._connections: set[socket.socket] = set()
        self._reset_on_close: set[socket.socket] = set()
        super().__init__(address, handler)

    def get_request(self) -> tuple[socket.socket, tuple[str, int]]:
        conn, addr = super().get_request()
        with self._connections_lock:
            self._connections.add(conn)
        return conn, addr

    def shutdown_request(self, request: socket.socket | tuple[bytes, socket.socket]) -> None:
        conn = cast(socket.socket, request)
        with self._connections_lock:
            self._connections.discard(conn)
            reset = conn in self._reset_on_close
            self._reset_on_close.discard(conn)
        if reset:
            _close_with_reset(conn)
        else:
            super().shutdown_request(request)

    def reset_on_close(self, conn: socket.socket) -> None:
        """Mark a connection to be closed with a TCP reset when its request finishes."""
        with self._connections_lock:
            self._reset_on_close.add(conn)

    def abort_connections(self) -> None:
        """Cut every open client connection."""
        with self._connections_lock:
            conns = list(self._connections)
        for conn in conns:
            with contextlib.suppress(OSError):
                conn.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, _LINGER_RESET)
            with contextlib.suppress(OSError):
                conn.shutdown(socket.SHUT_RDWR)
            with contextlib.suppress(OSError):
                conn.close()

    def handle_error(self, request: Any, client_address: Any) -> None:
        # Clients hanging up mid-request is expected here, and is often the point.
        if isinstance(sys.exc_info()[1], OSError):
            return
        super().handle_error(request, client_address)


def _close_with_reset(conn: socket.socket) -> None:
    """Close a socket so the peer sees a connection reset instead of a clean end."""
    with contextlib.suppress(OSError):
        conn.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, _LINGER_RESET)
    with contextlib.suppress(OSError):
        conn.close()


class _ProxyHandler(BaseHTTPRequestHandler):
    """Handles one client request: apply any fault, otherwise forward it upstream."""

    protocol_version = "HTTP/1.1"

    @property
    def _proxy_server(self) -> _ProxyServer:
        return cast(_ProxyServer, self.server)

    def log_message(self, format: str, *args: object) -> None:
        """Stay quiet; the request log on the proxy records everything instead."""

    def do_GET(self) -> None:
        self._handle()

    def do_HEAD(self) -> None:
        self._handle()

    def do_POST(self) -> None:
        self._handle()

    def do_PUT(self) -> None:
        self._handle()

    def do_PATCH(self) -> None:
        self._handle()

    def do_DELETE(self) -> None:
        self._handle()

    def do_OPTIONS(self) -> None:
        self._handle()

    def _handle(self) -> None:
        proxy = self._proxy_server.proxy
        method, target = self.command, self.path
        # Every response ends the connection, so the next request is a fresh one.
        self.close_connection = True
        if self._proxy_server.closing.is_set():
            return  # The proxy went down just as this connection arrived.

        rule = proxy._claim_fault(method, target)
        log_id = proxy._log_request(method, target, rule.mode if rule else None)

        if rule is not None and rule.mode == "reset":
            self._proxy_server.reset_on_close(self.connection)
            return

        body = self._read_request_body()

        if rule is not None and rule.mode == "status":
            payload = json.dumps(
                {"error": "fault_injected", "mode": "status", "status": rule.status}
            ).encode()
            self._respond(
                rule.status,
                http.client.responses.get(rule.status, "Fault"),
                [("Content-Type", "application/json")],
                payload,
            )
            return

        if rule is not None and rule.mode == "delay":
            if self._proxy_server.closing.wait(rule.delay_seconds):
                return  # The proxy went down while this request was waiting.

        try:
            upstream_response = self._forward(body)
        except (OSError, http.client.HTTPException) as exc:
            if rule is not None and rule.mode == "drop_response":
                return
            payload = json.dumps({"error": "upstream_unreachable", "detail": str(exc)}).encode()
            self._respond(502, "Bad Gateway", [("Content-Type", "application/json")], payload)
            return
        status, reason, headers, payload = upstream_response
        proxy._log_upstream_status(log_id, status)

        if rule is not None and rule.mode == "drop_response":
            return  # The upstream server has handled the request. The client gets silence.
        self._respond(status, reason, headers, payload)

    def _read_request_body(self) -> bytes | None:
        """Read the request body. Returns ``None`` when the request has none."""
        if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
            return self._read_chunked_body()
        length_header = self.headers.get("Content-Length")
        if length_header is None:
            return None
        length = int(length_header)
        data = self.rfile.read(length)
        if len(data) < length:
            raise ConnectionError("The client closed the connection mid-body.")
        return data

    def _read_chunked_body(self) -> bytes:
        chunks: list[bytes] = []
        while True:
            size_line = self.rfile.readline(_MAX_HEADER_LINE)
            if not size_line:
                raise ConnectionError("The client closed the connection mid-body.")
            size = int(size_line.split(b";", 1)[0].strip(), 16)
            if size == 0:
                while self.rfile.readline(_MAX_HEADER_LINE) not in (b"\r\n", b"\n", b""):
                    pass  # Skip any trailer headers.
                return b"".join(chunks)
            chunk = self.rfile.read(size)
            if len(chunk) < size:
                raise ConnectionError("The client closed the connection mid-body.")
            chunks.append(chunk)
            self.rfile.readline(_MAX_HEADER_LINE)  # The CRLF after each chunk.

    def _forward(self, body: bytes | None) -> tuple[int, str, list[tuple[str, str]], bytes]:
        """Send the request upstream and return the full buffered response."""
        proxy = self._proxy_server.proxy
        named_in_connection = {
            token.strip().lower()
            for value in self.headers.get_all("Connection", [])
            for token in value.split(",")
        }
        headers = [("Host", proxy._upstream_netloc), ("Connection", "close")]
        for name, value in self.headers.items():
            lowered = name.lower()
            # The body was already read in full, so "Expect: 100-continue" is moot, and
            # Content-Length is recomputed below.
            if (
                lowered in _HOP_BY_HOP_HEADERS
                or lowered in named_in_connection
                or lowered in ("host", "content-length", "expect")
            ):
                continue
            headers.append((name, value))

        conn = http.client.HTTPConnection(
            proxy._upstream_host, proxy._upstream_port, timeout=proxy._upstream_timeout
        )
        try:
            conn.putrequest(self.command, self.path, skip_host=True, skip_accept_encoding=False)
            for name, value in headers:
                conn.putheader(name, value)
            if body is not None or self.command in ("POST", "PUT", "PATCH"):
                conn.putheader("Content-Length", str(len(body or b"")))
            conn.endheaders(body)
            response = conn.getresponse()
            payload = response.read()
            response_headers = [
                (name, value)
                for name, value in response.getheaders()
                if name.lower() not in _HOP_BY_HOP_HEADERS and name.lower() != "content-length"
            ]
            if self.command == "HEAD":
                # A HEAD reply has no body, but its Content-Length describes the GET.
                length = response.getheader("Content-Length")
                if length is not None:
                    response_headers.append(("Content-Length", length))
            return response.status, response.reason, response_headers, payload
        finally:
            conn.close()

    def _respond(
        self, status: int, reason: str, headers: list[tuple[str, str]], body: bytes
    ) -> None:
        """Send a complete response and end the connection."""
        self.send_response_only(status, reason)
        has_content_length = any(name.lower() == "content-length" for name, _ in headers)
        for name, value in headers:
            self.send_header(name, value)
        no_body = self.command == "HEAD" or status in (204, 304) or 100 <= status < 200
        if not no_body and not has_content_length:
            self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        if not no_body:
            self.wfile.write(body)
