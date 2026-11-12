"""Tests for the local package index."""

from __future__ import annotations
import base64
import hashlib
import re
import shutil
import socket
import subprocess
import sys
import zipfile
from collections.abc import Iterable, Iterator
from pathlib import Path
from urllib.parse import unquote, urlsplit

import pytest
import requests

from data_hub_shared.testing_index import LocalPackageIndex, normalize_project_name

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_wheel(
    directory: Path,
    name: str,
    version: str = "1.0.0",
    *,
    requires_python: str | None = ">=3.8",
    requires_dist: Iterable[str] = (),
) -> Path:
    """Write a tiny, dependency-free wheel for a package called ``name``.

    The package has one module, ``<name with underscores>``, with ``VALUE = "<name>"``.
    """
    module = re.sub(r"[-_.]+", "_", name).lower()
    dist_info = f"{module}-{version}.dist-info"
    metadata_lines = ["Metadata-Version: 2.1", f"Name: {name}", f"Version: {version}"]
    if requires_python:
        metadata_lines.append(f"Requires-Python: {requires_python}")
    metadata_lines += [f"Requires-Dist: {requirement}" for requirement in requires_dist]
    files = {
        f"{module}/__init__.py": f'VALUE = "{name}"\n'.encode(),
        f"{dist_info}/METADATA": ("\n".join(metadata_lines) + "\n").encode(),
        f"{dist_info}/WHEEL": (
            b"Wheel-Version: 1.0\nGenerator: tests\nRoot-Is-Purelib: true\nTag: py3-none-any\n"
        ),
    }
    record = []
    for path, data in files.items():
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
        record.append(f"{path},sha256={digest},{len(data)}")
    record.append(f"{dist_info}/RECORD,,")
    files[f"{dist_info}/RECORD"] = ("\n".join(record) + "\n").encode()

    wheel = directory / f"{module}-{version}-py3-none-any.whl"
    with zipfile.ZipFile(wheel, "w", zipfile.ZIP_DEFLATED) as archive:
        for path, data in files.items():
            archive.writestr(path, data)
    return wheel


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def links(page: str) -> list[tuple[str, str]]:
    """Return ``(href, anchor text)`` for every link on a simple-index page."""
    return re.findall(r'<a href="([^"]*)"[^>]*>([^<]*)</a>', page)


@pytest.fixture
def wheel_dir(tmp_path: Path) -> Path:
    directory = tmp_path / "wheels"
    directory.mkdir()
    return directory


@pytest.fixture
def http() -> Iterator[requests.Session]:
    # Ignore proxy settings in the environment: these requests are for localhost.
    with requests.Session() as session:
        session.trust_env = False
        yield session


@pytest.fixture
def index(wheel_dir: Path) -> Iterator[LocalPackageIndex]:
    with LocalPackageIndex(wheel_dir) as running:
        yield running


# ---------------------------------------------------------------------------
# Listing and downloading wheels
# ---------------------------------------------------------------------------


def test_project_page_lists_every_wheel_of_the_project(
    index: LocalPackageIndex, wheel_dir: Path, http: requests.Session
) -> None:
    old = make_wheel(wheel_dir, "data-hub-watcher", "1.3.0")
    new = make_wheel(wheel_dir, "data-hub-watcher", "1.4.1000", requires_python=">=3.12")
    make_wheel(wheel_dir, "some-other-project", "2.0.0")
    (wheel_dir / "notes.txt").write_text("not a wheel")
    (wheel_dir / "data_hub_watcher-1.4.0.tar.gz").write_bytes(b"an sdist is not served")
    # A wheel filename may carry a build tag. A name without the tags is not a wheel name.
    tagged = wheel_dir / "data_hub_watcher-1.5.0-1-py3-none-any.whl"
    tagged.write_bytes(b"content does not matter here")
    (wheel_dir / "data_hub_watcher-1.0.0.whl").write_bytes(b"not a valid wheel filename")

    response = http.get(index.url + "data-hub-watcher/", timeout=10)

    assert response.status_code == 200
    assert response.headers["Content-Type"].startswith("text/html")
    found = links(response.text)
    assert sorted(text for _, text in found) == sorted([old.name, new.name, tagged.name])
    for href, text in found:
        assert href.startswith(f"http://127.0.0.1:{index.port}/files/")
        assert unquote(href.split("#")[0]).endswith("/" + text)
    assert 'data-requires-python="&gt;=3.12"' in response.text


