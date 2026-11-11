"""The Windows service: install, the SCM's recovery actions, the upgrade worker, uninstall.

These transitions exist only on Windows and are covered only by ``test_windows_service.py``.
The shared scenario files run under the service as well, through the driver.

Code: ``service.py`` (``install_service``, ``_run_service_loop``, the bootstrap log),
``scheduled_task.py``, ``upgrade_worker.py``, ``logging_setup.py``, and the ``service``
group in ``cli.py``. The suite starts the service for real, so it needs an elevated shell.
"""

from __future__ import annotations

from e2e_support.catalog.model import WINDOWS, Transition, covered, excluded, xfail_bug

MACHINE = "windows_service"

TRANSITIONS: tuple[Transition, ...] = (
    # --- install ----------------------------------------------------------------------------
    covered(
        MACHINE,
        "service.not_installed->installed",
        "`service install` registers the DataHubWatcher service with automatic start, "
        "creates the ProgramData log folder, and writes the upgrade worker script and its "
        "scheduled task.",
        platforms=WINDOWS,
    ),
    covered(
        MACHINE,
        "service.install->registry_paths",
        "`ConfigPath` and `EnvPath` under the service's registry key hold the config file "
        "and env file the service will load.",
        platforms=WINDOWS,
    ),
    covered(
        MACHINE,
        "service.install->recovery_actions",
        "`sc qfailure` shows restart after 60 s, restart after 120 s, then no action, with "
        "the actions-on-non-crash-failures flag set.",
        platforms=WINDOWS,
    ),
    covered(
        MACHINE,
        "service.install->delayed_start_and_dependencies",
        "The service is set to delayed automatic start and depends on Tcpip and Dnscache.",
        platforms=WINDOWS,
    ),
    # --- running ----------------------------------------------------------------------------
    covered(
        MACHINE,
        "service.installed->running",
        "`service start` takes the service to `running`: the server sees `watching` and a "
        "`watcher_started` event that says the service started.",
        platforms=WINDOWS,
    ),
    covered(
        MACHINE,
        "service.running->stopped",
        "`service stop` ends the service gracefully with a `stopped` heartbeat and a "
        "`watcher_stopped` event, and the SCM does not restart it.",
        platforms=WINDOWS,
    ),
    covered(
        MACHINE,
        "service.stopped->running_again",
        "A stopped service starts again and resumes without reporting its files twice.",
        platforms=WINDOWS,
    ),
    covered(
        MACHINE,
        "service.running->recovery_restart",
        "Killing the service process makes the SCM restart it after 60 seconds.",
        platforms=WINDOWS,
    ),
    covered(
        MACHINE,
        "service.running->logs_written",
        "The service writes watcher.log in ProgramData and to the Windows Event Log.",
        platforms=WINDOWS,
    ),
    covered(
        MACHINE,
        "service.running->state_in_config_dir",
        "The state database and the upgrade sentinels live in the directory of the "
        "registered config file, not in the LocalSystem profile.",
        platforms=WINDOWS,
    ),
    covered(
        MACHINE,
        "service.env_file->overrides_applied",
        "Test overrides written to the registered env file take effect once the service has "
        "restarted.",
        platforms=WINDOWS,
    ),
    xfail_bug(
        MACHINE,
        "service.env_file->log_level_honored",
        "`DATA_HUB_WATCHER_LOG_LEVEL` in the registered env file sets the service's log "
        "level, as it does for `watch`.",
        "bug-10-service-ignores-log-level",
        platforms=WINDOWS,
    ),
    covered(
        MACHINE,
        "service.config_revision->applied_without_restart",
        "A config revision from the web app is applied inside the running service without "
        "the process exiting.",
        platforms=WINDOWS,
    ),
    covered(
        MACHINE,
        "service.missing_folder->waits_without_restart_loop",
        "A missing watch folder makes the service wait with `waiting` heartbeats instead of "
        "exiting, so the SCM does not restart it in a loop.",
        platforms=WINDOWS,
    ),
    covered(
        MACHINE,
        "file.locked->pending_until_released",
        "A file held open with exclusive sharing by a writer stays pending, and is "
        "reported and uploaded once the writer closes it.",
        platforms=WINDOWS,
    ),
    # --- start-up failures and the SCM's recovery -------------------------------------------
    covered(
        MACHINE,
        "service.registry_unreadable->recovery_restart",
        "A service whose registry values cannot be read exits with code 1 and the SCM "
        "restarts it after 60 s, and it runs once the values are back.",
        platforms=WINDOWS,
    ),
    covered(
        MACHINE,
        "service.no_api_url->recovery_restart",
        "A config with no API URL for its environment makes the service exit with code 1, "
        "and the SCM restarts it after 60 s.",
        platforms=WINDOWS,
    ),
    covered(
        MACHINE,
        "service.api_unreachable->recovery_restart",
        "An unreachable API at start makes the service exit with code 1, the SCM restarts "
        "it after 60 s, and it runs once the API is back.",
        platforms=WINDOWS,
    ),
    covered(
        MACHINE,
        "service.instrument_pending->recovery_restart",
        "A pending instrument makes the service exit with code 1, the SCM restarts it after "
        "60 s, and it runs once the instrument is activated.",
        platforms=WINDOWS,
    ),
    covered(
        MACHINE,
        "service.no_watcher_id->recovery_restart",
        "A config with no watcher id makes the service exit with code 1, and the SCM "
        "restarts it after 60 s.",
        platforms=WINDOWS,
    ),
    covered(
        MACHINE,
        "service.failures->stays_stopped_after_two",
        "A third failure inside the failure-count window leaves the service stopped, with "
        "no further restart.",
        platforms=WINDOWS,
    ),
    covered(
        MACHINE,
        "service.broken_install->bootstrap_log",
        "A service whose interpreter cannot start the service module writes the traceback "
        "to service-bootstrap.log in ProgramData.",
        platforms=WINDOWS,
    ),
    # --- the upgrade worker -----------------------------------------------------------------
    covered(
        MACHINE,
        "service.upgrade_task->repaired_after_deletion",
        "If the scheduled task is deleted but the worker script remains, the next service "
        "start registers the task again.",
        platforms=WINDOWS,
    ),
    covered(
        MACHINE,
        "service.upgrade_task->repair_impossible_warned",
        "If both the task and the worker script are missing, the service logs that "
        "`service reinstall` is needed and keeps running.",
        platforms=WINDOWS,
    ),
    covered(
        MACHINE,
        "service.upgrade->worker_mandatory_installs",
        "A mandatory release is dispatched to the worker (`update_started` with "
        "`via_worker`), which stops the service, runs uv and starts the service again, and "
        "the new version queues `update_succeeded`.",
        platforms=WINDOWS,
    ),
    covered(
        MACHINE,
        "service.upgrade->worker_idle_gated",
        "A non-mandatory release is dispatched to the worker only once the idle window has passed.",
        platforms=WINDOWS,
    ),
    covered(
        MACHINE,
        "service.upgrade->worker_failure_reported",
        "When uv fails inside the worker, the service that comes back on the old version "
        "queues `update_failed` with the worker's error text.",
        platforms=WINDOWS,
    ),
    # --- reinstall and uninstall ------------------------------------------------------------
    covered(
        MACHINE,
        "service.reinstall->service_replaced",
        "`service reinstall` stops, removes, installs and starts the service in one command.",
        platforms=WINDOWS,
    ),
    covered(
        MACHINE,
        "service.uninstall->cleaned_up",
        "`service uninstall` removes the service, its registry values and its scheduled "
        "task, and leaves the logs.",
        platforms=WINDOWS,
    ),
    # --- left out ---------------------------------------------------------------------------
    excluded(
        MACHINE,
        "service.failure_count->reset_after_24h",
        "The SCM forgets earlier failures after 24 hours of healthy running.",
        "Waiting a day is not possible. The reset period is asserted in "
        "`service.install->recovery_actions`, not exercised.",
        platforms=WINDOWS,
    ),
    excluded(
        MACHINE,
        "service.boot->delayed_start_runs",
        "The delayed automatic start runs the service after the network is up at boot.",
        "It needs a reboot. The delayed-start flag and the dependencies are asserted in "
        "`service.install->delayed_start_and_dependencies`.",
        platforms=WINDOWS,
    ),
    excluded(
        MACHINE,
        "service.env_switch->envpath_rewritten",
        "An environment switch rewrites the service's registered EnvPath.",
        "Environment switching is left to unit tests (test_cli_set_environment.py and "
        "test_service.py).",
        platforms=WINDOWS,
    ),
)
