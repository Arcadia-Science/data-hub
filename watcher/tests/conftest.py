"""Top-level conftest for the watcher test suite.

Integration-specific fixtures (server start-up, DB resets, DataHubClient)
live in ``integration/conftest.py``. This file is intentionally minimal —
add shared unit-test fixtures here as needed.
"""

from __future__ import annotations

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
