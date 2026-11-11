"""The watcher updating itself from a package index, and the gates in front of it.

Code: ``updater.py`` (``Updater``: check cadence, idle and quiet-run gates, the install,
the upgrade marker), ``self_update.py`` (``detect_install_method``, ``build_upgrade_command``),
``runtime.py`` (``report_upgrade_outcome``), ``cli.py`` (``self-update``); server side
``app/api/v1/watchers/[watcherId]/update-check`` and the release settings. The suite installs
a built wheel with ``uv tool install`` and points the watcher at a local package index with
``DATA_HUB_WATCHER_INDEX_URL``, with a newer wheel (the patch number plus 1000) as the
release. On Windows the same scenarios go through the upgrade worker (see
``windows_service``); ``self-update`` and the in-process updater share the install command.
"""

from __future__ import annotations

from e2e_support.catalog.model import Transition, covered, excluded

MACHINE = "self_update"

TRANSITIONS: tuple[Transition, ...] = (
    covered(
        MACHINE,
        "selfupdate.current_version->no_update",
        "When the advertised version equals the running one, the periodic update check "
        "installs nothing and queues no update event.",
    ),
    covered(
        MACHINE,
        "selfupdate.no_release->no_update",
        "With no latest version set on the server, the update check does nothing.",
    ),
    covered(
        MACHINE,
        "selfupdate.mandatory->started",
        "A mandatory newer release makes the watcher queue `update_started` and run "
        "`uv tool install --reinstall` against the configured index, without waiting for "
        "the instrument to be idle.",
    ),
    covered(
        MACHINE,
        "selfupdate.installed->exit_for_restart",
        "After a successful install the watcher stops with a `watcher_stopped` event that "
        "says it is restarting for the update, and exits with code 1 for its supervisor to "
        "start it again.",
    ),
    covered(
        MACHINE,
        "selfupdate.restart->succeeded",
        "The restarted process runs the new version: its heartbeats report it, it queues "
        "`update_succeeded` with the previous and target versions, and the upgrade marker "
        "is gone.",
    ),
    covered(
        MACHINE,
        "selfupdate.idle_gate->waits_for_quiet_uploads",
        "A non-mandatory release waits while files were uploaded in recent heartbeat "
        "intervals, and installs only after the required number of quiet ones.",
    ),
    covered(
        MACHINE,
        "selfupdate.run_gate->waits_for_quiet_runs",
        "A non-mandatory release waits while a run was reported within five times the "
        "stability period.",
    ),
    covered(
        MACHINE,
        "selfupdate.idle_window->installs",
        "With the instrument quiet, a non-mandatory release is installed and the watcher "
        "restarts as for a mandatory one.",
    ),
    covered(
        MACHINE,
        "selfupdate.install_failed->update_failed",
        "When the install command fails (the index has no such version), the watcher "
        "queues `update_failed` with the exit code and the error tail, keeps running on the "
        "old version, and clears the upgrade marker.",
    ),
    covered(
        MACHINE,
        "selfupdate.uv_missing->update_failed",
        "When `uv` cannot be found, the watcher queues `update_failed` (`uv executable not "
        "found`) instead of `update_started`, and keeps running.",
    ),
    covered(
        MACHINE,
        "selfupdate.check_failed->update_check_failed",
        "Three failed update checks in a row queue one `update_check_failed` event.",
    ),
    covered(
        MACHINE,
        "selfupdate.below_floor->recovers_by_update",
        "A watcher below `min_supported_version`, whose heartbeats get 426, installs the "
        "mandatory release and then heartbeats normally again.",
    ),
    covered(
        MACHINE,
        "selfupdate.mandatory->rollback_installed",
        "A mandatory release that names an older version than the running one installs "
        "that older version, which is how a bad release is rolled back.",
    ),
    covered(
        MACHINE,
        "selfupdate.cli_check->reports",
        "`self-update --check` prints the running and the advertised version and whether it "
        "would upgrade, and installs nothing.",
    ),
    covered(
        MACHINE,
        "selfupdate.cli_install->installed",
        "`self-update` installs the advertised version from the configured index and tells "
        "the operator to restart the watcher.",
    ),
    excluded(
        MACHINE,
        "selfupdate.editable_install->refused",
        "A watcher installed editable, or from an unknown source, refuses to update and "
        "queues one `update_failed` per target version.",
        "The suite always installs with `uv tool install`; test_updater.py and "
        "test_self_update.py cover the other install methods.",
    ),
    excluded(
        MACHINE,
        "selfupdate.preview->disabled",
        "The `preview` environment never updates itself.",
        "Covered by the updater unit tests; the guard must stay in updater.py.",
    ),
)