def test_project_page_with_no_wheels_is_empty_but_valid(
    index: LocalPackageIndex, http: requests.Session
) -> None:
    # Never follow a redirect here: that would leave for the real PyPI.
    response = http.get(index.url + "data-hub-watcher/", timeout=10, allow_redirects=False)

    assert response.status_code == 200
    assert links(response.text) == []


@pytest.mark.parametrize(
    "requested", ["data-hub-watcher", "Data_Hub.Watcher", "DATA-HUB-WATCHER", "data__hub--watcher"]
)
def test_project_names_are_normalized(
    requested: str, index: LocalPackageIndex, wheel_dir: Path, http: requests.Session
) -> None:
    # Wheel filenames write the name with underscores.
    wheel = make_wheel(wheel_dir, "data-hub-watcher", "1.0.0")
    assert wheel.name.startswith("data_hub_watcher-")

    response = http.get(index.url + requested + "/", timeout=10)

    assert [text for _, text in links(response.text)] == [wheel.name]


def test_local_project_names_are_normalized_too(wheel_dir: Path, http: requests.Session) -> None:
    wheel = make_wheel(wheel_dir, "My.Package_Name", "1.0.0")

    with LocalPackageIndex(wheel_dir, local_projects=["My_Package.Name"]) as index:
        response = http.get(index.url + "my-package-name/", timeout=10)

    assert [text for _, text in links(response.text)] == [wheel.name]


def test_wheel_links_carry_the_sha256_of_the_served_file(
    index: LocalPackageIndex, wheel_dir: Path, http: requests.Session
) -> None:
    wheels = [make_wheel(wheel_dir, "data-hub-watcher", v) for v in ("1.0.0", "1.1.0")]

    page = http.get(index.url + "data-hub-watcher/", timeout=10).text

    assert len(links(page)) == 2
    for href, text in links(page):
        url, _, fragment = href.partition("#")
        downloaded = http.get(url, timeout=10)
        assert downloaded.status_code == 200
        assert downloaded.headers["Content-Type"] == "application/octet-stream"
        expected = sha256_of(wheel_dir / text)
        assert fragment == f"sha256={expected}"
        assert hashlib.sha256(downloaded.content).hexdigest() == expected
        assert downloaded.content == (wheel_dir / text).read_bytes()
    assert {w.name for w in wheels} == {text for _, text in links(page)}


def test_core_metadata_is_served_and_matches_its_advertised_hash(
    index: LocalPackageIndex, wheel_dir: Path, http: requests.Session
) -> None:
    wheel = make_wheel(wheel_dir, "data-hub-watcher", "1.0.0", requires_dist=["idna"])
    page = http.get(index.url + "data-hub-watcher/", timeout=10).text
    (href, _) = links(page)[0]

    metadata = http.get(href.split("#")[0] + ".metadata", timeout=10)

    assert metadata.status_code == 200
    assert "Requires-Dist: idna" in metadata.text
    with zipfile.ZipFile(wheel) as archive:
        assert metadata.content == archive.read("data_hub_watcher-1.0.0.dist-info/METADATA")
    advertised = f'data-dist-info-metadata="sha256={hashlib.sha256(metadata.content).hexdigest()}"'
    assert advertised in page


def test_a_wheel_dropped_in_later_shows_up_on_the_next_request(
    index: LocalPackageIndex, wheel_dir: Path, http: requests.Session
) -> None:
    make_wheel(wheel_dir, "data-hub-watcher", "1.0.0")
    first = http.get(index.url + "data-hub-watcher/", timeout=10).text

    newer = make_wheel(wheel_dir, "data-hub-watcher", "1.0.1000")
    second = http.get(index.url + "data-hub-watcher/", timeout=10).text
    newer.unlink()
    third = http.get(index.url + "data-hub-watcher/", timeout=10).text

    assert len(links(first)) == 1
    assert [text for _, text in links(second)] == [
        "data_hub_watcher-1.0.0-py3-none-any.whl",
        "data_hub_watcher-1.0.1000-py3-none-any.whl",
    ]
    assert len(links(third)) == 1


def test_a_replaced_wheel_gets_its_new_hash(
    index: LocalPackageIndex, wheel_dir: Path, http: requests.Session
) -> None:
    wheel = make_wheel(wheel_dir, "data-hub-watcher", "1.0.0", requires_dist=[])
    before = links(http.get(index.url + "data-hub-watcher/", timeout=10).text)[0][0]

    wheel.unlink()
    make_wheel(wheel_dir, "data-hub-watcher", "1.0.0", requires_dist=["idna"])
    after = links(http.get(index.url + "data-hub-watcher/", timeout=10).text)[0][0]

    assert before.split("#")[1] != after.split("#")[1]
    assert after.endswith(sha256_of(wheel))


