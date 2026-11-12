"""The server's upload queue: manual mode, "Request upload", cancellation and reverts.

Code: ``uploader.py`` (``poll_upload_queue``, ``_process_queued_file``,
``_cancel_queued_file``), ``constants.py`` (``MAX_QUEUE_FILE_ATTEMPTS``); server side
``lib/api/run-uploads.ts`` (request-upload), ``app/api/v1/watchers/[watcherId]/upload-queue``,
``app/api/v1/files/[fileId]`` (the transition table), ``lib/api/watchers.ts`` (the reverts)
and ``app/api/cron/upload-queue-sweep``.
"""

from __future__ import annotations

from e2e_support.catalog.model import Transition, covered, excluded, xfail_bug

MACHINE = "upload_queue"

TRANSITIONS: tuple[Transition, ...] = (
    # --- asking for an upload ---------------------------------------------------------------
    covered(
        MACHINE,
        "queue.manual_mode->files_detected",
        "In manual mode a reported run's files stay `detected`, nothing is uploaded, and "
        "the run's derived status is pending.",
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
        "A queued file that is not on disk queues one `queued_file_missing` event, on the "
        "first poll, and none on later polls.",
    ),
    covered(
        MACHINE,
        "queue.file->cancelled_after_three_polls",
        "A queued file still missing after three polls is set back to `detected` by the "
        "watcher, which queues `upload_request_cancelled` (reason `missing`).",
    ),
    covered(
        MACHINE,
        "queue.upload_failing->cancelled_after_three_polls",
        "A queued file whose upload keeps failing is cancelled the same way after three "
        "polls, with reason `upload_failed`.",
    ),
    covered(
        MACHINE,
        "queue.cancelled->requested_again",
        "A cancelled file can be requested again (once a poll that no longer lists it has "
        "gone by), and gets a fresh set of three attempts.",
    ),
    xfail_bug(
        MACHINE,
        "queue.cancelled->requested_before_next_poll",
        "A file that is requested again straight after its cancellation, before any poll "
        "has gone by without it, also gets a fresh set of three attempts: the watcher tries to "
        "upload it. Today it still remembers the three failures, and cancels the new request "
        "at once with no attempt and no `queued_file_missing` event.",
        "bug-new-cancel-memo-not-cleared",
    ),
    covered(
        MACHINE,
        "queue.unsafe_path->rejected",
        "A queue entry whose relative path leaves the watch folder is not read: the watcher "
        "queues `unsafe_upload_path`, counts an error (the only one, with the queue not held), "
        "and cancels the request at once.",
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
    xfail_bug(
        MACHINE,
        "queue.deleted_run_file->not_listed",
        "A queued file whose run was soft-deleted is not listed in the watcher's upload queue.",
        "bug-04-queue-lists-deleted-run-files",
    ),
    excluded(
        MACHINE,
        "cli.upload->one_shot_upload",
        "`data-hub-watcher upload` uploads one file, or drains the server's queue once, and exits.",
        "A one-shot command outside the running watcher, covered by test_cli_upload.py and "
        "the integration upload flows.",
    ),
)
