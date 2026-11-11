"""Event reporting, and every event type and error kind the suite must see at least once.

Code: ``events.py`` (``EventReporter``: bounded queue, flush with retry, ``events_dropped``);
server side ``app/api/v1/watchers/[watcherId]/events``. The ``event.*`` transitions are the
"every event is emitted somewhere in the suite" rule made checkable. A test that causes
an event names its ``event.*`` ID in ``covers`` next to the transition it is really about, so
most of these are covered by the scenario that produces the event, and a few get a small test
of their own in ``test_events.py``. The description says where the event comes from.
"""

from __future__ import annotations

from e2e_support.catalog.model import Transition, covered, excluded, xfail_bug

MACHINE = "events"

TRANSITIONS: tuple[Transition, ...] = (
    # --- the reporter -----------------------------------------------------------------------
    covered(
        MACHINE,
        "reporter.queue->flushed_on_heartbeat",
        "Events the watcher queues are sent in a batch on each heartbeat tick, and the "
        "server stores them in the order they happened.",
    ),
    covered(
        MACHINE,
        "reporter.flush->failed_batch_dropped",
        "A flush that fails all three attempts (503 on the events route) drops that batch "
        "and the watcher keeps running.",
    ),
    covered(
        MACHINE,
        "reporter.dropped->reported_after_recovery",
        "The next successful flush starts with an `events_dropped` event that says how many "
        "events were dropped and since when.",
    ),
    xfail_bug(
        MACHINE,
        "reporter.queued->persisted_across_kill",
        "Events queued but not yet sent when the watcher is killed are kept in the state "
        "database and sent after the restart.",
        "bug-11-events-lost-on-kill",
    ),
    excluded(
        MACHINE,
        "reporter.queue->overflow_dropped_oldest",
        "A queue past 500 events drops the oldest first and reports the gap as `events_dropped`.",
        "Reaching 500 queued events end to end takes hundreds of files; test_events.py "
        "covers the bound and the order.",
    ),
    # --- event types the watcher sends ------------------------------------------------------
    covered(
        MACHINE,
        "event.watcher_started->emitted",
        "`watcher_started` is stored when the watcher starts, and again with a `resumed` "
        "message when a waiting watcher starts watching. Every start scenario shows it.",
    ),
    covered(
        MACHINE,
        "event.watcher_stopped->emitted",
        "`watcher_stopped` is stored when the watcher stops, with a message that tells a "
        "stop by the operator from a restart for an update. Every stop scenario shows it.",
    ),
    covered(
        MACHINE,
        "event.run_reported->emitted",
        "`run_reported` is stored when a run is first sent to the server.",
    ),
    covered(
        MACHINE,
        "event.file_uploaded->emitted",
        "`file_uploaded` is stored for each uploaded file, with `s3_key`, `sha256`, "
        "`size_bytes`, `prep_seconds`, `upload_seconds` and `part_count`.",
    ),
    covered(
        MACHINE,
        "event.upload_failed->emitted",
        "`upload_failed` is stored when an upload gives up, with the S3 error text and the key.",
    ),
    covered(
        MACHINE,
        "event.config_synced->emitted",
        "`config_synced` is stored when the watcher pushes its config, with the `trigger` "
        "(`startup`, `init`, `config_revision`).",
    ),
    covered(
        MACHINE,
        "event.update_started->emitted",
        "`update_started` is stored when the updater begins an install, with the current "
        "and target versions and whether the release is mandatory.",
    ),
    covered(
        MACHINE,
        "event.update_succeeded->emitted",
        "`update_succeeded` is stored by the process that restarted into the new version.",
    ),
    covered(
        MACHINE,
        "event.update_failed->emitted",
        "`update_failed` is stored when an install fails, `uv` is missing, or the restart "
        "did not load the target version.",
    ),
    # --- error kinds the watcher sends ------------------------------------------------------
    covered(
        MACHINE,
        "event.run_report_failed->emitted",
        "An `error` event of kind `run_report_failed` is stored when a run POST or PATCH "
        "fails, with the operation, status code and file count.",
    ),
    covered(
        MACHINE,
        "event.config_sync_failed->emitted",
        "An `error` event of kind `config_sync_failed` is stored when the startup checksum "
        "check or config push fails.",
    ),
    covered(
        MACHINE,
        "event.stability_timeout->emitted",
        "An `error` event of kind `stability_timeout` is stored for a file that never "
        "stopped changing, with the path and the wait that was allowed.",
    ),
    covered(
        MACHINE,
        "event.stable_callback_failed->emitted",
        "An `error` event of kind `stable_callback_failed` is stored when handling a stable "
        "file raises, for example a file that vanishes between its run report and its "
        "upload.",
    ),
    covered(
        MACHINE,
        "event.pattern_mismatch->emitted",
        "An `error` event of kind `pattern_mismatch` is stored for a file the run-detection "
        "pattern does not match, with its relative path.",
    ),
    covered(
        MACHINE,
        "event.events_dropped->emitted",
        "An `error` event of kind `events_dropped` is stored after dropped batches, with "
        "`dropped_count` and `since`.",
    ),
    covered(
        MACHINE,
        "event.heartbeat_recovered->emitted",
        "An `error` event of kind `heartbeat_recovered` is stored after an outage, with "
        "`consecutive_failures` and `gap_seconds`.",
    ),
    covered(
        MACHINE,
        "event.upload_queue_poll_failed->emitted",
        "An `error` event of kind `upload_queue_poll_failed` is stored for a failed queue "
        "poll, with `consecutive_failures`.",
    ),
    covered(
        MACHINE,
        "event.update_check_failed->emitted",
        "An `error` event of kind `update_check_failed` is stored after three failed update "
        "checks in a row.",
    ),
    covered(
        MACHINE,
        "event.queued_file_missing->emitted",
        "An `error` event of kind `queued_file_missing` is stored for a queued file that is "
        "not on disk, with its `file_id` and expected path.",
    ),
    covered(
        MACHINE,
        "event.upload_request_cancelled->emitted",
        "An `error` event of kind `upload_request_cancelled` is stored when the watcher "
        "gives up on a queued file, with `file_id`, `attempts` and `reason`.",
    ),
    covered(
        MACHINE,
        "event.upload_retries_exhausted->emitted",
        "An `error` event of kind `upload_retries_exhausted` is stored when a pending "
        "upload fails on its third start, with `relative_path`, `run_id` and `attempts`.",
    ),
    covered(
        MACHINE,
        "event.pending_upload_missing->emitted",
        "An `error` event of kind `pending_upload_missing` is stored for a pending upload "
        "whose file is gone, with `relative_path` and `run_id`.",
    ),
    covered(
        MACHINE,
        "event.watch_directory_unavailable->emitted",
        "An `error` event of kind `watch_directory_unavailable` is stored when the watcher "
        "starts waiting or the waiting reason changes, with the folder and the reason.",
    ),
    covered(
        MACHINE,
        "event.unsafe_upload_path->emitted",
        "An `error` event of kind `unsafe_upload_path` is stored for a queue entry whose "
        "path leaves the watch folder, with `file_id` and `relative_path`.",
    ),
    # --- events the server writes itself ----------------------------------------------------
    covered(
        MACHINE,
        "event.config_revision_applied->recorded",
        "The server stores a `config_synced` event of kind `config_revision_applied` when "
        "the watcher reports a revision as applied.",
    ),
    covered(
        MACHINE,
        "event.config_revision_rejected->recorded",
        "The server stores an `error` event of kind `config_revision_rejected`, with the "
        "reason, when the watcher reports a revision as rejected.",
    ),
    covered(
        MACHINE,
        "event.upload_requests_cancelled->recorded",
        "The server stores an event of kind `upload_requests_cancelled`, with the reason "
        "and the count, whenever it reverts an instrument's queued uploads.",
    ),
    excluded(
        MACHINE,
        "notification.slack->sent",
        "Slack and in-app notifications about runs and files.",
        "Slack is outside the end-to-end boundary and is covered by the web tests.",
    ),
)