def test_a_file_that_is_not_a_valid_wheel_is_listed_without_metadata(
    index: LocalPackageIndex, wheel_dir: Path, http: requests.Session
) -> None:
    broken = wheel_dir / "data_hub_watcher-9.9.9-py3-none-any.whl"
    broken.write_bytes(b"this is not a zip file")

    page = http.get(index.url + "data-hub-watcher/", timeout=10).text

    ((href, text),) = links(page)
    assert text == broken.name
    assert href.endswith(f"#sha256={sha256_of(broken)}")
    assert "data-dist-info-metadata" not in page
    assert http.get(href.split("#")[0] + ".metadata", timeout=10).status_code == 404


@pytest.mark.parametrize(
    "path",
    [
        "/files/missing-1.0.0-py3-none-any.whl",
        "/files/data_hub_watcher-9.9.9-py3-none-any.whl",
        "/files/data_hub_watcher-9.9.9-py3-none-any.whl.metadata",
        "/files/some_other_project-2.0.0-py3-none-any.whl",
        "/files/notes.txt",
        "/files/..%2Fsecret.whl",
        "/files/%2e%2e/%2e%2e/secret.whl",
        "/files/sub/dir-1.0.0-py3-none-any.whl",
        "/files/",
        "/",
        "/simple/a/b/",
        "/other",
    ],
)
def test_unknown_paths_and_file_names_are_not_found(
    path: str, index: LocalPackageIndex, wheel_dir: Path, http: requests.Session
) -> None:
    make_wheel(wheel_dir, "some-other-project", "2.0.0")
    (wheel_dir / "notes.txt").write_text("hello")

    # Never follow a redirect here: that would leave for the real PyPI.
    response = http.get(f"http://127.0.0.1:{index.port}{path}", timeout=10, allow_redirects=False)

    assert response.status_code == 404


def test_root_page_lists_the_local_projects(wheel_dir: Path, http: requests.Session) -> None:
    with LocalPackageIndex(wheel_dir, local_projects=["Beta_Pkg", "alpha"]) as index:
        response = http.get(index.url, timeout=10)

    assert [text for _, text in links(response.text)] == ["alpha", "beta-pkg"]


def test_head_requests_return_headers_without_a_body(
    index: LocalPackageIndex, wheel_dir: Path, http: requests.Session
) -> None:
    wheel = make_wheel(wheel_dir, "data-hub-watcher", "1.0.0")
    url = links(http.get(index.url + "data-hub-watcher/", timeout=10).text)[0][0].split("#")[0]

    response = http.head(url, timeout=10)

    assert response.status_code == 200
    assert int(response.headers["Content-Length"]) == wheel.stat().st_size

    # Read the raw reply to be sure that nothing follows the headers.
    with socket.create_connection(("127.0.0.1", index.port), timeout=10) as sock:
        sock.sendall(f"HEAD {urlsplit(url).path} HTTP/1.1\r\nHost: x\r\n\r\n".encode())
        raw = b""
        while chunk := sock.recv(4096):
            raw += chunk
    assert raw.endswith(b"\r\n\r\n")


# ---------------------------------------------------------------------------
# Handing other projects to the upstream index
# ---------------------------------------------------------------------------


def test_other_projects_are_redirected_to_pypi_by_default(
    index: LocalPackageIndex, http: requests.Session
) -> None:
    response = http.get(index.url + "idna/", timeout=10, allow_redirects=False)

    assert response.status_code == 302
    assert response.headers["Location"] == "https://pypi.org/simple/idna/"


@pytest.mark.parametrize("upstream", ["http://127.0.0.1:9/simple/", "http://127.0.0.1:9/simple"])
def test_the_redirect_uses_the_normalized_name_and_the_given_upstream(
    upstream: str, wheel_dir: Path, http: requests.Session
) -> None:
    with LocalPackageIndex(wheel_dir, upstream=upstream) as index:
        response = http.get(index.url + "Typing_Extensions/", timeout=10, allow_redirects=False)

    assert response.status_code == 302
    assert response.headers["Location"] == "http://127.0.0.1:9/simple/typing-extensions/"


