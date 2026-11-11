"""From a file appearing in the watch folder to a run reported to the server.

Code: ``monitor.py`` (``FileMonitor``: pattern filter, stability check, initial scan),
``run_detector.py`` (``RunDetector``: run ID, POST/PATCH, retry, hydration), ``state.py``
(the ``detected_files``, ``uploaded_files`` and ``baseline_files`` tables); server side
``app/api/v1/instruments/[instrumentId]/runs`` and ``lib/api/run-file-identity.ts``.
"""

from __future__ import annotations

from e2e_support.catalog.model import Transition, covered, xfail_bug

MACHINE = "detection"

TRANSITIONS: tuple[Transition, ...] = (
    # --- a file in the watch folder -----------------------------------------------------------
    covered(
        MACHINE,
        "file.new->pending",
        "A new file whose name matches `file_patterns` joins the list of files waiting to "
        "become stable, whether a filesystem event or the initial scan found it.",
    ),
    covered(
        MACHINE,
        "file.new->ignored_pattern",
        "A file whose name matches none of `file_patterns` is ignored: no run, no file row "
        "and no event.",
    ),
    covered(
        MACHINE,
        "file.pending->pending_growing",
        "A file that is still being written keeps resetting its stability clock, stays "
        "pending, and is not reported while it grows.",
    ),
    covered(
        MACHINE,
        "file.pending->stable",
        "A file whose size and modification time stay unchanged for "
        "`stability_period_seconds` becomes stable and goes to run detection.",
    ),
    covered(
        MACHINE,
        "file.pending->abandoned_timeout",
        "A file that keeps changing past `max_stability_wait_seconds` is dropped with a "
        "`stability_timeout` error event and no run.",
    ),
    covered(
        MACHINE,
        "file.pending->vanished",
        "A file deleted while it is still pending is dropped without an event and without a run.",
    ),
    covered(
        MACHINE,
        "file.stable->pattern_mismatch",
        "A stable file whose path does not match the run-detection pattern gets a "
        "`pattern_mismatch` error event and no run.",
    ),
    covered(
        MACHINE,
        "file.pattern_mismatch->throttled_per_folder",
        "A second mismatch in the same parent folder queues no new event, while a mismatch "
        "in another folder does.",
    ),
    covered(
        MACHINE,
        "monitor.recursive->subfolders_watched",
        "With `recursive` on, files in subfolders are detected and reported.",
    ),
    covered(
        MACHINE,
        "monitor.non_recursive->subfolders_ignored",
        "With `recursive` off, files in subfolders are not detected, while files directly "
        "in the watch folder are.",
    ),
    covered(
        MACHINE,
        "file.reported->delete_ignored",
        "Deleting a file after its run was reported changes nothing on the server and "
        "starts nothing: deletes are ignored by design.",
    ),
    covered(
        MACHINE,
        "file.reported->rename_ignored",
        "Renaming a reported file inside the watch folder is not noticed while the watcher "
        "runs: renames are ignored by design.",
    ),
    covered(
        MACHINE,
        "file.reported->change_not_reuploaded",
        "A reported file that is modified later is neither reported nor uploaded again, "
        "while the watcher runs or after a restart: instrument output is write-once.",
    ),
    # --- a run on the server ----------------------------------------------------------------
    covered(
        MACHINE,
        "run.first_file->reported",
        "The first stable file of a run ID makes the watcher POST the run, with its detected "
        "files, and queue a `run_reported` event.",
    ),
    covered(
        MACHINE,
        "run.multi_file->grouped",
        "Several files with the same run ID reach the server as one run that holds every file.",
    ),
    covered(
        MACHINE,
        "run.known->file_added",
        "A file that becomes stable in a run that is already reported goes out in a PATCH "
        "that carries only that file.",
    ),
    covered(
        MACHINE,
        "run.report->retried_after_server_error",
        "A run report that fails with a 5xx or a dropped connection is retried in the "
        "process with a growing delay and succeeds once the server is back, with a single "
        "`run_report_failed` event for the run.",
    ),
    covered(
        MACHINE,
        "run.update->rejected_not_retried",
        "A run update that the server refuses with a 4xx (the run was deleted) queues a "
        "`run_report_failed` event with the status code, and is not retried.",
    ),
    covered(
        MACHINE,
        "run.restored->updates_accepted",
        "After an admin restores a deleted run, the next file of that run is reported "
        "again, with the update the earlier refusal left behind.",
    ),
    xfail_bug(
        MACHINE,
        "run.deleted->rereport_conflict",
        "Reporting a run that an admin soft-deleted is refused with a 409, as updating it "
        "is, and attaches no files to it.",
        "bug-05-rereport-deleted-run-attaches-files",
    ),
    xfail_bug(
        MACHINE,
        "file.dismissed_path->redetected",
        "A new file at a path whose earlier file was dismissed (a different size or "
        "modification time) appears on the server as `detected`.",
        "bug-06-dismissed-path-blocks-new-file",
    ),
    # --- the initial scan and restarts ------------------------------------------------------
    covered(
        MACHINE,
        "scan.full->existing_files_reported",
        "With `initial_scan: full`, files already in the folder at the first start are "
        "reported (and uploaded in auto mode) like new ones.",
    ),
    covered(
        MACHINE,
        "scan.new_only->baseline_seeded",
        "With `initial_scan: new-only`, the files present at the first start become a "
        "baseline and are never reported, while files written afterwards are.",
    ),
    covered(
        MACHINE,
        "scan.new_only->baseline_not_repeated",
        "A later start of a `new-only` watcher does not baseline again, so files that "
        "arrived while it was stopped are reported.",
    ),
    covered(
        MACHINE,
        "scan.restart->reported_files_skipped",
        "After a restart, files whose path, size and modification time match the state "
        "database are not reported or uploaded again.",
    ),
    covered(
        MACHINE,
        "scan.restart->offline_files_reported",
        "Files that arrived while the watcher was stopped, or that the server never "
        "accepted, are reported by the next start's initial scan.",
    ),
    covered(
        MACHINE,
        "scan.restart->runs_hydrated",
        "After a restart, a new file in a run that was already reported is sent as a PATCH "
        "of that run, not as a second POST.",
    ),
)
