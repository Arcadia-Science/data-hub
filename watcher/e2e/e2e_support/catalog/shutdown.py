"""Stopping the watcher: graceful stops, a kill, and the order of what it reports.

Code: ``cli.py`` (``watch``: the signal handlers, ``run_supervisor``),
``runtime.py`` (``stop_runtime``, ``WatcherSupervisor.stop``), ``heartbeat.py``
(``HeartbeatLoop.stop``), ``events.py``. A scenario stops the watcher through the driver
(``stop``, ``interrupt``, ``kill``) and never with a signal of its own.
"""

from __future__ import annotations

from e2e_support.catalog.model import CLI, Transition, covered, xfail_bug

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
        platforms=CLI,
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
        "A graceful stop during a long upload cuts it short and exits within the stop bound. "
        "The unfinished file keeps its `pending_uploads` row, being cut off does not use up "
        "one of the file's three starts, and the next start uploads it. (How soon the "
        "uploader stops starting new parts and files is "
        "`process.stop->no_new_uploads_after_stop`.)",
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
        "ENG-2116",
    ),
    xfail_bug(
        MACHINE,
        "process.stop->no_new_uploads_after_stop",
        "Once a graceful stop is requested, an auto-mode upload starts no new part and no "
        "new file. `stop_runtime` joins the file monitor for up to 5 seconds before it "
        "stops the upload worker, and the worker's stop is what sets the uploader's stop "
        "signal, so an upload running on the monitor's own thread keeps starting parts, "
        "and a following file, for about 5 seconds after the stop. (The in-process rebuild "
        "for a config revision stops the worker first.) The test makes a stop arrive during "
        "the first of two short files and asserts that no request for a part follows it.",
        "ENG-2126",
    ),
    xfail_bug(
        MACHINE,
        "process.stop->bounded_when_server_hangs",
        "PROPOSED — confirm intent: a graceful stop completes within about 30 seconds even "
        "when the server has stopped answering. Today a stop waits for the heartbeat thread "
        "(whose request is stuck for the client's 30 s read timeout), sends the final "
        "`stopped` heartbeat and flushes the events, each of which can wait for the same "
        "timeout again, and the join of the thread allows 65 s, so a stop against a hung "
        "server took up to about 95 s. For the Windows service that is worse than slow: "
        "pywin32 reports a wait hint of 5 s that nothing updates, the SCM doesn't kill a "
        "manual stop that is slow, and `service reinstall` gives up waiting for the "
        "service after 30 s. The test holds every heartbeat and event request for longer "
        "than the client waits, asks for a stop and expects the process to be gone within "
        "30 s.",
        "ENG-2127",
    ),
    xfail_bug(
        MACHINE,
        "process.stop->clean_stop_during_scan",
        "CLI only. A graceful stop that arrives while the watcher is still starting (the "
        "config sync, the first heartbeat and the startup scan all run before `watch` "
        "installs its signal handlers) still sends a `stopped` heartbeat and a "
        "`watcher_stopped` event. The test holds up the first heartbeat to keep the process "
        "in that window, because the scan itself is too quick to hit from outside. The "
        "Windows service has no such window: `SvcStop` sets an event that its loop reads "
        "when the start has finished, so the stop is not lost. The service counterpart is "
        "`service.stop->clean_stop_during_start` in `test_windows_service.py`.",
        "ENG-2118",
        platforms=CLI,
    ),
)