def test_following_the_redirect_reaches_the_upstream_index(
    tmp_path: Path, wheel_dir: Path, http: requests.Session
) -> None:
    upstream_dir = tmp_path / "upstream-wheels"
    upstream_dir.mkdir()
    child = make_wheel(upstream_dir, "dhw-test-child", "3.0.0")

    with LocalPackageIndex(upstream_dir, local_projects=["dhw-test-child"]) as upstream:
        upstream_url = upstream.url
        with LocalPackageIndex(wheel_dir, upstream=upstream_url) as index:
            response = http.get(index.url + "dhw_test_child/", timeout=10)

    assert response.url == upstream_url + "dhw-test-child/"
    assert [text for _, text in links(response.text)] == [child.name]


def test_invalid_upstream_is_rejected(wheel_dir: Path) -> None:
    for bad in ("pypi.org/simple/", "file:///simple/", "https://"):
        with pytest.raises(ValueError, match="upstream"):
            LocalPackageIndex(wheel_dir, upstream=bad)


# ---------------------------------------------------------------------------
# Failure switches
# ---------------------------------------------------------------------------


def test_unavailable_project_fails_its_page_and_files_until_cleared(
    index: LocalPackageIndex, wheel_dir: Path, http: requests.Session
) -> None:
    make_wheel(wheel_dir, "data-hub-watcher", "1.0.0")
    file_url = links(http.get(index.url + "data-hub-watcher/", timeout=10).text)[0][0]

    index.set_project_unavailable("Data_Hub.Watcher")

    assert http.get(index.url + "data-hub-watcher/", timeout=10).status_code == 503
    assert http.get(file_url.split("#")[0], timeout=10).status_code == 503
    assert http.get(file_url.split("#")[0] + ".metadata", timeout=10).status_code == 503

    index.clear_unavailable()

    assert http.get(index.url + "data-hub-watcher/", timeout=10).status_code == 200
    assert http.get(file_url.split("#")[0], timeout=10).status_code == 200


def test_unavailable_status_is_configurable_and_applies_to_redirected_projects(
    index: LocalPackageIndex, http: requests.Session
) -> None:
    index.set_project_unavailable("idna", status=404)
    index.set_project_unavailable("data-hub-watcher")

    assert http.get(index.url + "idna/", timeout=10, allow_redirects=False).status_code == 404
    assert http.get(index.url + "data-hub-watcher/", timeout=10).status_code == 503
    # Projects that were not switched off keep working.
    redirected = http.get(index.url + "requests/", timeout=10, allow_redirects=False)
    assert redirected.status_code == 302


def test_unavailable_rejects_a_non_error_status(index: LocalPackageIndex) -> None:
    with pytest.raises(ValueError, match="status"):
        index.set_project_unavailable("data-hub-watcher", status=200)


# ---------------------------------------------------------------------------
# Lifecycle and request log
# ---------------------------------------------------------------------------


def test_url_points_at_the_simple_root_on_localhost(wheel_dir: Path) -> None:
    index = LocalPackageIndex(wheel_dir)
    with pytest.raises(RuntimeError, match="not started"):
        _ = index.url

    with index:
        assert re.fullmatch(r"http://127\.0\.0\.1:\d+/simple/", index.url)
        assert index.url == f"http://127.0.0.1:{index.port}/simple/"


def test_stop_ends_service_and_is_safe_to_repeat(wheel_dir: Path) -> None:
    index = LocalPackageIndex(wheel_dir)
    index.stop()  # Never started: harmless.
    index.start()
    url = index.url
    with pytest.raises(RuntimeError, match="already started"):
        index.start()

    index.stop()
    index.stop()

    with pytest.raises(requests.ConnectionError), requests.Session() as session:
        session.trust_env = False
        session.get(url, timeout=5)


def test_requested_paths_are_recorded_in_order(
    index: LocalPackageIndex, wheel_dir: Path, http: requests.Session
) -> None:
    make_wheel(wheel_dir, "data-hub-watcher", "1.0.0")
    page = http.get(index.url + "data-hub-watcher/", timeout=10).text
    http.get(links(page)[0][0].split("#")[0], timeout=10)
    http.get(index.url + "idna/", timeout=10, allow_redirects=False)

    assert index.requested_paths == [
        "/simple/data-hub-watcher/",
        "/files/data_hub_watcher-1.0.0-py3-none-any.whl",
        "/simple/idna/",
    ]
    index.clear_requested_paths()
    assert index.requested_paths == []


