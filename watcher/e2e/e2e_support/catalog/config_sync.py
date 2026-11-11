"""Keeping the PC's config.yaml and the server's copy in step: pushes, revisions and rebuilds.

Code: ``runtime.py`` (``WatcherSupervisor``: startup sync, ``apply_config_revision``, the
in-process rebuild), ``remote_config.py``, ``state.py`` (the ``meta`` bookkeeping); server
side ``app/api/v1/watchers/[watcherId]/config``, ``config-revisions`` and
``lib/api/watcher-config``. Admin changes need a token that lists ``watchers:admin``.
"""

from __future__ import annotations

from e2e_support.catalog.model import Transition, covered, excluded

MACHINE = "config_sync"

TRANSITIONS: tuple[Transition, ...] = (
    # --- the push at start ------------------------------------------------------------------
    covered(
        MACHINE,
        "config.startup->pushed",
        "At start the watcher pushes config.yaml when its checksum differs from the "
        "server's and queues `config_synced` (trigger `startup`); the server stores the "
        "YAML and a first `pc` revision.",
    ),
    covered(
        MACHINE,
        "config.startup->push_skipped",
        "A restart with an unchanged config.yaml sends no push and queues no "
        "`config_synced` event.",
    ),
    covered(
        MACHINE,
        "config.startup->push_failed",
        "When the checksum check or the push fails, the watcher queues `config_sync_failed` "
        "and still starts watching.",
    ),
    covered(
        MACHINE,
        "config.offline_edit->pushed_as_pc_revision",
        "A change made to config.yaml while the watcher was stopped is pushed at the next "
        "start as a new `pc` revision, based on the revision the watcher had applied.",
    ),
    covered(
        MACHINE,
        "config.offline_conflict->web_change_wins",
        "When the PC's offline edit is older than a pending web change, the web change "
        "stays pending and the watcher applies it, and the PC's edit is kept as a "
        "`superseded` revision.",
    ),
    covered(
        MACHINE,
        "config.offline_conflict->pc_edit_wins",
        "When the PC's offline edit is newer than a pending web change, the edit wins and "
        "the web revision becomes `superseded`.",
    ),
    covered(
        MACHINE,
        "config.running_edit->ignored_until_restart",
        "Editing config.yaml while the watcher runs changes nothing until the next start, "
        "which pushes the edit as a `pc` revision.",
    ),
    # --- revisions from the web app ---------------------------------------------------------
    covered(
        MACHINE,
        "config.revision->editable_after_first_heartbeat",
        "The server refuses a config revision for a watcher whose version it does not know "
        "(registered, no heartbeat yet) or that is too old to support revisions, and "
        "accepts one once the watcher's first heartbeat has reported its version.",
    ),
    covered(
        MACHINE,
        "config.revision->applied",
        "An admin's revision reaches the watcher in a heartbeat reply, is checked and "
        "written to config.yaml, takes effect by rebuilding the runtime in the same "
        "process, is reported `applied` and pushed back, and shows up as the applied "
        "revision in the next heartbeat.",
    ),
    covered(
        MACHINE,
        "config.revision->applied_at_start",
        "A revision saved while the watcher was stopped is applied at the next start, "
        "before the monitor starts.",
    ),
    covered(
        MACHINE,
        "config.revision->applied_while_waiting",
        "A revision that fixes the watch folder takes a waiting watcher out of `waiting` "
        "without a restart.",
    ),
    covered(
        MACHINE,
        "config.revision->rejected_missing_folder",
        "A revision whose folder is missing on the PC is rejected with a reason, the "
        "server stores `config_revision_rejected`, and the watcher keeps running with its "
        "old config and does not fetch that revision again.",
    ),
    covered(
        MACHINE,
        "config.revision->no_rebuild_when_unchanged",
        "A revision equal to the running settings is recorded as applied without a rebuild: "
        "no new `watcher_started` event and the same process.",
    ),
    covered(
        MACHINE,
        "config.revision->no_rebuild_file_rewritten",
        "A revision equal to the running settings, while config.yaml on the PC holds an "
        "edit the watcher has not loaded (it reads the file only at start), saves the "
        "running settings over the file, so the edit does not come back at the next "
        "restart. The watcher records the revision as applied, reports the result, and "
        "pushes the rewritten file, with no rebuild. (A push that finds the server's copy "
        "already equal to the file is skipped, so the test starts from a server that has "
        "none, after a first push that failed.)",
    ),
    covered(
        MACHINE,
        "config.revision->rejected_foreign_config_file",
        "A revision that would change the settings is rejected, with a reason, when "
        "config.yaml on the PC now names another environment, watcher or instrument than "
        "the one running (as after `config set-environment`, which asks for a restart). "
        "The file is not overwritten, the watcher keeps running with its old config, and "
        "the server stores `config_revision_rejected`.",
    ),
    covered(
        MACHINE,
        "config.revision->settled_by_push",
        "When the result of an applied revision is lost, the push of the new config.yaml "
        "that follows (it names the revision it is based on) settles it on the server: the "
        "revision becomes `applied` without a new `pc` revision, and the result sent "
        "later changes nothing.",
    ),
    covered(
        MACHINE,
        "config.revision->result_retried",
        "A revision result the server did not receive is kept and sent after the next "
        "successful heartbeat, or first thing at the next start if the watcher was "
        "restarted in between.",
    ),
    covered(
        MACHINE,
        "config.folder_change->pending_uploads_cleared",
        "A revision that changes `watch_directory` drops the watcher's `pending_uploads` "
        "rows, which point into the old folder.",
    ),
    covered(
        MACHINE,
        "config.folder_change->queue_reverted",
        "The same change makes the server revert the instrument's queued uploads to "
        "`detected`, with an `upload_requests_cancelled` event.",
    ),
    covered(
        MACHINE,
        "config.folder_change->queue_drained_when_push_fails",
        "The server reverts the queued uploads of a folder change only in the push of the "
        "new config.yaml. When that push fails (`config_sync_failed`), the queue is not "
        "reverted by it: the new runtime's queue poll finds the queued files missing from "
        "the new folder, reports `queued_file_missing`, and cancels each after three polls "
        "(`upload_request_cancelled`), which sends it back to `detected`. So the queue "
        "still drains without anyone's help, a few polls later.",
    ),
    covered(
        MACHINE,
        "config.rebuild_same_folder->pending_uploads_kept",
        "A revision that leaves `watch_directory` alone rebuilds the runtime without "
        "dropping the watcher's `pending_uploads` rows: the new runtime retries them, and "
        "the upload finishes. (Only a folder change drops them: "
        "`config.folder_change->pending_uploads_cleared`.)",
    ),
    covered(
        MACHINE,
        "config.scope_widened->report_only_scan",
        "A revision that widens what matches (a new file pattern) reports files already on "
        "disk that only the new config matches as `detected` without uploading them, even "
        "in auto mode, while files written later follow `upload_mode`.",
    ),
    excluded(
        MACHINE,
        "config.rebuild->rolled_back_on_failure",
        "If the new runtime fails to start after the old loops stopped, the watcher writes "
        "the previous config.yaml back, starts the old config and rejects the revision.",
        "It needs a fault inside the process after the teardown; test_config_revisions.py "
        "in watcher/tests covers it with a stubbed start.",
    ),
)
