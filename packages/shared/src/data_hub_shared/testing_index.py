"""A small local Python package index, for testing watcher self-updates.

The watcher upgrades itself by running ``uv tool install --reinstall --index-url <url>
data-hub-watcher==<version>``. ``LocalPackageIndex`` is the index that command talks to
in tests. It lists the watcher wheels found in a local folder, so a test can offer a
"newer" watcher version without publishing anything. Every other package the install
needs (the watcher's dependencies) is handed off to the real PyPI.

The index speaks the "simple" repository protocol (PEP 503), plus the optional
``data-requires-python`` and core-metadata (PEP 658) extras that make installers faster.
Only the standard library is used.
"""

from __future__ import annotations
import hashlib
import html
import re
import sys
import threading
import zipfile
from collections.abc import Iterable
from dataclasses import dataclass
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, cast
from urllib.parse import quote, unquote, urlsplit

__all__ = ["LocalPackageIndex", "normalize_project_name"]


def normalize_project_name(name: str) -> str:
    """Normalize a project name the way PEP 503 does: lowercase, with every run of
    ``-``, ``_`` and ``.`` replaced by a single ``-``."""
    return re.sub(r"[-_.]+", "-", name).lower()


def _wheel_project(filename: str) -> str | None:
    """Return the normalized project name a wheel file belongs to, or ``None`` if the
    filename is not a wheel filename.

    Wheel filenames are ``{name}-{version}(-{build})?-{python}-{abi}-{platform}.whl``.
    The name part never contains a dash, because dashes in a name are written as
    underscores.
    """
    if not filename.endswith(".whl"):
        return None
    parts = filename[: -len(".whl")].split("-")
    if len(parts) not in (5, 6) or not parts[0]:
        return None
    return normalize_project_name(parts[0])


@dataclass(frozen=True)
class _WheelInfo:
    """What the index needs to know about one wheel file."""

    sha256: str
    requires_python: str | None
    # The wheel's METADATA file, or None if the wheel could not be opened as a zip.
    metadata: bytes | None


def _wheel_metadata(path: Path) -> bytes | None:
    """Read the METADATA file out of a wheel, or return ``None`` if there isn't a readable one."""
    try:
        with zipfile.ZipFile(path) as wheel:
            for name in wheel.namelist():
                if name.count("/") == 1 and name.endswith(".dist-info/METADATA"):
                    return wheel.read(name)
    except (zipfile.BadZipFile, OSError):
        return None
    return None


def _read_wheel(path: Path) -> _WheelInfo:
    data = path.read_bytes()
    metadata = _wheel_metadata(path)
    requires_python: str | None = None
    if metadata is not None:
        headers = BytesParser().parsebytes(metadata, headersonly=True)
        requires_python = (headers.get("Requires-Python") or "").strip() or None
    return _WheelInfo(hashlib.sha256(data).hexdigest(), requires_python, metadata)


