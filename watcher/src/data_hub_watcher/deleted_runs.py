"""The runs Data Hub refused because they were deleted there."""

from __future__ import annotations
import threading


class DeletedRuns:
    """The runs the server refused with a 409 because an admin deleted them.

    The run detector and the uploader share one instance. A report or an update goes out on
    the monitor's stability thread and uploads run on their own threads, so every method
    takes the lock. A run stays in the set for the life of the process: both stop sending
    requests about it, and a restart starts with an empty set and tries each run once more,
    which is how a run that was restored gets its files.
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

    def __contains__(self, run_id: object) -> bool:
        with self._lock:
            return run_id in self._run_ids
