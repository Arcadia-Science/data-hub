"""Top-level conftest for the watcher test suite.

Integration-specific fixtures (server start-up, DB resets, DataHubClient)
live in ``integration/conftest.py``. This file is intentionally minimal —
add shared unit-test fixtures here as needed.
"""

from __future__ import annotations
import logging
import os
from collections.abc import Callable, Iterator
from types import SimpleNamespace
from typing import Any

import pytest

from data_hub_watcher import monitor as monitor_module
from data_hub_watcher import testing_overrides


@pytest.fixture(autouse=True)
def _no_test_only_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    """Start every test with none of the test-only watcher overrides set.

    A developer who has exported one in their shell (to run the end-to-end
    suite, say) would otherwise change the timers the unit tests assert on.
    The once-per-process warning is re-armed too, so it can't depend on which
    test ran first.
    """
    for name in testing_overrides.ALL_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    testing_overrides.reset_warning_state()


@pytest.fixture(autouse=True)
def _restore_named_logger_levels() -> Iterator[None]:
    """Put back the levels the logging helpers set on named loggers.

    ``logging_setup`` sets the ``urllib3`` logger's level and the service sets its own
    logger's, and a logger keeps its level for the whole test process, so a later test
    would start from whatever an earlier one left.
    """
    names = ("urllib3", "data_hub_watcher.service")
    levels = {name: logging.getLogger(name).level for name in names}
    yield
    for name, level in levels.items():
        logging.getLogger(name).setLevel(level)


class ScanCounter:
    """Stands in for `os.scandir` in `data_hub_watcher.monitor`: counts the entries read.

    A start-up scan is too quick to stop from outside, so a test runs a function when the scan
    has read its *n*-th entry, which is what a signal that arrives during a long scan is.
    """

    def __init__(self, after: Callable[[], None] | None, n: int) -> None:
        self.after = after
        self.n = n
        self.entries_read = 0

    def __call__(self, path: Any) -> Any:
        return _CountedEntries(os.scandir(path), self)


class _CountedEntries:
    def __init__(self, inner: Any, owner: ScanCounter) -> None:
        self._inner = inner
        self._owner = owner

    def __enter__(self) -> _CountedEntries:
        self._inner.__enter__()
        return self

    def __exit__(self, *exc: Any) -> None:
        self._inner.__exit__(*exc)

    def __iter__(self) -> Iterator[Any]:
        for entry in self._inner:
            owner = self._owner
            owner.entries_read += 1
            if owner.entries_read == owner.n and owner.after is not None:
                owner.after()
            yield entry


@pytest.fixture
def count_scan_entries(
    monkeypatch: pytest.MonkeyPatch,
) -> Callable[..., ScanCounter]:
    """Count the entries the file monitor's scan reads, and run something after the *n*-th.

    Call it as ``count_scan_entries(after=stop.set, n=3)``. It patches `os` in
    `data_hub_watcher.monitor`, which uses only `os.scandir`, until the test ends.
    """

    def install(*, after: Callable[[], None] | None = None, n: int = 3) -> ScanCounter:
        counter = ScanCounter(after, n)
        monkeypatch.setattr(monitor_module, "os", SimpleNamespace(scandir=counter))
        return counter

    return install
