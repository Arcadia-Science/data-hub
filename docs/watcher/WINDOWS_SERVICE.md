# Watcher: Windows Service

Prerequisite reading: [ARCHITECTURE.md](../ARCHITECTURE.md), [CLI.md](./CLI.md).

Maps to `service.py` in the watcher module structure. All `service` subcommands are gated behind a platform check and exit with a clear error on non-Windows systems.

Running the watcher as a Windows Service ensures it starts automatically on boot, survives user logouts, recovers from crashes via the Windows Service Control Manager, and requires no open terminal window.

## `data-hub watcher service install`

Installs the watcher as a Windows Service named `DataHubWatcher`.

- Validates that a config file exists and passes validation before installing.
- Sets the service startup type to `Automatic` (starts on boot).
- Configures the service recovery policy: restart on first failure (60s delay), restart on second failure (120s delay), no action on subsequent failures.
- The service runs under the `LocalSystem` account by default. Overridable via `--username` and `--password` flags for environments that require a specific service account (e.g., for network drive access).
- Stores the resolved Python interpreter path and the `data-hub watcher watch` command as the service executable.

```
$ data-hub watcher service install

✓ Service "DataHubWatcher" installed successfully.
  Startup type: Automatic
  Recovery: restart after 60s (1st failure), 120s (2nd failure)

  Start the service with: data-hub watcher service start
  Or start it from Services (services.msc).
```

## `data-hub watcher service uninstall`

Removes the Windows Service. Stops the service first if it is running. Requires confirmation.

```
$ data-hub watcher service uninstall

? The service "DataHubWatcher" is currently running. Stop and uninstall? [y/N]: y
✓ Service stopped.
✓ Service "DataHubWatcher" uninstalled.
```

## `data-hub watcher service start`

Starts the installed Windows Service. Equivalent to `net start DataHubWatcher` or starting from `services.msc`.

## `data-hub watcher service stop`

Stops the running Windows Service. The service handler translates the stop request into a clean shutdown signal, triggering the same graceful shutdown behavior as Ctrl+C (final heartbeat, etc.).

## `data-hub watcher service status`

Displays the current service state:

```
$ data-hub watcher service status

Service:    DataHubWatcher
Status:     Running
Startup:    Automatic
PID:        12345
Uptime:     2 days, 3 hours
```

If the service is not installed, prints a message and exits with code 1.

## Service Implementation

The service is implemented as a `win32serviceutil.ServiceFramework` subclass in `watcher/service.py`:

- `SvcDoRun` starts the watcher's main loop (same logic as `data-hub watcher watch`).
- `SvcStop` sets a shutdown event that the main loop checks, triggering the same graceful shutdown path as SIGINT/SIGTERM.
- The service writes startup and shutdown events to the Windows Event Log via `servicemanager.LogInfoMsg` in addition to the watcher's own log file.

## Dependencies

| Dependency | Purpose | Status |
|---|---|---|
| `pywin32` | Windows Service support (conditional, Windows only) | **New (optional)** |

`pywin32` is declared as an optional dependency in `pyproject.toml` under an extras group:

```toml
[project.optional-dependencies]
windows-service = ["pywin32"]
```

On lab PCs: `pip install data-hub-utils[windows-service]`. On macOS dev machines, the extras group is omitted and `service.py` is never imported.

## Acceptance Criteria

1. `data-hub watcher service install` installs a Windows Service named `DataHubWatcher` with `Automatic` startup and restart-on-failure recovery (Windows only).
2. `data-hub watcher service uninstall` stops and removes the Windows Service (Windows only).
3. `data-hub watcher service start` / `stop` / `status` control the service and report its state (Windows only).
4. All `service` subcommands exit with a clear error on non-Windows platforms.
5. The Windows Service runs the same `watch` logic and shuts down gracefully when the service is stopped.
