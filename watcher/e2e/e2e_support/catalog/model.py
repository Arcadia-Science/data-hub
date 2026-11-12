"""The ``Transition`` record and the helpers that build catalog entries."""

from __future__ import annotations
import re
from dataclasses import dataclass
from typing import Literal

__all__ = [
    "BOTH",
    "CLI",
    "DRIVER_KINDS",
    "SERVICE",
    "DriverKind",
    "Status",
    "Transition",
    "covered",
    "excluded",
    "xfail_bug",
]

Status = Literal["covered", "xfail_bug", "excluded"]

# The platforms of a transition are the *kinds of driver* a scenario can run under, because
# that is what decides whether a transition exists for a test. ``"cli"`` is a
# ``data-hub-watcher watch`` process (on Linux, and on macOS for a developer), ``"service"``
# is the real Windows service. Names that say "Linux" or "Windows" would be wrong the day the
# CLI driver runs on Windows too.
DriverKind = Literal["cli", "service"]
DRIVER_KINDS: tuple[DriverKind, ...] = ("cli", "service")

CLI = frozenset({"cli"})
SERVICE = frozenset({"service"})
BOTH = frozenset(DRIVER_KINDS)

_ID = re.compile(r"[a-z][a-z0-9_]*\.[a-z0-9_]+->[a-z0-9_]+")


@dataclass(frozen=True)
class Transition:
    """One thing the watcher or the server does that a scenario must show.

    ``id`` reads ``<thing>.<from>-><to>``, for example ``file.pending->stable`` or
    ``service.running->recovery_restart``. ``machine`` is the catalog module it lives in.
    ``platforms`` says under which kinds of driver the transition exists (``"cli"``,
    ``"service"``, see :data:`DriverKind`). A test claims it for the kinds it runs under: a
    test in a shared file runs under both unless it carries ``@pytest.mark.platforms("cli")``
    (or ``"service"``), and one in ``test_windows_service.py`` runs only under the service.

    ``status`` is one of:

    * ``covered``: an end-to-end test shows it works. A test names it with
      ``@pytest.mark.covers("<id>")``.
    * ``xfail_bug``: a known gap. A test asserts the *intended* behavior, wraps only that
      assertion in ``known_bug()`` and is marked ``xfail(strict=True,
      raises=KnownBugStillPresent, reason="<bug>: ...")``, so it fails today and starts
      failing loudly (XPASS) the day the bug is fixed, which is when the mark and the
      ``known_bug()`` block come off and the status becomes ``covered``. A broken
      precondition raises something else, so it fails the test instead of hiding as an
      expected failure. ``bug`` is the Linear issue (``ENG-2116``), or a short slug until the
      issue is filed, and the ``reason`` of the test starts with it.
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
            raise ValueError(
                f"{self.id}: an xfail_bug transition needs a bug: its Linear issue "
                "(such as ENG-2116) or a short slug"
            )
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
