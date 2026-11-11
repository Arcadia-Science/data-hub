"""The transition catalog: every state change of the watcher the end-to-end suite must show.

The watcher and the server endpoints it calls are made of small state machines: a file goes
from new to pending to stable, a run is reported, an upload is queued, requested, uploaded
or cancelled, a watcher goes from registered to watching to stale. The catalog lists each
transition once, with a stable ID such as ``file.pending->stable``, in one module per
machine. A test claims what it shows with ``@pytest.mark.covers("file.pending->stable")``.

``watcher/tests/test_e2e_catalog.py`` runs in the normal unit-test run (no server) and fails
when:

* a test names an ID that is not in the catalog,
* a transition that is not ``excluded`` has no test,
* an ``xfail_bug`` transition has no ``xfail(strict=True)`` test, or a ``covered`` one has
  only xfail tests,
* an ``excluded`` transition has a test.

So adding behavior to the catalog without a test, or deleting a test, fails the PR.

One module per machine, so scenario authors don't edit the same file:

=====================  ========================  ====================================
module                 test file                 covers
=====================  ========================  ====================================
``setup_startup``      ``test_setup_startup``    ``init``, start-up checks, waiting
``detection``          ``test_detection``        files, runs, the initial scan
``upload_auto``        ``test_upload_auto``      uploads in auto mode, crash retry
``upload_queue``       ``test_upload_queue``     manual mode, request-upload, reverts
``heartbeat_status``   ``test_heartbeat_status`` heartbeats and the status shown
``events``             ``test_events``           the reporter and every event kind
``registration_tokens`` ``test_registration_tokens`` registration, tokens, deregistration
``config_sync``        ``test_config_sync``      config push, revisions, rebuilds
``shutdown``           ``test_shutdown``         graceful stops, kill, ordering
``self_update``        ``test_self_update``      updating from a package index
``windows_service``    ``test_windows_service``  the Windows service (PR 3)
=====================  ========================  ====================================

A test may name transitions from any module: the scenario that makes an event happen also
names its ``event.*`` ID. An owner may change a status in its own module when the work
shows the first guess was wrong (for example moving a transition to ``excluded``), with a
reason.
"""

from __future__ import annotations

from e2e_support.catalog import (
    config_sync,
    detection,
    events,
    heartbeat_status,
    registration_tokens,
    self_update,
    setup_startup,
    shutdown,
    upload_auto,
    upload_queue,
    windows_service,
)
from e2e_support.catalog.model import (
    BOTH,
    LINUX,
    WINDOWS,
    Status,
    Transition,
    covered,
    excluded,
    xfail_bug,
)

__all__ = [
    "ALL_TRANSITIONS",
    "BOTH",
    "BY_ID",
    "LINUX",
    "MACHINES",
    "WINDOWS",
    "WINDOWS_SUITE_READY",
    "WINDOWS_TEST_FILE",
    "Status",
    "Transition",
    "covered",
    "excluded",
    "get",
    "transitions_for",
    "xfail_bug",
]

# Until the Windows suite lands (PR 3), the transitions that exist only on Windows can't have
# a test, so the catalog check does not ask for one. PR 3 flips this to True, and from then on
# `test_windows_service.py` must cover every one of them.
WINDOWS_SUITE_READY = False

# The one test file whose tests run only under the Windows service. Every other test file
# runs under both drivers.
WINDOWS_TEST_FILE = "test_windows_service.py"

_MODULES = (
    setup_startup,
    detection,
    upload_auto,
    upload_queue,
    heartbeat_status,
    events,
    registration_tokens,
    config_sync,
    shutdown,
    self_update,
    windows_service,
)

MACHINES: tuple[str, ...] = tuple(module.MACHINE for module in _MODULES)


def _collect() -> tuple[Transition, ...]:
    collected: list[Transition] = []
    seen: dict[str, str] = {}
    for module in _MODULES:
        for transition in module.TRANSITIONS:
            if transition.machine != module.MACHINE:
                raise ValueError(
                    f"{transition.id} says machine {transition.machine!r} but lives in "
                    f"{module.__name__}"
                )
            if transition.id in seen:
                raise ValueError(
                    f"Transition id {transition.id!r} is in both {seen[transition.id]} "
                    f"and {module.__name__}"
                )
            seen[transition.id] = module.__name__
            collected.append(transition)
    return tuple(collected)


ALL_TRANSITIONS: tuple[Transition, ...] = _collect()
BY_ID: dict[str, Transition] = {t.id: t for t in ALL_TRANSITIONS}


def get(transition_id: str) -> Transition:
    """The transition with this ID. Raises ``KeyError`` for an unknown ID."""
    return BY_ID[transition_id]


def transitions_for(machine: str) -> tuple[Transition, ...]:
    """The transitions of one machine (``"detection"``, ``"shutdown"``, ...)."""
    if machine not in MACHINES:
        raise KeyError(f"Unknown machine {machine!r}; use one of {MACHINES}")
    return tuple(t for t in ALL_TRANSITIONS if t.machine == machine)
