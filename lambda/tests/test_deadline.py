"""`record_invocation_deadline` reads the Lambda context or clears the deadline."""

from __future__ import annotations
from types import SimpleNamespace
from typing import Any

import pytest

from data_hub_lambda.deadline import (
    DEADLINE_MARGIN_MS,
    ProcessingDeadlineError,
    check_deadline,
    clear_deadline,
    record_invocation_deadline,
    seconds_until_time_limit,
    set_deadline_from_remaining_ms,
)


def _context(remaining: Any) -> SimpleNamespace:
    return SimpleNamespace(get_remaining_time_in_millis=lambda: remaining)


def _raise() -> int:
    raise RuntimeError("no clock")


def test_a_context_with_no_time_left_stops_the_next_step() -> None:
    record_invocation_deadline(_context(DEADLINE_MARGIN_MS))

    with pytest.raises(ProcessingDeadlineError, match="during parsing"):
        check_deadline("parsing")


def test_a_context_with_time_left_lets_the_step_run() -> None:
    record_invocation_deadline(_context(DEADLINE_MARGIN_MS + 600_000))

    check_deadline("parsing")


@pytest.mark.parametrize(
    "context",
    [
        object(),
        SimpleNamespace(get_remaining_time_in_millis=5),
        SimpleNamespace(get_remaining_time_in_millis=_raise),
        _context("900000"),
        _context(None),
        _context(True),
    ],
    ids=["no-getter", "not-callable", "getter-raises", "string", "none", "bool"],
)
def test_an_unusable_context_clears_an_earlier_deadline(context: object) -> None:
    set_deadline_from_remaining_ms(0)

    record_invocation_deadline(context)

    check_deadline("parsing")


def test_no_deadline_means_no_time_limit() -> None:
    assert seconds_until_time_limit() is None


def test_the_time_limit_is_all_the_remaining_time() -> None:
    record_invocation_deadline(_context(300_000))

    left = seconds_until_time_limit()

    assert left is not None
    assert 299 < left <= 300


def test_the_time_limit_is_still_ahead_after_the_deadline_has_passed() -> None:
    # `check_deadline` stops at once, and the runtime limit is 30 s away.
    record_invocation_deadline(_context(30_000))

    with pytest.raises(ProcessingDeadlineError):
        check_deadline("parsing")
    left = seconds_until_time_limit()

    assert left is not None
    assert 29 < left <= 30


def test_clearing_the_deadline_clears_the_time_limit() -> None:
    record_invocation_deadline(_context(300_000))

    clear_deadline()

    assert seconds_until_time_limit() is None


def test_an_unusable_context_clears_the_time_limit() -> None:
    set_deadline_from_remaining_ms(300_000)

    record_invocation_deadline(object())

    assert seconds_until_time_limit() is None
