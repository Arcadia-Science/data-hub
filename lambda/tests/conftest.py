"""Shared fixtures for the Lambda unit tests."""

from __future__ import annotations
from collections.abc import Iterator

import pytest

from data_hub_lambda.config import lambda_config
from data_hub_lambda.deadline import clear_deadline
from data_hub_shared.config import config


def _reset() -> None:
    clear_deadline()
    config.__init__()  # type: ignore[misc]
    lambda_config.__init__()  # type: ignore[misc]


@pytest.fixture(autouse=True)
def _reset_processing_state() -> Iterator[None]:
    """The deadline and both configs are module globals, so one test can leak into the next."""
    _reset()
    yield
    _reset()