class LocalPackageIndex:
    """A local package index that serves wheels from a folder.

    ``wheel_dir`` is scanned on every request, so a test can drop a new wheel into it
    while the index is running and the next install sees it. ``local_projects`` are the
    project names this index answers for itself. Requests for any other project are
    redirected (HTTP 302) to ``upstream``, which is the real PyPI by default, so an
    installer can still fetch dependencies.

    Use it as a context manager, or call :meth:`start` and :meth:`stop`::

        with LocalPackageIndex(wheel_dir) as index:
            subprocess.run(["uv", "pip", "install", "--index-url", index.url, "data-hub-watcher"])

    Pass :attr:`url` to the installer as its index URL.
    """

    def __init__(
        self,
        wheel_dir: Path,
        *,
        local_projects: Iterable[str] = ("data-hub-watcher",),
        upstream: str = "https://pypi.org/simple/",
    ) -> None:
        parts = urlsplit(upstream)
        if parts.scheme not in ("http", "https") or not parts.netloc:
            raise ValueError(f"upstream must be an http(s) URL, got {upstream!r}")
        self._wheel_dir = Path(wheel_dir)
        self._local_projects = frozenset(normalize_project_name(p) for p in local_projects)
        self._upstream = upstream if upstream.endswith("/") else upstream + "/"

        self._lock = threading.Lock()
        self._unavailable: dict[str, int] = {}
        self._requested: list[str] = []
        self._wheel_cache: dict[Path, tuple[int, int, _WheelInfo]] = {}

        self._server: _IndexServer | None = None
        self._thread: threading.Thread | None = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Start serving on a free local port. Call this once."""
        if self._server is not None:
            raise RuntimeError("The index is already started.")
        server = _IndexServer(("127.0.0.1", 0), _IndexHandler, self)
        self._server = server
        self._thread = threading.Thread(
            target=server.serve_forever,
            kwargs={"poll_interval": 0.05},
            name="local-package-index",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        """Stop serving. Safe to call more than once, or before :meth:`start`."""
        server, thread = self._server, self._thread
        self._server = None
        self._thread = None
        if server is None or thread is None:
            return
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    def __enter__(self) -> LocalPackageIndex:
        self.start()
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.stop()

    @property
    def port(self) -> int:
        """The port the index listens on. Only available while it is started."""
        if self._server is None:
            raise RuntimeError("The index is not started.")
        return self._server.server_address[1]

    @property
    def url(self) -> str:
        """The index URL to give an installer, such as ``http://127.0.0.1:54321/simple/``."""
        return f"http://127.0.0.1:{self.port}/simple/"

    # ------------------------------------------------------------------
    # Failure switches
    # ------------------------------------------------------------------

    def set_project_unavailable(self, project: str, status: int = 503) -> None:
        """Make the index fail for one project, for testing failed installs.

        While set, the project's page and its wheel files answer with ``status``
        instead of the real content. This applies to projects that are redirected to
        the upstream index too. Note that installers such as ``uv`` retry 5xx answers a
        few times before giving up, so a 4xx status such as 404 fails faster.
        """
        if not 400 <= status <= 599:
            raise ValueError(f"status must be an error status (400-599), got {status}.")
        with self._lock:
            self._unavailable[normalize_project_name(project)] = status

    def clear_unavailable(self) -> None:
        """Undo every :meth:`set_project_unavailable` call."""
        with self._lock:
            self._unavailable.clear()

    # ------------------------------------------------------------------
    # Request log
    # ------------------------------------------------------------------

    @property
    def requested_paths(self) -> list[str]:
        """The request targets (path plus query) the index has received, oldest first."""
        with self._lock:
            return list(self._requested)

    def clear_requested_paths(self) -> None:
        """Forget the recorded request targets."""
        with self._lock:
            self._requested.clear()

    # ------------------------------------------------------------------
    # Serving
    # ------------------------------------------------------------------

    def _record(self, target: str) -> None:
        with self._lock:
            self._requested.append(target)

    def _unavailable_status(self, project: str) -> int | None:
        with self._lock:
            return self._unavailable.get(project)

    def _wheels(self, project: str) -> dict[str, tuple[Path, _WheelInfo]]:
        """Scan ``wheel_dir`` and return this project's wheels by filename."""
        found: dict[str, tuple[Path, _WheelInfo]] = {}
        for path in sorted(self._wheel_dir.glob("*.whl")):
            if _wheel_project(path.name) != project:
                continue
            try:
                found[path.name] = (path, self._wheel_info(path))
            except OSError:
                continue  # The file vanished or is still being written.
        return found

    def _wheel_info(self, path: Path) -> _WheelInfo:
        stat = path.stat()
        with self._lock:
            cached = self._wheel_cache.get(path)
        if cached is not None and cached[:2] == (stat.st_mtime_ns, stat.st_size):
            return cached[2]
        info = _read_wheel(path)
        with self._lock:
            self._wheel_cache[path] = (stat.st_mtime_ns, stat.st_size, info)
        return info

    def _project_page(self, project: str, base_url: str) -> bytes:
        links = []
        for filename, (_, info) in self._wheels(project).items():
            href = f"{base_url}/files/{quote(filename)}#sha256={info.sha256}"
            attributes = ""
            if info.requires_python:
                attributes += f' data-requires-python="{html.escape(info.requires_python)}"'
            if info.metadata is not None:
                metadata_sha = hashlib.sha256(info.metadata).hexdigest()
                attributes += f' data-dist-info-metadata="sha256={metadata_sha}"'
                attributes += f' data-core-metadata="sha256={metadata_sha}"'
            links.append(f'<a href="{html.escape(href)}"{attributes}>{html.escape(filename)}</a>')
        title = html.escape(project)
        body = "<br/>\n".join(links)
        return (
            '<!DOCTYPE html>\n<html>\n<head>\n<meta name="pypi:repository-version" '
            f'content="1.0">\n<title>Links for {title}</title>\n</head>\n<body>\n'
            f"<h1>Links for {title}</h1>\n{body}\n</body>\n</html>\n"
        ).encode()

    def _root_page(self) -> bytes:
        links = "<br/>\n".join(
            f'<a href="/simple/{html.escape(p)}/">{html.escape(p)}</a>'
            for p in sorted(self._local_projects)
        )
        return (
            '<!DOCTYPE html>\n<html>\n<head>\n<meta name="pypi:repository-version" '
            'content="1.0">\n<title>Simple index</title>\n</head>\n<body>\n'
            f"{links}\n</body>\n</html>\n"
        ).encode()


