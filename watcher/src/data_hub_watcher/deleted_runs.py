"""The runs Data Hub refused because they were deleted there."""

from __future__ import annotations
import threading


class DeletedRuns:
    """The runs the server refused with a 409 because an admin deleted them.

    The run detector and the uploader share one instance. A report or an update goes out on
    the monitor's stability thread and uploads run on their own threads, so every method
    takes the lock. A run stays in the set until the process ends, or until the server answers
    an upload-URL request for it (`discard`), which it does only for a run that was restored.
    While a run is in the set, both stop sending requests about it. A restart starts with an
    empty set and tries each run once more, which is how a run that was restored gets the files
    that were skipped while it was in the set.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._run_ids: set[str] = set()

    def add(self, run_id: str) -> bool:
        """Remember *run_id*. True only for the call that added it, which should say so."""
        with self._lock:
            if run_id in self._run_ids:
                return False
            self._run_ids.add(run_id)
            return True

    def discard(self, run_id: str) -> bool:
        """Forget *run_id*, which the server has answered for. True when it was in the set."""
        with self._lock:
            if run_id not in self._run_ids:
                return False
            self._run_ids.remove(run_id)
            return True

    def __contains__(self, run_id: object) -> bool:
        with self._lock:
            return run_id in self._run_ids
