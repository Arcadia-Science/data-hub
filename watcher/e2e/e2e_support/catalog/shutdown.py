"""Stopping the watcher: graceful stops, a kill, and the order of what it reports.

Code: ``cli.py`` (``watch``: the signal handlers, ``run_supervisor``),
``runtime.py`` (``stop_runtime``, ``WatcherSupervisor.stop``), ``heartbeat.py``
(``HeartbeatLoop.stop``), ``events.py``. A scenario stops the watcher through the driver
(``stop``, ``interrupt``, ``kill``) and never with a signal of its own.
"""

from __future__ import annotations

from e2e_support.catalog.model import CLI, Transition, covered

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
        "A graceful stop during a long upload cuts it short and exits within the stop limit "
        "(25 seconds). The unfinished file keeps its `pending_uploads` row, being cut off does "
        "not use up one of the file's three starts, and the next start uploads it. (That the "
        "uploader starts no new part or file once the stop is requested is "
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
    covered(
        MACHINE,
        "process.stop->event_before_stopped_heartbeat",
        "On a graceful stop the server receives the `watcher_stopped` event before the "
        "final `stopped` heartbeat: the stop sends the events first and the heartbeat last. "
        "The test keeps the periodic heartbeat from ticking during the stop and compares the "
        "times the server stored.",
    ),
    covered(
        MACHINE,
        "process.stop->no_new_uploads_after_stop",
        "Once a graceful stop is requested, an auto-mode upload starts no new part and no "
        "new file. The stop tells the uploader to stop first, before it waits for the file "
        "monitor, so an upload running on the monitor's own thread stops at once. The test "
        "makes a stop arrive during the first of two short files and asserts that no request "
        "for a part follows it.",
    ),
    covered(
        MACHINE,
        "process.stop->bounded_when_server_hangs",
        "A graceful stop completes within 25 seconds even if the server has stopped "
        "answering. Uploads and a heartbeat in progress get the first 15 seconds, and the "
        "`watcher_stopped` event and the final heartbeat get the last 10, each with an HTTP "
        "timeout cut down to fit its time. Whatever doesn't fit is given up. The test holds "
        "every heartbeat and event request for longer than the client waits and asserts that "
        "the process exits within 30 seconds of the stop request.",
    ),
    covered(
        MACHINE,
        "process.stop->clean_stop_during_scan",
        "CLI only. A graceful stop that arrives while the watcher is still starting (during the "
        "config sync, the first heartbeat or the start-up scan) is not lost: `watch` installs "
        "its signal handlers before it starts the supervisor. They call the supervisor's "
        "`request_stop`, which ends the start-up scan early, so the start returns without "
        "scanning and the watcher then stops with a `stopped` heartbeat and a `watcher_stopped` "
        "event. The test holds up the first heartbeat to keep the process in that window, "
        "because the scan itself is too quick to hit from outside, and checks the log for the "
        "scan that ended early. (A stop in the middle of a long scan is a unit test: "
        "`test_cli_watch_stop.py`.) The Windows service hands its stop to the same call from "
        "before its start; its counterpart is `service.stop->clean_stop_during_start` in "
        "`test_windows_service.py`.",
        platforms=CLI,
    ),
)