def test_normalize_project_name() -> None:
    assert normalize_project_name("Friendly-Bard") == "friendly-bard"
    assert normalize_project_name("FRIENDLY__BARD") == "friendly-bard"
    assert normalize_project_name("friendly.bard") == "friendly-bard"
    assert normalize_project_name("Friendly._-Bard") == "friendly-bard"


# ---------------------------------------------------------------------------
# A real installer against the index
# ---------------------------------------------------------------------------

needs_uv = pytest.mark.skipif(shutil.which("uv") is None, reason="`uv` is not on the PATH")


def _new_venv(directory: Path) -> Path:
    """Create an empty virtual environment and return its Python interpreter."""
    uv = shutil.which("uv")
    assert uv is not None
    venv = directory / "venv"
    subprocess.run(
        [uv, "venv", "--python", sys.executable, str(venv)],
        check=True,
        capture_output=True,
        text=True,
        timeout=120,
    )
    return venv / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")


def _uv_install(python: Path, index_url: str, package: str) -> subprocess.CompletedProcess[str]:
    uv = shutil.which("uv")
    assert uv is not None
    return subprocess.run(
        # --no-cache keeps the test's wheels out of the developer's uv cache.
        [uv, "pip", "install", "--no-cache", "--python", str(python), "--index-url", index_url]
        + [package],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )


def _run_python(python: Path, code: str) -> str:
    result = subprocess.run(
        [str(python), "-c", code], capture_output=True, text=True, timeout=60, check=True
    )
    return result.stdout.strip()


@needs_uv
def test_uv_installs_a_dummy_wheel_from_the_index_alone(tmp_path: Path, wheel_dir: Path) -> None:
    make_wheel(wheel_dir, "dhw-test-dummy", "1.2.3")
    python = _new_venv(tmp_path)

    with LocalPackageIndex(wheel_dir, local_projects=["dhw-test-dummy"]) as index:
        result = _uv_install(python, index.url, "dhw-test-dummy==1.2.3")
        requested = index.requested_paths

    assert result.returncode == 0, result.stderr
    assert _run_python(python, "import dhw_test_dummy; print(dhw_test_dummy.VALUE)") == (
        "dhw-test-dummy"
    )
    assert "/simple/dhw-test-dummy/" in requested
    assert any(path.startswith("/files/dhw_test_dummy-1.2.3-") for path in requested)


@needs_uv
def test_uv_follows_the_redirect_to_get_dependencies_from_the_upstream_index(
    tmp_path: Path, wheel_dir: Path
) -> None:
    # The upstream index stands in for PyPI, so this test needs no network.
    upstream_dir = tmp_path / "upstream-wheels"
    upstream_dir.mkdir()
    make_wheel(upstream_dir, "dhw-test-child", "3.0.0")
    make_wheel(wheel_dir, "dhw-test-parent", "2.0.0", requires_dist=["dhw-test-child>=3"])
    python = _new_venv(tmp_path)

    with LocalPackageIndex(upstream_dir, local_projects=["dhw-test-child"]) as upstream:
        with LocalPackageIndex(
            wheel_dir, local_projects=["dhw-test-parent"], upstream=upstream.url
        ) as index:
            result = _uv_install(python, index.url, "dhw-test-parent")
            asked_local_index = index.requested_paths
            asked_upstream = upstream.requested_paths

    assert result.returncode == 0, result.stderr
    code = "import dhw_test_parent, dhw_test_child; print(dhw_test_child.VALUE)"
    assert _run_python(python, code) == "dhw-test-child"
    assert "/simple/dhw-test-child/" in asked_local_index
    assert "/simple/dhw-test-child/" in asked_upstream
    assert any(path.startswith("/files/dhw_test_child-3.0.0-") for path in asked_upstream)


@needs_uv
def test_uv_install_fails_when_the_project_is_unavailable(tmp_path: Path, wheel_dir: Path) -> None:
    make_wheel(wheel_dir, "dhw-test-dummy", "1.0.0")
    python = _new_venv(tmp_path)

    with LocalPackageIndex(wheel_dir, local_projects=["dhw-test-dummy"]) as index:
        # A 404 makes uv give up at once. Server errors would be retried first.
        index.set_project_unavailable("dhw-test-dummy", status=404)
        broken = _uv_install(python, index.url, "dhw-test-dummy")
        index.clear_unavailable()
        fixed = _uv_install(python, index.url, "dhw-test-dummy")

    assert broken.returncode != 0
    assert fixed.returncode == 0, fixed.stderr
