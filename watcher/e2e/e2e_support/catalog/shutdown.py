"""Stopping the watcher: graceful stops, a kill, and the order of what it reports.

Code: ``cli.py`` (``watch``: the signal handlers, ``run_supervisor``),
``runtime.py`` (``stop_runtime``, ``WatcherSupervisor.stop``), ``heartbeat.py``
(``HeartbeatLoop.stop``), ``events.py``. A scenario stops the watcher through the driver
(``stop``, ``interrupt``, ``kill``) and never with a signal of its own.
"""

from __future__ import annotations

from e2e_support.catalog.model import LINUX, Transition, covered, xfail_bug

MACHINE = "shutdown"

TRANSITIONS: tuple[Transition, ...] = (
    covered(
        MACHINE,
        "process.stop->clean_exit",
        "A graceful stop (SIGTERM, or the service's stop) ends the watcher with exit code "
        "0 after a final `stopped` heartbeat and a `watcher_stopped` event that says it "
        "was stopped by the user.",
    ),
    covered(
        MACHINE,
        "process.interrupt->clean_exit",
        "Ctrl+C (SIGINT) stops the watcher the same way: exit code 0, a `stopped` heartbeat "
        "and a `watcher_stopped` event.",
        platforms=LINUX,
    ),
    covered(
        MACHINE,
        "process.stop->waiting_mode_clean_exit",
        "Stopping a watcher that is waiting for its folder also sends a `stopped` "
        "heartbeat and a `watcher_stopped` event, and exits with code 0.",
    ),
    covered(
        MACHINE,
        "process.stop->upload_deferred",
        "A graceful stop during a long upload starts no new file or part and exits within "
        "the stop bound, keeps the unfinished file's `pending_uploads` row, and the next "
        "start uploads it.",
    ),
    covered(
        MACHINE,
        "process.kill->stale",
        "A kill sends no `stopped` heartbeat and no `watcher_stopped` event, so the stored "
        "status stays `watching` and the server shows `stale` once the last heartbeat is "
        "five minutes old.",
    ),
    covered(
        MACHINE,
        "process.kill->restart_resumes",
        "Starting again after a kill resumes cleanly: the watcher is `watching` and files "
        "already reported are not reported again.",
    ),
    xfail_bug(
        MACHINE,
        "process.stop->event_before_stopped_heartbeat",
        "On a graceful stop the server receives the `watcher_stopped` event before the "
        "final `stopped` heartbeat.",
        "bug-07-stopped-heartbeat-before-event",
    ),
    xfail_bug(
        MACHINE,
        "process.stop->clean_stop_during_scan",
        "A graceful stop that arrives while the watcher is still starting (the config "
        "sync, the first heartbeat and the startup scan all run before it installs its "
        "signal handlers) still sends a `stopped` heartbeat and a `watcher_stopped` event. "
        "The Windows service already stops cleanly there. The test holds up the first "
        "heartbeat to keep the watcher in that window, because the scan itself is too "
        "quick to hit from outside.",
        "bug-09-sigterm-during-scan",
        platforms=LINUX,
    ),
)
