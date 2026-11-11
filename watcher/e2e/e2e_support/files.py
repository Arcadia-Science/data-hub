"""Helpers that put files into a watch folder the way an instrument does.

Scenarios write the same kinds of files over and over: a run folder with a few data files,
a file that is still being written, a file of an exact size. These helpers do it in one
line and give back the bytes written, so the test can compare them with what the S3
stand-in holds.

The test server stores uploads of 1 KB or more as multipart uploads in 1 KB parts and
smaller files with a single PUT (``MULTIPART_THRESHOLD_BYTES``), so :data:`SMALL` and
:data:`LARGE` are on each side of that line.
"""

from __future__ import annotations
import contextlib
import hashlib
import os
import threading
from collections.abc import Mapping
from pathlib import Path
from types import TracebackType

__all__ = [
    "LARGE",
    "MULTIPART_THRESHOLD_BYTES",
    "SMALL",
    "GrowingFile",
    "payload",
    "write_file",
    "write_run",
]

# The harness starts the server with MULTIPART_THRESHOLD_BYTES and MULTIPART_PART_SIZE_BYTES
# of 1024 (see `_build_server_env` in packages/shared/src/data_hub_shared/testing.py).
MULTIPART_THRESHOLD_BYTES = 1024

SMALL = 600  # bytes: one PUT
LARGE = 5000  # bytes: five parts


def payload(size: int, seed: int = 0) -> bytes:
    """``size`` bytes of repeatable, non-repeating-looking content.

    The same ``(size, seed)`` always gives the same bytes, and different seeds give
    different bytes, so a test can tell one file's upload from another's and can write a
    "changed" version of a file with another seed.
    """
    out = bytearray()
    counter = 0
    while len(out) < size:
        out += hashlib.sha256(f"{seed}:{counter}".encode()).digest()
        counter += 1
    return bytes(out[:size])


def write_file(path: Path, content: bytes | int = SMALL, *, mtime: float | None = None) -> bytes:
    """Write a file, creating its folders, and return its bytes.

    ``content`` is the bytes, or a size for :func:`payload`. ``mtime`` sets the modification
    time (seconds since the epoch), to make a file look old. The file is written in one call,
    so the watcher sees it appear whole and then waits for it to be stable.
    """
    data = payload(content) if isinstance(content, int) else content
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    if mtime is not None:
        os.utime(path, (mtime, mtime))
    return data


def write_run(
    watch_dir: Path, run_id: str, files: Mapping[str, bytes | int] | None = None
) -> dict[str, bytes]:
    """Write ``<watch_dir>/<run_id>/<name>`` for each file and return ``{name: bytes}``.

    The default is one small and one large ``.csv``, which exercises both upload paths.
    With the default run detection (the top-level folder is the run), ``<run_id>`` is the
    run's name on the server and the files' relative paths are ``<run_id>/<name>``.
    """
    spec = files if files is not None else {"small.csv": SMALL, "large.csv": LARGE}
    return {name: write_file(watch_dir / run_id / name, content) for name, content in spec.items()}


class GrowingFile:
    """A file that keeps being appended to, like an instrument still writing it.

    Use it as a context manager: the file is created, then ``chunk`` is appended every
    ``interval`` seconds from a thread, so its size and modification time keep changing and
    the watcher never finds it stable, until the block ends or :meth:`stop` is called::

        with GrowingFile(watch_dir / "RUN1" / "live.csv"):
            ...  # the watcher sees it growing
        # now it stops growing, and the watcher can call it stable
    """

    def __init__(self, path: Path, *, chunk: bytes = b"0123456789\n", interval: float = 0.25):
        self.path = path
        self._chunk = chunk
        self._interval = interval
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.size = 0

    def start(self) -> GrowingFile:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_bytes(self._chunk)
        self.size = len(self._chunk)
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="growing-file", daemon=True)
        self._thread.start()
        return self

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            with contextlib.suppress(OSError), self.path.open("ab") as handle:
                handle.write(self._chunk)
                self.size += len(self._chunk)

    def stop(self) -> bytes:
        """Stop growing and return what the file holds."""
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None
        return self.path.read_bytes() if self.path.exists() else b""

    def __enter__(self) -> GrowingFile:
        return self.start()

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.stop()
