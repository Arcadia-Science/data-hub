"""The server's upload queue: manual mode, "Request upload", give-ups and reverts.

Code: ``uploader.py`` (``poll_upload_queue``, ``_check_queued_files``,
``_upload_queued_file``, ``_settle``, ``_cancel_queued_file``), ``api_client.py``
(``report_upload_failures``), ``constants.py`` (``MAX_QUEUE_FILE_ATTEMPTS``); server side
``app/api/v1/watchers/[watcherId]/upload-failures`` and ``lib/api/upload-failures.ts`` (the
give-ups),
``lib/api/run-uploads.ts`` (request-upload), ``app/api/v1/watchers/[watcherId]/upload-queue``,
``app/api/v1/files/[fileId]`` (the transition table), ``lib/api/watchers.ts`` (the reverts)
and ``app/api/cron/upload-queue-sweep``.
"""

from __future__ import annotations

from e2e_support.catalog.model import CLI, Transition, covered, excluded

MACHINE = "upload_queue"

TRANSITIONS: tuple[Transition, ...] = (
    # --- asking for an upload ---------------------------------------------------------------
    covered(
        MACHINE,
        "queue.manual_mode->files_detected",
        "In manual mode a reported run's files stay `detected`, nothing is uploaded, and "
        "the run's derived status is not uploaded.",
    ),
    covered(
        MACHINE,
        "queue.detected->upload_requested",
        "An admin's request-upload for chosen files makes them `upload_requested` with a "
        "request time, and they show up in the watcher's upload queue.",
    ),
    covered(
        MACHINE,
        "queue.detected->upload_requested_all",
        "Request-upload-all queues every `detected` file of the run.",
    ),
    covered(
        MACHINE,
        "queue.upload_requested->uploaded",
        "The watcher's next queue poll uploads each queued file: it ends `uploaded` with "
        "identical bytes and leaves the queue.",
    ),
    covered(
        MACHINE,
        "queue.batch->parallel_within_budget",
        "When one poll lists several files they are uploaded at the same time (PUTs to "
        "different objects overlap), never more PUTs at once than `upload_parallelism`, and "
        "every file ends `uploaded`.",
    ),
    covered(
        MACHINE,
        "queue.in_flight_and_requested->uploaded_once",
        "A file that is requested while its own automatic upload is still running is not "
        "uploaded a second time: the poll waits for the first upload and finds the file done, "
        "so there is one upload URL request, one set of parts, one completion, no abort, and "
        "no cancellation.",
    ),
    covered(
        MACHINE,
        "queue.auto_mode->requested_file_uploaded",
        "An auto-mode watcher also drains the queue, so a file whose automatic upload gave "
        "up can be requested and uploaded.",
    ),
    covered(
        MACHINE,
        "queue.request->watcher_offline_refused",
        "Request-upload answers 409 `WATCHER_OFFLINE` and queues nothing when the "
        "instrument has no `watching` watcher with a heartbeat under five minutes old.",
    ),
    covered(
        MACHINE,
        "queue.deleted_run->request_refused",
        "Requesting uploads for a deleted run answers 409 and queues nothing.",
    ),
    # --- the queue poll ---------------------------------------------------------------------
    covered(
        MACHINE,
        "queue.poll->failed_first_event",
        "A queue poll that fails counts an error and queues an `upload_queue_poll_failed` "
        "event for the first failure.",
    ),
    covered(
        MACHINE,
        "queue.poll->failed_every_tenth_event",
        "A sustained queue outage queues another `upload_queue_poll_failed` event on every "
        "tenth failed poll and none in between, and a success starts the count again.",
    ),
    covered(
        MACHINE,
        "queue.file->missing_reported_once",
        "A queued file that is not on disk counts one error, on the first poll, queues no "
        "event, and is reported to Data Hub in one `POST /upload-failures`.",
    ),
    covered(
        MACHINE,
        "queue.file->upload_failed_after_three_polls",
        "A queued file still missing after three polls is marked `upload_failed` with reason "
        "`file_missing` (its folder is still there) and leaves the queue. The server writes "
        "the `uploads_failed` event, and the watcher sends no `upload_request_cancelled`.",
    ),
    covered(
        MACHINE,
        "queue.folder_missing->one_report_for_the_run",
        "The requested files of a run whose folder was renamed on the PC are all marked "
        "`upload_failed` with reason `folder_missing` after three polls, in one report, before "
        "a slow upload of another file in the same poll finishes, and the server writes one "
        "`uploads_failed` event for the run.",
    ),
    covered(
        MACHINE,
        "queue.upload_failing->upload_failed_after_three_polls",
        "A queued file whose upload keeps failing is marked `upload_failed` the same way after "
        "three polls, with reason `upload_error` and the last error in its message.",
    ),
    covered(
        MACHINE,
        "queue.report_failed->sent_again",
        "A give-up report that the server fails (a 503) is sent again on the next poll, after "
        "the watcher looks at the file again, and the file is then marked `upload_failed`.",
    ),
    covered(
        MACHINE,
        "queue.old_server->cancelled_after_three_polls",
        "Against a server without the upload-failures route (an HTML 404), a queued file still "
        "missing after three polls is set back to `detected` by the watcher's own "
        "`PATCH /files/:id`, with `upload_request_cancelled`, as before watcher 1.4.5.",
    ),
    covered(
        MACHINE,
        "queue.unreadable_file->stays_queued_until_readable",
        "A queued file that is on disk but can't be opened is not a failed attempt: it stays "
        "requested for more than three polls, with one `upload_failed` event that says it "
        "will be retried, no cancellation and no request to the server, and it uploads on "
        "the poll after it can be read.",
        platforms=CLI,
    ),
    covered(
        MACHINE,
        "queue.upload_failed->requested_again",
        "A file marked `upload_failed` can be requested again after a poll that no longer "
        "lists it, and gets a fresh set of three attempts.",
    ),
    covered(
        MACHINE,
        "queue.upload_failed->requested_before_next_poll",
        "A file that is requested again straight after it was marked `upload_failed`, before "
        "any poll has gone by without it, also gets a fresh set of three attempts: the watcher "
        "tries to upload it. It forgets the three failed attempts once the server has the "
        "report.",
    ),
    covered(
        MACHINE,
        "queue.unsafe_path->rejected",
        "A queue entry whose relative path leaves the watch folder is not read: the watcher "
        "queues `unsafe_upload_path`, counts an error (the only one, with the queue not held), "
        "and has the file marked `upload_failed` with reason `unsafe_path` at once.",
    ),
    # --- the server takes files out of the queue -------------------------------------------
    covered(
        MACHINE,
        "queue.watcher_stopped->reverted",
        "A `stopped` heartbeat sets every `upload_requested` file of the instrument back to "
        "`detected` and records an `upload_requests_cancelled` event.",
    ),
    covered(
        MACHINE,
        "queue.stale_watcher->reverted_by_sweep",
        "The cron sweep reverts queued files, with an `upload_requests_cancelled` event, "
        "once the watcher's last heartbeat is over 15 minutes old.",
    ),
    covered(
        MACHINE,
        "queue.sweep->within_grace_left",
        "The sweep leaves queued files alone while the last heartbeat is under 15 minutes "
        "old, even when the watcher already reads as stale.",
    ),
    covered(
        MACHINE,
        "queue.dismissed->left_queue",
        "Dismissing a detected or queued file soft-deletes it and takes it out of the "
        "queue, so the watcher no longer polls it.",
    ),
    covered(
        MACHINE,
        "queue.uploaded_file->dismiss_refused",
        "A file that is already uploaded cannot be dismissed: the route answers 409.",
    ),
    covered(
        MACHINE,
        "queue.deleted_run_file->not_listed",
        "Deleting a run cancels its requested uploads: its files read `detected` again, are "
        "not listed in the watcher's upload queue, and the instrument's watcher gets an "
        "`upload_requests_cancelled` event.",
    ),
    excluded(
        MACHINE,
        "cli.upload->one_shot_upload",
        "`data-hub-watcher upload` uploads one file, or drains the server's queue once, and exits.",
        "A one-shot command outside the running watcher, covered by test_cli_upload.py and "
        "the integration upload flows.",
    ),
)