class _IndexServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 128

    def __init__(
        self,
        address: tuple[str, int],
        handler: type[BaseHTTPRequestHandler],
        index: LocalPackageIndex,
    ) -> None:
        self.index = index
        super().__init__(address, handler)

    def handle_error(self, request: Any, client_address: Any) -> None:
        # Installers hanging up mid-download is not worth a traceback.
        if isinstance(sys.exc_info()[1], OSError):
            return
        super().handle_error(request, client_address)


class _IndexHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    @property
    def _index(self) -> LocalPackageIndex:
        return cast(_IndexServer, self.server).index

    def log_message(self, format: str, *args: object) -> None:
        """Stay quiet; the index records requested paths itself."""

    def do_GET(self) -> None:
        self._serve(send_body=True)

    def do_HEAD(self) -> None:
        self._serve(send_body=False)

    def _serve(self, *, send_body: bool) -> None:
        index = self._index
        index._record(self.path)
        path = unquote(urlsplit(self.path).path)
        host = self.headers.get("Host") or f"127.0.0.1:{index.port}"
        base_url = f"http://{host}"

        if path in ("/simple", "/simple/"):
            self._send(200, index._root_page(), "text/html; charset=utf-8", send_body)
        elif path.startswith("/simple/"):
            project_part = path[len("/simple/") :].rstrip("/")
            if not project_part or "/" in project_part:
                self._send_error(404, send_body)
                return
            self._serve_project(normalize_project_name(project_part), base_url, send_body)
        elif path.startswith("/files/"):
            self._serve_file(path[len("/files/") :], send_body)
        else:
            self._send_error(404, send_body)

    def _serve_project(self, project: str, base_url: str, send_body: bool) -> None:
        index = self._index
        status = index._unavailable_status(project)
        if status is not None:
            self._send_error(status, send_body)
        elif project in index._local_projects:
            page = index._project_page(project, base_url)
            self._send(200, page, "text/html; charset=utf-8", send_body)
        else:
            location = f"{index._upstream}{project}/"
            self.send_response(302)
            self.send_header("Location", location)
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Length", "0")
            self.send_header("Connection", "close")
            self.end_headers()

    def _serve_file(self, name: str, send_body: bool) -> None:
        index = self._index
        want_metadata = name.endswith(".whl.metadata")
        filename = name[: -len(".metadata")] if want_metadata else name
        project = _wheel_project(filename)
        if project is None or project not in index._local_projects or "/" in name or "\\" in name:
            self._send_error(404, send_body)
            return
        status = index._unavailable_status(project)
        if status is not None:
            self._send_error(status, send_body)
            return
        entry = index._wheels(project).get(filename)
        if entry is None:
            self._send_error(404, send_body)
            return
        path, info = entry
        if want_metadata:
            if info.metadata is None:
                self._send_error(404, send_body)
            else:
                self._send(200, info.metadata, "text/plain; charset=utf-8", send_body)
            return
        try:
            data = path.read_bytes()
        except OSError:
            self._send_error(404, send_body)
            return
        self._send(200, data, "application/octet-stream", send_body)

    def _send_error(self, status: int, send_body: bool) -> None:
        self._send(status, f"{status}\n".encode(), "text/plain; charset=utf-8", send_body)

    def _send(self, status: int, body: bytes, content_type: str, send_body: bool) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        if send_body:
            self.wfile.write(body)
