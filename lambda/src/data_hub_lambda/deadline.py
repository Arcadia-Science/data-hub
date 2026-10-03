"""Stop a long step before the Lambda runtime kills the invocation."""

from __future__ import annotations
import time

# Leave time to mark the file failed after the check fires.
DEADLINE_MARGIN_MS = 60_000

_deadline_monotonic: float | None = None


class ProcessingDeadlineError(Exception):
    """Continuing would run into the Lambda time limit."""


def set_deadline_from_remaining_ms(remaining_ms: int) -> None:
    """Remember when this invocation should stop starting new work."""
    global _deadline_monotonic
    _deadline_monotonic = time.monotonic() + max(0, remaining_ms - DEADLINE_MARGIN_MS) / 1000


def clear_deadline() -> None:
    """Forget any deadline. Local runs and tests use this."""
    global _deadline_monotonic
    _deadline_monotonic = None


def check_deadline(step: str) -> None:
    """Raise when *step* would start after the saved deadline.

    No deadline means the caller is not inside a Lambda invocation, so
    the check does nothing.
    """
    if _deadline_monotonic is None:
        return
    if time.monotonic() >= _deadline_monotonic:
        raise ProcessingDeadlineError(
            f"Stopped before the time limit during {step}. "
            "The raw file is stored and can be downloaded."
        )


def record_invocation_deadline(context: object) -> None:
    """Read the Lambda context, or clear the deadline when it has none."""
    getter = getattr(context, "get_remaining_time_in_millis", None)
    if not callable(getter):
        clear_deadline()
        return
    try:
        remaining = getter()
    except Exception:
        clear_deadline()
        return
    if isinstance(remaining, bool) or not isinstance(remaining, int):
        clear_deadline()
        return
    set_deadline_from_remaining_ms(remaining)
