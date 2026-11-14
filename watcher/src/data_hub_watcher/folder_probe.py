"""A look at the watch folder that can't hold up the thread that asks.

`models.watch_directory_problem` stats and lists the folder. On a network share that has
hung, one stat can block for the SMB timeout (about a minute on Windows) or, on a hard
NFS mount, for as long as the server is away. The supervisor's `poll` thread makes that
look, and it is also the thread that sees a stop, so a look that hangs there makes the
watcher ignore a stop. `FolderProbe` runs the look on a daemon thread and waits for it
for a limited time, and for less when the caller is told to stop.
"""

from __future__ import annotations
import logging
import os
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from data_hub_watcher import models
from data_hub_watcher.constants import FOLDER_PROBE_TIMEOUT_SECONDS

logger = logging.getLogger(__name__)

# How often a caller that can be cancelled looks at whether it has been, while it waits.
_CANCEL_POLL_SECONDS = 0.1


@dataclass(frozen=True)
class FolderLook:
    """What one look at the watch folder found."""

    # Why the folder can't be watched, or `None` when it can (see `watch_directory_problem`).
    problem: str | None
    # `(st_dev, st_ino)` of the folder, which says whether it is the same folder as an
    # earlier look found. `None` when there is a problem, and when the filesystem doesn't
    # say: some SMB servers report an inode number of 0 for everything.
    identity: tuple[int, int] | None = None

    @property
    def not_found(self) -> bool:
        """Whether the problem is that the folder does not exist."""
        return self.problem is not None and self.problem.startswith(
            models.WATCH_DIRECTORY_NOT_FOUND
        )


def look_at_folder(path: Path) -> FolderLook:
    """Look at *path* on this thread: `watch_directory_problem`, and the folder's identity."""
    problem = models.watch_directory_problem(path)
    if problem is not None:
        return FolderLook(problem=problem)
    try:
        status = os.stat(path)
    except OSError as exc:
        # It went away between the two looks.
        return FolderLook(
            problem=f"watch_directory is not readable: {path} ({exc.strerror or exc})"
        )
    if status.st_ino == 0:
        return FolderLook(problem=None)
    return FolderLook(problem=None, identity=(status.st_dev, status.st_ino))


class _Look:
    """One look in progress on its own daemon thread."""

    def __init__(self, path: Path, look: Callable[[Path], FolderLook]) -> None:
        self.path = path
        self.done = threading.Event()
        self.result: FolderLook | None = None
        self.error: Exception | None = None
        # Whether a caller has logged that it didn't answer, so a share that stays hung
        # is reported once, not by every upload thread that asks.
        self.timeout_logged = False
        self._look = look
        self.thread = threading.Thread(target=self._run, daemon=True, name="folder-probe")

    def _run(self) -> None:
        try:
            self.result = self._look(self.path)
        except Exception as exc:
            # Raised again on the thread that asked, as it would be without the thread.
            self.error = exc
        finally:
            self.done.set()


class FolderProbe:
    """Looks at the watch folder on a daemon thread, and waits for it for *timeout* seconds.

    A look that is not done by then is reported as a problem, "not responding", and the
    thread is left to finish on its own: it can't be interrupted while it is blocked in
    the filesystem. While it is still running, a further look doesn't start another thread
    for the same folder. It waits for that one, so a share that stays hung costs one
    blocked thread, and not one per look.

    Safe to call from several threads, such as the `poll` thread and the upload threads.
    """

    def __init__(
        self,
        timeout: float = FOLDER_PROBE_TIMEOUT_SECONDS,
        *,
        look: Callable[[Path], FolderLook] = look_at_folder,
    ) -> None:
        self._timeout = timeout
        self._look = look
        self._lock = threading.Lock()
        self._current: _Look | None = None

    def look(
        self, path: Path, should_cancel: Callable[[], bool] | None = None
    ) -> FolderLook | None:
        """Look at the folder at *path*. The result has a `problem` when it can't be watched.

        With *should_cancel*, the wait for the look is in short steps, and ends as soon as
        it returns `True`. The result is then `None`: the caller is stopping, and a look
        that wasn't finished says nothing about the folder, so the caller leaves things as
        they are. The look itself carries on in its thread, for whoever asks next. Without
        *should_cancel* the result is never `None`.
        """
        if should_cancel is not None and should_cancel():
            return None
        with self._lock:
            current = self._current
            if current is None or current.done.is_set() or current.path != path:
                current = _Look(path, self._look)
                self._current = current
                current.thread.start()
        deadline = time.monotonic() + self._timeout
        while not current.done.is_set():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                if not current.timeout_logged:
                    current.timeout_logged = True
                    logger.warning(
                        "The watch folder %s did not answer within %ss; "
                        "treating it as not responding",
                        path,
                        self._timeout,
                    )
                return FolderLook(problem=f"watch_directory not responding: {path}")
            if should_cancel is None:
                current.done.wait(remaining)
            elif not current.done.wait(min(remaining, _CANCEL_POLL_SECONDS)) and should_cancel():
                return None
        if current.error is not None:
            raise current.error
        assert current.result is not None
        return current.result
