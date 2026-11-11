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
        "config.revision->result_retried",
        "A revision result the server did not receive is kept and sent after the next "
        "successful heartbeat, including after a restart.",
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
