"""Top-level conftest for the watcher test suite.

Integration-specific fixtures (server start-up, DB resets, DataHubClient)
live in ``integration/conftest.py``. This file is intentionally minimal —
add shared unit-test fixtures here as needed.
"""

from __future__ import annotations
import logging
from collections.abc import Iterator

import pytest

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
