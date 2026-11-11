"""The Windows service: install, the SCM's recovery actions, the upgrade worker, uninstall.

These transitions exist only on Windows and are covered only by ``test_windows_service.py``.
The shared scenario files run under the service as well, through the driver.

Code: ``service.py`` (``install_service``, ``_run_service_loop``, the bootstrap log),
``scheduled_task.py``, ``upgrade_worker.py``, ``logging_setup.py``, and the ``service``
group in ``cli.py``. The suite starts the service for real, so it needs an elevated shell.
"""

from __future__ import annotations

from e2e_support.catalog.model import SERVICE, Transition, covered, excluded, xfail_bug

MACHINE = "windows_service"

TRANSITIONS: tuple[Transition, ...] = (
    # --- install ----------------------------------------------------------------------------
    covered(
        MACHINE,
        "service.not_installed->installed",
        "`service install` registers the DataHubWatcher service with automatic start, as "
        "LocalSystem, and writes the upgrade worker script and its scheduled task. (It "
        "creates the ProgramData log folder when that is missing; the test doesn't claim "
        "that, because the folder is there already on a machine that has run the service.)",
        platforms=SERVICE,
    ),
    covered(
        MACHINE,
        "service.install->registry_paths",
        "`ConfigPath` and `EnvPath` under the service's registry key hold the config file "
        "and env file the service will load.",
        platforms=SERVICE,
    ),
    covered(
        MACHINE,
        "service.install->recovery_actions",
        "`sc qfailure` shows restart after 60 s and restart after 120 s, with the "
        "actions-on-non-crash-failures flag set, and the failure actions in the registry "
        "end with a third entry that does nothing (`sc qfailure` prints no line for it).",
        platforms=SERVICE,
    ),
    covered(
        MACHINE,
        "service.install->delayed_start_and_dependencies",
        "The service is set to delayed automatic start and depends on Tcpip and Dnscache.",
        platforms=SERVICE,
    ),
    # --- running ----------------------------------------------------------------------------
    covered(
        MACHINE,
        "service.installed->running",
        "`service start` takes the service to `running`: the server sees `watching` and a "
        "`watcher_started` event that says the service started.",
        platforms=SERVICE,
    ),
    covered(
        MACHINE,
        "service.running->stopped",
        "`service stop` ends the service gracefully with a `stopped` heartbeat and a "
        "`watcher_stopped` event, and the SCM does not restart it.",
        platforms=SERVICE,
    ),
    covered(
        MACHINE,
        "service.stop->clean_stop_during_start",
        "A `service stop` that arrives while the service is still starting (its first "
        "heartbeat is held up) is not lost: when the start has finished the service stops "
        "cleanly, with a `stopped` heartbeat and a `watcher_stopped` event. (The CLI has "
        "this window and loses the stop, which is `process.stop->clean_stop_during_scan`.)",
        platforms=SERVICE,
    ),
    covered(
        MACHINE,
        "service.stopped->running_again",
        "A stopped service starts again and resumes without reporting its files twice.",
        platforms=SERVICE,
    ),
    covered(
        MACHINE,
        "service.running->recovery_restart",
        "Killing the service process makes the SCM restart it after 60 seconds.",
        platforms=SERVICE,
    ),
    covered(
        MACHINE,
        "service.running->logs_written",
        "The service writes watcher.log in ProgramData and to the Windows Event Log.",
        platforms=SERVICE,
    ),
    covered(
        MACHINE,
        "service.running->state_in_config_dir",
        "The state database and the upgrade sentinels live in the directory of the "
        "registered config file, not in the LocalSystem profile. The state database is "
        "asserted here, and the sentinels (the in-progress marker, the request and the "
        "result) in `service.upgrade->worker_mandatory_installs`.",
        platforms=SERVICE,
    ),
    covered(
        MACHINE,
        "service.env_file->overrides_applied",
        "Test overrides written to the registered env file take effect once the service has "
        "restarted.",
        platforms=SERVICE,
    ),
    xfail_bug(
        MACHINE,
        "service.env_file->log_level_honored",
        "`DATA_HUB_WATCHER_LOG_LEVEL` in the registered env file sets the service's log "
        "level, as it does for `watch`.",
        "bug-10-service-ignores-log-level",
        platforms=SERVICE,
    ),
    covered(
        MACHINE,
        "service.config_revision->applied_without_restart",
        "A config revision from the web app is applied inside the running service without "
        "the process exiting.",
        platforms=SERVICE,
    ),
    covered(
        MACHINE,
        "service.missing_folder->waits_without_restart_loop",
        "A missing watch folder makes the service wait with `waiting` heartbeats instead of "
        "exiting, so the SCM does not restart it in a loop.",
        platforms=SERVICE,
    ),
    covered(
        MACHINE,
        "file.locked->pending_until_released",
        "A file held open with exclusive sharing by a writer stays pending, and is "
        "reported and uploaded once the writer closes it.",
        platforms=SERVICE,
    ),
    xfail_bug(
        MACHINE,
        "file.locked->uploaded_after_release",
        "PROPOSED — confirm intent: a file that an instrument keeps open with exclusive "
        "sharing after its last write is uploaded once the instrument releases it, without "
        "a restart of the watcher. Today the file counts as stable after the stability "
        "period (stability reads only the size and the modification time, which stopped "
        "changing), then reading it for the upload hits a sharing violation, and the file "
        "is tried again only at the next start. The test uses `ExclusiveWriter`, which "
        "writes once and holds the file past the stability period.",
        "bug-new-locked-file-not-retried",
        platforms=SERVICE,
    ),
    xfail_bug(
        MACHINE,
        "service.system_shutdown->clean_stop",
        "PROPOSED — confirm intent: the service accepts a system shutdown "
        "(`SERVICE_ACCEPT_SHUTDOWN`, which pywin32 sets when the class has a "
        "`SvcShutdown`), so a reboot stops it as `service stop` does, with a `stopped` "
        "heartbeat and a `watcher_stopped` event. Today the class has none, `sc queryex` "
        "lists IGNORES_SHUTDOWN, and every reboot kills the service with no `stopped` "
        "heartbeat. The test reads the controls `sc queryex` lists: a test can't send a "
        "shutdown to a service.",
        "bug-new-service-ignores-shutdown",
        platforms=SERVICE,
    ),
    # --- start-up failures and the SCM's recovery -------------------------------------------
    covered(
        MACHINE,
        "service.registry_unreadable->failure_exit",
        "A service whose registry values cannot be read logs why and stops with a failure "
        "exit code (a non-zero one, which the SCM's recovery treats as a failure). The "
        "recovery is off in this test: a start-up refusal ends in the same `SystemExit(1)` "
        "whatever its cause, and `service.api_unreachable->recovery_restart` waits for the "
        "restart of that exit once.",
        platforms=SERVICE,
    ),
    covered(
        MACHINE,
        "service.no_api_url->failure_exit",
        "A config with no API URL for its environment is logged, and the service stops with "
        "a failure exit code. As for `service.registry_unreadable->failure_exit`, the "
        "recovery is off here.",
        platforms=SERVICE,
    ),
    covered(
        MACHINE,
        "service.api_unreachable->recovery_restart",
        "An unreachable API at start makes the service stop with a failure exit code (the "
        "win32 code 1066 with the service-specific code 0x20000001, which is what pywin32 "
        "reports for a `SystemExit(1)`), the SCM restarts it after 60 s, and it runs once "
        "the API is back. It is the one start-up refusal whose restart is waited for.",
        platforms=SERVICE,
    ),
    covered(
        MACHINE,
        "service.instrument_pending->failure_exit",
        "A pending instrument is logged, and the service stops with a failure exit code. "
        "The recovery is off here, as for `service.registry_unreadable->failure_exit`.",
        platforms=SERVICE,
    ),
    covered(
        MACHINE,
        "service.no_watcher_id->failure_exit",
        "A config with no watcher id is logged, and the service stops with a failure exit "
        "code. The recovery is off here, as for `service.registry_unreadable->failure_exit`.",
        platforms=SERVICE,
    ),
    covered(
        MACHINE,
        "service.failures->stays_stopped_after_two",
        "A crash (a kill) is the first failure and two refused starts after it are the "
        "second and third, so a crash and a `SystemExit(1)` count as failures of one "
        "service: the restarts come after 60 s and 120 s, and after the third failure the "
        "service stays stopped, because the failure actions end with an entry that does "
        "nothing (read from the registry: waiting for a restart that doesn't come would "
        "take longer than the 120 s of the second one).",
        platforms=SERVICE,
    ),
    xfail_bug(
        MACHINE,
        "service.config_invalid->logged_in_watcher_log",
        "PROPOSED — confirm intent: a config that doesn't load (missing, malformed, "
        "invalid) is logged in `watcher.log` and ends the service through the "
        "`SystemExit(1)` path, like the other start-up refusals. Today `_run_service_loop` "
        "calls `load_config` outside any `try`, so the `ClickException` is raised out of "
        "`SvcRun`: pywin32 still stops the service with the same failure code, but nothing "
        "reaches `watcher.log`, only the Event Log (a traceback in a `SvcRun() method "
        "failed` entry, which the driver copies into the log text). The shared "
        "`startup.config_invalid->refused` is covered under the service as well, because it "
        "reads that text.",
        "bug-new-service-config-error-not-logged",
        platforms=SERVICE,
    ),
    covered(
        MACHINE,
        "service.broken_install->bootstrap_log",
        "A service whose interpreter cannot start the service module writes the traceback "
        "to service-bootstrap.log in ProgramData.",
        platforms=SERVICE,
    ),
    # --- the upgrade worker -----------------------------------------------------------------
    covered(
        MACHINE,
        "service.upgrade_task->repaired_after_deletion",
        "If the scheduled task is deleted but the worker script remains, the next service "
        "start registers the task again.",
        platforms=SERVICE,
    ),
    covered(
        MACHINE,
        "service.upgrade_task->repair_impossible_warned",
        "If both the task and the worker script are missing, the service logs that "
        "`service reinstall` is needed and keeps running.",
        platforms=SERVICE,
    ),
    covered(
        MACHINE,
        "service.upgrade->worker_mandatory_installs",
        "A mandatory release is dispatched to the worker (`update_started` with "
        "`via_worker`), which stops the service, runs uv and starts the service again, and "
        "the new version queues `update_succeeded`.",
        platforms=SERVICE,
    ),
    covered(
        MACHINE,
        "service.upgrade->worker_idle_gated",
        "A non-mandatory release is dispatched to the worker only once the idle window has passed.",
        platforms=SERVICE,
    ),
    covered(
        MACHINE,
        "service.upgrade->worker_failure_reported",
        "When uv fails inside the worker, the service that comes back on the old version "
        "queues `update_failed` with the worker's error text.",
        platforms=SERVICE,
    ),
    xfail_bug(
        MACHINE,
        "service.upgrade->worker_dispatch_once",
        "One upgrade is dispatched to the worker once: the server sees one `update_started` "
        "for it. `_apply_via_worker` doesn't set `_upgrade_in_progress`, as the in-process "
        "path does, so with a check on every heartbeat the next tick can dispatch it again "
        "before the worker has stopped the service (it queues another event, and writes the "
        "request and triggers the task again). The test checks on every heartbeat (1 s) and "
        "holds one heartbeat while the worker stops the service, so that a tick is still "
        "running when the stop arrives and makes its check after it. The scenarios of the "
        "upgrade itself compare the events with a repeat counted once.",
        "bug-new-worker-dispatch-repeats",
        platforms=SERVICE,
    ),
    xfail_bug(
        MACHINE,
        "service.deregistered->stays_stopped",
        "PROPOSED — confirm intent: a running service that finds out its watcher was "
        "deregistered stops itself cleanly, exiting 0, which the SCM treats as a clean stop "
        "(a failure exit would make its recovery actions restart a watcher that can never "
        "recover), and it stays stopped. (It is the service side of "
        "`watcher.deregistered->process_exits`, which exits non-zero under `watch`; today "
        "the service keeps running with 404s.)",
        "bug-08-deregistered-watcher-keeps-running",
        platforms=SERVICE,
    ),
    # --- reinstall and uninstall ------------------------------------------------------------
    covered(
        MACHINE,
        "service.reinstall->service_replaced",
        "`service reinstall` stops, removes, installs and starts the service in one command.",
        platforms=SERVICE,
    ),
    covered(
        MACHINE,
        "service.uninstall->cleaned_up",
        "`service uninstall` removes the service, its registry values and its scheduled "
        "task, and leaves the logs.",
        platforms=SERVICE,
    ),
    # --- left out ---------------------------------------------------------------------------
    excluded(
        MACHINE,
        "service.failure_count->reset_after_24h",
        "The SCM forgets earlier failures after 24 hours of healthy running.",
        "Waiting a day is not possible. The reset period is asserted in "
        "`service.install->recovery_actions`, not exercised.",
        platforms=SERVICE,
    ),
    excluded(
        MACHINE,
        "service.boot->delayed_start_runs",
        "The delayed automatic start runs the service after the network is up at boot.",
        "It needs a reboot. The delayed-start flag and the dependencies are asserted in "
        "`service.install->delayed_start_and_dependencies`.",
        platforms=SERVICE,
    ),
    excluded(
        MACHINE,
        "service.env_switch->envpath_rewritten",
        "An environment switch rewrites the service's registered EnvPath.",
        "Environment switching is left to unit tests (test_cli_set_environment.py and "
        "test_service.py).",
        platforms=SERVICE,
    ),
)
