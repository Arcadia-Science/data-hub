"""The ``Transition`` record and the helpers that build catalog entries."""

from __future__ import annotations
import re
from dataclasses import dataclass
from typing import Literal

__all__ = [
    "BOTH",
    "LINUX",
    "WINDOWS",
    "Status",
    "Transition",
    "covered",
    "excluded",
    "xfail_bug",
]

Status = Literal["covered", "xfail_bug", "excluded"]

LINUX = frozenset({"linux"})
WINDOWS = frozenset({"windows"})
BOTH = frozenset({"linux", "windows"})

_ID = re.compile(r"[a-z][a-z0-9_]*\.[a-z0-9_]+->[a-z0-9_]+")


@dataclass(frozen=True)
class Transition:
    """One thing the watcher or the server does that a scenario must show.

    ``id`` reads ``<thing>.<from>-><to>``, for example ``file.pending->stable`` or
    ``service.running->recovery_restart``. ``machine`` is the catalog module it lives in.
    ``platforms`` says where the transition exists: a scenario in a shared test file runs
    on both the CLI driver and the Windows service driver, and one in
    ``test_windows_service.py`` only on the service.

    ``status`` is one of:

    * ``covered``: an end-to-end test shows it works. A test names it with
      ``@pytest.mark.covers("<id>")``.
    * ``xfail_bug``: a known gap. A test asserts the *intended* behavior and is marked
      ``xfail(strict=True)``, so it fails today and starts failing loudly (XPASS) the day
      the bug is fixed, which is when the mark comes off and the status becomes
      ``covered``. ``bug`` is a short slug until a Linear issue exists.
    * ``excluded``: deliberately not tested end to end. ``reason`` says why and where it is
      tested instead. A test must not name it.
    """

    id: str
    machine: str
    description: str
    platforms: frozenset[str]
    status: Status
    bug: str | None = None
    reason: str | None = None

    def __post_init__(self) -> None:
        if _ID.fullmatch(self.id) is None:
            raise ValueError(f"Transition id {self.id!r} must look like 'file.pending->stable'")
        if not self.description.strip():
            raise ValueError(f"{self.id}: a transition needs a description")
        if not self.platforms or not self.platforms <= BOTH:
            raise ValueError(f"{self.id}: platforms must be a non-empty subset of {sorted(BOTH)}")
        if self.status == "xfail_bug" and not self.bug:
            raise ValueError(f"{self.id}: an xfail_bug transition needs a bug slug")
        if self.status != "xfail_bug" and self.bug:
            raise ValueError(f"{self.id}: only an xfail_bug transition has a bug")
        if self.status == "excluded" and not self.reason:
            raise ValueError(f"{self.id}: an excluded transition needs a reason")
        if self.status != "excluded" and self.reason:
            raise ValueError(f"{self.id}: only an excluded transition has a reason")


def covered(
    machine: str, id: str, description: str, *, platforms: frozenset[str] = BOTH
) -> Transition:
    """A transition an end-to-end test shows."""
    return Transition(id, machine, description, platforms, "covered")


def xfail_bug(
    machine: str, id: str, description: str, bug: str, *, platforms: frozenset[str] = BOTH
) -> Transition:
    """A known bug. ``description`` is the intended behavior the test asserts."""
    return Transition(id, machine, description, platforms, "xfail_bug", bug=bug)


def excluded(
    machine: str, id: str, description: str, reason: str, *, platforms: frozenset[str] = BOTH
) -> Transition:
    """A transition left out of the end-to-end suite, with the reason."""
    return Transition(id, machine, description, platforms, "excluded", reason=reason)
