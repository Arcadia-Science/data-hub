"""Deadline polls for the end-to-end tests.

A test never sleeps for a fixed time and hopes. It waits for a condition with
:func:`wait_until`, which returns as soon as the condition holds and, when the deadline
passes, fails with what it last saw. :func:`stays_true` is the opposite check, for "this
must not happen" assertions, where the test has to watch for a while.

:func:`known_bug` is for a test of a known bug, which asserts the intended behavior and is
marked ``xfail(strict=True, raises=KnownBugStillPresent)``.
"""

from __future__ import annotations
import contextlib
import time
from collections.abc import Callable, Iterator
from typing import Literal, TypeVar

__all__ = ["KnownBugStillPresent", "WaitTimeout", "known_bug", "stays_true", "wait_until"]

T = TypeVar("T")

# How often a poll looks again. The conditions are database reads, file stats and log
# greps, which are cheap, and a shorter interval keeps the suite's wall-clock time down.
DEFAULT_INTERVAL_SECONDS = 0.2


class WaitTimeout(AssertionError):
    """A condition did not hold in time. It is an ``AssertionError`` so pytest reports
    it as a failed assertion, not an error in the test."""


class KnownBugStillPresent(AssertionError):
    """The behavior a known-bug test asserts is still missing, which is what the test expects.

    It is raised only by :func:`known_bug`, and it is what the test's ``xfail`` lists in
    ``raises=``. Any other failure (a precondition that broke, a wait that timed out before
    the bug could show) is a different exception, so the test fails instead of looking like
    the bug it is waiting for.
    """


@contextlib.contextmanager
def known_bug() -> Iterator[None]:
    """Mark the one assertion (or wait) of a known-bug test that shows the bug.

    Everything before the ``with`` block is the test's precondition: the watcher is running,
    the server holds what it should, the file was written. If any of that fails the test
    fails, and not as an expected failure. Only the intended-behavior assertion goes inside::

        @pytest.mark.xfail(strict=True, raises=KnownBugStillPresent, reason="bug-07-...: ...")
        @pytest.mark.covers("process.stop->event_before_stopped_heartbeat")
        def test_the_stop_event_reaches_the_server_first(...):
            ...  # precondition
            with known_bug():
                assert event.created_at <= final.created_at

    An ``AssertionError`` raised inside the block, a :class:`WaitTimeout` included, is
    re-raised as :class:`KnownBugStillPresent` with the original as its cause. When the bug
    is fixed the block no longer raises, the strict ``xfail`` turns the pass into a failure,
    and whoever fixed the bug removes the mark and the ``with``. Other exceptions pass
    through unchanged. A test that runs with ``--runxfail`` shows the failure coming from
    this block.
    """
    try:
        yield
    except KnownBugStillPresent:
        raise
    except AssertionError as exc:
        raise KnownBugStillPresent(f"The known bug is still present: {exc}") from exc


def _describe(describe: Callable[[], str] | str | None) -> str:
    if describe is None:
        return ""
    if isinstance(describe, str):
        return describe
    try:
        return describe()
    except Exception as exc:
        return f"(describe() raised {type(exc).__name__}: {exc})"


def wait_until(
    predicate: Callable[[], T | None | Literal[False]],
    timeout: float,
    describe: Callable[[], str] | str | None = None,
    *,
    what: str = "the condition",
    interval: float = DEFAULT_INTERVAL_SECONDS,
) -> T:
    """Call ``predicate`` until it returns something truthy, and return that value.

    A predicate returns ``None`` or ``False`` for "not yet" and the value it found
    otherwise (a row, a list of events, a path), so the caller gets it with its own type.
    An empty list or ``0`` also counts as "not yet".

    The deadline is ``timeout`` seconds. The predicate always runs at least once, and once
    more at the deadline. An exception the predicate raises counts as "not yet" and is
    remembered, so a read that can fail while the server or a file is not ready, or a
    ``def check(): assert ...`` helper, can be polled directly. On timeout this raises
    :class:`WaitTimeout` with ``what``, the last value (or exception) the predicate gave,
    and the text ``describe`` returns, which should show the state a person would look at to
    see why the wait failed (the watcher row, the events, the end of the log). ``describe``
    can be a string or a function; a function runs only on failure.
    """
    deadline = time.monotonic() + timeout
    last: object = None
    last_error: BaseException | None = None
    while True:
        try:
            value = predicate()
        except Exception as exc:
            last_error = exc
            last = None
        else:
            last_error = None
            last = value
            if value:
                return value
        if time.monotonic() >= deadline:
            break
        time.sleep(min(interval, max(0.0, deadline - time.monotonic())))

    seen = (
        f"it raised {type(last_error).__name__}: {last_error}"
        if last_error is not None
        else f"the last value was {last!r}"
    )
    detail = _describe(describe)
    raise WaitTimeout(
        f"Timed out after {timeout:g} s waiting for {what}; {seen}."
        + (f"\n--- state ---\n{detail}" if detail else "")
    )


def stays_true(
    predicate: Callable[[], object],
    duration: float,
    describe: Callable[[], str] | str | None = None,
    *,
    what: str = "the condition",
    interval: float = DEFAULT_INTERVAL_SECONDS,
) -> None:
    """Check that ``predicate`` is truthy now and stays truthy for ``duration`` seconds.

    For "this must not happen" assertions, such as a changed file not being uploaded again:
    ``stays_true(lambda: len(server.files(...)) == 1, 5, what="no second file")``. It fails
    at the first poll where the predicate is falsy or raises. It always watches for the
    whole duration, so use it only where nothing can be waited for instead.
    """
    deadline = time.monotonic() + duration
    while True:
        try:
            value = predicate()
            problem = None if value else f"it returned {value!r}"
        except Exception as exc:
            problem = f"it raised {type(exc).__name__}: {exc}"
        if problem is not None:
            detail = _describe(describe)
            raise WaitTimeout(
                f"{what} stopped holding with {max(0.0, deadline - time.monotonic()):.1f} s "
                f"of {duration:g} s left; {problem}."
                + (f"\n--- state ---\n{detail}" if detail else "")
            )
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        time.sleep(min(interval, remaining))
