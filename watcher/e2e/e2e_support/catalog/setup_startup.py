"""Setting a watcher up (``init``) and starting it (``watch``), including the waiting state.

Code: ``cli.py`` (``init``, ``watch``), ``runtime.py`` (``WatcherSupervisor.start``, the
waiting state), ``models.py`` (``watch_directory_problem``).
"""

from __future__ import annotations

from e2e_support.catalog.model import LINUX, Transition, covered, excluded, xfail_bug

MACHINE = "setup_startup"

TRANSITIONS: tuple[Transition, ...] = (
    # --- init -----------------------------------------------------------------------------
    covered(
        MACHINE,
        "init.prompts->config_saved",
        "The real `init --show-key` wizard registers the watcher, saves config.yaml and the "
        "API key file, and pushes the config to the server.",
    ),
    covered(
        MACHINE,
        "init.existing_config->overwrite_declined",
        "Answering no to the overwrite question ends `init` with exit code 0 and leaves "
        "config.yaml as it was.",
    ),
    covered(
        MACHINE,
        "init.malformed_key->refused",
        "A key that does not start with `dhub_` is refused before any request is made, and "
        "nothing is saved.",
    ),
    covered(
        MACHINE,
        "init.rejected_key->not_saved",
        "A key the server rejects ends `init` with an error, writes no config, and "
        "registers no watcher.",
    ),
    covered(
        MACHINE,
        "init.new_instrument->registered",
        "Choosing to register a new instrument creates it as `pending` on the server and "
        "then registers the watcher for it.",
    ),
    covered(
        MACHINE,
        "init.instrument_taken->refused",
        "`init` for an instrument that already has an active watcher fails with the "
        "existing watcher's id and the deregister hint, and saves no config.",
    ),
    covered(
        MACHINE,
        "init.missing_watch_directory->refused",
        "A watch directory that does not exist is refused by `init`, so a typo is heard at the PC.",
    ),
    # --- watch: start-up checks -------------------------------------------------------------
    covered(
        MACHINE,
        "startup.stopped->watching",
        "`watch` checks the instrument, syncs the config, opens the state database, sends "
        "its first heartbeat as `watching` and queues `watcher_started`.",
    ),
    covered(
        MACHINE,
        "startup.dry_run->validated",
        "`watch --dry-run` validates the config, checks the API and the instrument, lists "
        "what it would scan, and exits 0 without starting any loop or sending a heartbeat.",
    ),
    covered(
        MACHINE,
        "startup.config_invalid->refused",
        "`watch` exits non-zero with the validation errors for a missing, malformed or "
        "invalid config.yaml, before it sends any request.",
    ),
    covered(
        MACHINE,
        "startup.watcher_id_missing->refused",
        "A config with no watcher id for its environment makes `watch` exit and say to run "
        "`init` first.",
    ),
    covered(
        MACHINE,
        "startup.api_unreachable->refused",
        "`watch` exits non-zero with `Cannot reach API` when its first request to the "
        "server fails.",
    ),
    covered(
        MACHINE,
        "startup.api_key_rejected->refused",
        "`watch` exits non-zero when the server answers its first request with 401 because "
        "the API key is wrong or revoked.",
    ),
    covered(
        MACHINE,
        "startup.instrument_pending->refused",
        "`watch` exits non-zero and says to wait for activation while the instrument is `pending`.",
    ),
    covered(
        MACHINE,
        "startup.instrument_pending->activated_starts",
        "Once an admin activates the pending instrument, `watch` starts and the watcher "
        "becomes `watching`.",
    ),
    covered(
        MACHINE,
        "startup.instrument_inactive->watching",
        "A retired (`inactive`) instrument does not stop `watch` from starting: only "
        "`pending` does.",
    ),
    # --- the waiting state ------------------------------------------------------------------
    covered(
        MACHINE,
        "startup.watching->waiting_folder_missing",
        "A missing watch folder puts the watcher in `waiting`: heartbeats say `waiting` with "
        "a `watch_directory not found` reason, and `watcher_started` and "
        "`watch_directory_unavailable` events are queued.",
    ),
    covered(
        MACHINE,
        "startup.watching->waiting_folder_unreadable",
        "A watch folder that exists but cannot be listed also starts the watcher in "
        "`waiting`, with a `not readable` reason (a POSIX permission, as root can list "
        "anything).",
        platforms=LINUX,
    ),
    covered(
        MACHINE,
        "waiting.folder_created->resumed",
        "Creating the missing folder lets the waiting watcher start watching on its next "
        "heartbeat tick, with a `watcher_started` event that says it resumed and a "
        "`watching` heartbeat.",
    ),
    covered(
        MACHINE,
        "waiting.reason->changed",
        "When the problem with the folder changes while waiting (a file replaces it), the "
        "reason is updated and one new `watch_directory_unavailable` event is queued, "
        "without a second `watcher_started`.",
    ),
    covered(
        MACHINE,
        "waiting.start_failure->backoff_retry",
        "When the folder exists but starting to watch fails (start waiting, hold "
        "`driver.lock_state_db()`, then create the folder), the watcher waits with a "
        "`could not start watching` reason, retries after 1, 2, 4 and 8 heartbeat "
        "intervals, and queues events only when the reason changes.",
    ),
    xfail_bug(
        MACHINE,
        "waiting.folder_vanished->waiting_then_resumed",
        "When the watch folder disappears while the watcher runs, it moves to `waiting` "
        "with a reason, and starts watching again when the folder returns.",
        "bug-01-folder-vanishes",
    ),
    # --- left to unit tests -----------------------------------------------------------------
    excluded(
        MACHINE,
        "environment.switch->active_environment_changed",
        "`config set-environment` and the environment switch inside `config edit` move the "
        "PC to another deployment.",
        "Environment switching is left to unit tests (test_cli_set_environment.py and "
        "test_preview_environment.py). That includes rewriting the Windows service's "
        "EnvPath.",
    ),
    excluded(
        MACHINE,
        "cli.config_commands->files_edited",
        "`config show`, `validate`, `edit`, `open` and `path` read and rewrite config.yaml "
        "on the PC.",
        "Offline commands that edit a file, covered by test_cli_config.py.",
    ),
    excluded(
        MACHINE,
        "cli.state_forget->rows_removed",
        "`state forget --prefix` deletes the state-database rows of a folder so the next "
        "start reports it again.",
        "An offline command on a SQLite file, covered by test_state_forget.py.",
    ),
)
