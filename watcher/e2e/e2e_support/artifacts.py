"""Keeping what is needed to debug a failed end-to-end test.

A failure in CI is read from a download, so the files that show what happened are copied
into ``$DATA_HUB_E2E_ARTIFACTS/<test id>/`` when a test fails: the part of the server log
written during the test, every watcher log with its stdout and stderr, the watcher's state
database, the fault proxy's request log, a listing of the S3 stand-in, and a summary of the
server's view of each watcher. Nothing is copied for a test that passes.
"""

from __future__ import annotations
import contextlib
import os
import re
import shutil
import tempfile
from collections.abc import Iterable, Sequence
from datetime import datetime
from pathlib import Path

from data_hub_shared.testing import IntegrationEnv
from data_hub_shared.testing_proxy import FaultProxy
from e2e_support.drivers import WatcherDriver
from e2e_support.server import ServerView

__all__ = ["artifacts_root", "collect_failure_artifacts", "safe_name"]

ARTIFACTS_VARIABLE = "DATA_HUB_E2E_ARTIFACTS"

_default_root: Path | None = None


def artifacts_root() -> Path:
    """The folder failure artifacts go in: ``$DATA_HUB_E2E_ARTIFACTS``, or a folder in the
    system temp directory that is the same for the whole session. It is not created until
    something is copied."""
    global _default_root
    configured = os.environ.get(ARTIFACTS_VARIABLE)
    if configured:
        return Path(configured)
    if _default_root is None:
        _default_root = Path(tempfile.gettempdir()) / f"data-hub-e2e-artifacts-{os.getpid()}"
    return _default_root


def safe_name(node_id: str) -> str:
    """A pytest node id such as ``test_x.py::TestA::test_b[1]`` as a folder name."""
    return re.sub(r"[^A-Za-z0-9._-]+", "_", node_id).strip("_")[:150] or "test"


def _copy(source: Path, destination: Path) -> None:
    with contextlib.suppress(OSError):
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)


def _write(path: Path, text: str) -> None:
    with contextlib.suppress(OSError):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")


def collect_failure_artifacts(
    destination: Path,
    *,
    env: IntegrationEnv,
    server_log_offset: int,
    drivers: Iterable[WatcherDriver],
    proxy: FaultProxy | None,
    server: ServerView | None,
    server_views: Sequence[str] = (),
) -> Path:
    """Copy the debugging files for one failed test into ``destination`` and return it.

    ``server_views`` are summaries of the server's state per watcher, in the order of
    ``drivers``, taken at the moment of the failure (before the watchers were stopped). Where
    one is missing the state is read now.

    Every step is best effort: a missing file or a dead proxy must not hide the failure
    being reported.
    """
    destination.mkdir(parents=True, exist_ok=True)

    # The server log is shared by the whole session, so keep only what this test wrote.
    with contextlib.suppress(OSError):
        with env.server_log.open("rb") as log:
            log.seek(server_log_offset)
            (destination / "server.log").write_bytes(log.read())

    for number, driver in enumerate(drivers, start=1):
        folder = destination / f"watcher-{number}"
        for path in driver.logs():
            _copy(path, folder / path.name)
        db = driver.state_db_path()
        for suffix in ("", "-wal", "-shm"):
            candidate = db.with_name(db.name + suffix)
            if candidate.exists():
                _copy(candidate, folder / candidate.name)
        if driver.config_path.exists():
            _copy(driver.config_path, folder / "config.yaml")
        view = server_views[number - 1] if number <= len(server_views) else ""
        if not view and server is not None:
            with contextlib.suppress(Exception):
                view = server.dump(driver.watcher_id, driver.instrument_id)
        if view:
            _write(folder / "server-view.txt", view)

    if proxy is not None:
        lines = []
        for entry in proxy.requests:
            stamp = datetime.fromtimestamp(entry.timestamp).strftime("%H:%M:%S.%f")[:-3]
            lines.append(
                f"{stamp} {entry.method} {entry.path} fault={entry.fault_mode} "
                f"upstream={entry.upstream_status} client_gone={entry.client_gone}"
            )
        _write(destination / "proxy-requests.log", "\n".join(lines) + "\n")

    if server is not None:
        listing = [f"{size:>10}  {path}" for path, size in server.mirror_listing()]
        _write(destination / "s3-mirror.txt", "\n".join(listing) + "\n")
    return destination
