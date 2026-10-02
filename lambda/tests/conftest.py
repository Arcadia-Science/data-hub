"""Shared fixtures for the Lambda unit tests."""

from __future__ import annotations
from collections.abc import Iterator

import pytest

from data_hub_lambda.deadline import clear_deadline
from data_hub_shared.config import config


@pytest.fixture(autouse=True)
def _reset_processing_state() -> Iterator[None]:
    """The deadline and `config` are module globals, so one test can leak into the next."""
    clear_deadline()
    config.__init__()  # type: ignore[misc]
    yield
    clear_deadline()
    config.__init__()  # type: ignore[misc]
