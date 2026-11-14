# Watcher

The Data Hub Watcher is a command-line program that runs on lab instrument PCs. It monitors a directory for new files, groups them into runs, uploads them to S3, and reports status to the Data Hub API.

## Installation

The watcher is a Python package managed with [uv](https://docs.astral.sh/uv/getting-started/installation/). From the repo root:

```sh
uv sync --all-packages
uv run data-hub-watcher --help
```

All `data-hub-watcher` commands should be run from the `data-hub` project directory using `uv run`.

On Windows, the watcher can optionally be installed as a Windows service:

```sh
uv sync --all-packages --extra windows-service
uv run data-hub-watcher service install
```

## Quick start

```sh
# Run the interactive setup wizard.
uv run data-hub-watcher init

# Start watching for files.
uv run data-hub-watcher watch
```

For lab-PC installs (PyPI), see [Install and update the watcher](https://datahub.arcadiascience.com/docs/install-the-watcher). For cutting releases and advertising them to the fleet, see [Roll out watcher releases](https://datahub.arcadiascience.com/docs/watcher-releases).

## Commands

All commands accept two global flags:

- `--config PATH` (or the `DATA_HUB_CONFIG_PATH` env var): override the config file path.
- `--verbose`: enable debug-level logging on stderr.

### `init`

Interactive setup wizard that:

1. Prompts for the environment (`staging`, `production`, or `preview`) and the Data Hub API base URL for it. There is no built-in default URL — each environment points at whatever deployment you host — and the URL is saved per environment so switching back later reuses it without re-prompting.
2. Prompts for an API key (or reads `DATA_HUB_API_KEY` from the environment). The key is saved to a per-environment file at `~/.data-hub/.env.<environment>` (e.g. `.env.staging`), so switching between environments later doesn't require re-entering it.
3. Fetches existing instruments from the API or registers a new one.
4. Prompts for the watch directory, file patterns, run detection pattern, stability period, and upload mode.
5. Registers the watcher with the API. An instrument can have at most one active (non-deregistered) watcher at a time — registration fails if one already exists, and the CLI prints the existing watcher's id along with the deregister command needed to free it up.
6. Saves the config to `~/.data-hub/config.yaml`, the API key to `~/.data-hub/.env.<environment>`, and syncs the config to the API.

The wizard normalizes the pasted API key (stripping zero-width and non-breaking-space characters that Windows clipboards routinely inject) and rejects values that don't start with `dhub_`, so a paste mistake surfaces as a clear error rather than a confusing 401 later. Pass `--show-key` if your terminal mangles hidden input on paste.

The initial scan mode defaults by environment: a fresh `init` on `production` uploads whatever is already in the watch directory, while `staging` and `preview` skip the pre-existing backlog and upload only files created afterwards. This guards a test environment from ingesting a PC's entire history. Set `initial_scan` in the config to override — see [Initial scan and the backlog](#initial-scan-and-the-backlog).

### `watch`

Starts the file monitoring loop. Before entering the loop it:

- Validates the config and checks that the instrument is active (not pending).
- Checks with the API that the watcher is still registered (`GET /watchers/{id}`). A watcher whose registration was deleted on Data Hub, which the server says with the error code `WATCHER_DEREGISTERED`, is refused: the start stops with `DEREGISTERED_MESSAGE` and exits with code 3 (`DEREGISTERED_EXIT_CODE`), `--dry-run` included. Any other failure of the check, a plain `NOT_FOUND` included, is logged and lets the watcher start as before. See [A deregistered watcher](#a-deregistered-watcher).
- Installs its Ctrl+C and SIGTERM handlers, before the supervisor starts (watcher 1.4.3). The handler calls `WatcherSupervisor.request_stop`, the supervisor's one stop signal (see [How long a stop takes](#how-long-a-stop-takes)). A stop that arrives during the start is acted on as soon as `start` returns: `run_supervisor` returns at once, and the command stops the watcher as for any other Ctrl+C, with a `watcher_stopped` event and a final `stopped` heartbeat, and exits 0. Before 1.4.3 the handlers came after the start, so a SIGTERM in that window ended the process and Ctrl+C raised `KeyboardInterrupt`, and neither sent a `stopped` heartbeat or an event.

Then `WatcherSupervisor.start` does the rest, in this order:

- Initializes the local state database for the active environment (`~/.data-hub/watcher-<environment>.db`).
- Syncs the config with the API, and applies a config revision that an admin saved in the web app while the watcher was stopped (watcher 1.4.0). See [Config revisions from the web app](#config-revisions-from-the-web-app).
- Checks that the watch folder exists and can be listed. If it can't, the watcher starts in the [waiting state](#the-waiting-state) instead of exiting. The look runs on its own thread and is given `FOLDER_PROBE_TIMEOUT_SECONDS` (10 s), so a share that has hung is reported as "not responding", not waited for. A stop doesn't cut this look short: it is the look that starts a runtime, and there is nothing yet for `stop` to stop in its place.
- Hydrates in-memory run state from the local DB so the initial scan skips files that were already reported in a previous session, sends the first heartbeat (and flushes the queued events), and starts the upload worker.
- Runs the initial scan of the watch folder, which on a large folder takes minutes, and then starts the observer and the stability checker.

A stop during the start-up scan ends the scan early (watcher 1.4.3). `FileMonitor` takes a `should_stop` callable, which is true once `request_stop` was called or the runtime asked to shut down for an update, and checks it between the entries of the scan, folders included. `FileMonitor.start` then returns without starting the observer or the stability checker, and `start_runtime` doesn't start the upload worker if the stop came before that. The normal clean stop follows within seconds, as for a stop at any other time. The files the scan hadn't reached are scanned at the next start. A scan writes nothing to the state DB for a file: a file gets its `uploaded_files` and `detected_files` rows once it has become stable and been reported or uploaded, which starts at the stability checker, and that never ran. The one write a scan makes is the baseline of the first start of a `new-only` environment, which it records, with the mark that says the baseline was seeded, only after its walk has ended. A walk that stopped early records neither, because a partial baseline would count as done and the next start would upload the rest of the backlog as new. The same applies to the scan of a rebuild and of the resume from the waiting state, which stop on a stop request too. What a stop during `start` still waits for is the config sync, the first heartbeat and its flush, which each have their HTTP timeouts (see [What the limit doesn't cover](#what-the-limit-doesnt-cover)), and the local steps that take little time (opening the state DB, hydrating the run state, building the runtime).

While running:

- **File monitor** watches the directory for new/modified files using `watchdog` and waits for each file to stabilize (size + mtime unchanged for the configured stability period). Files that keep changing past `max_stability_wait_seconds` (default 5 minutes) are abandoned and surface as a `stability_timeout` error event.
- **Run detector** groups stable files into runs by applying the configured regex to each file's relative path. The first file for a run triggers `POST /instruments/:id/runs`; subsequent files for the same run incrementally `PATCH` only the new entries onto the manifest. A POST or PATCH that fails with a connection error, a 5xx, or a response the client can't read is retried in process until it succeeds (watcher 1.2.2), so a single-file run isn't stranded until the next restart. The delay starts at `RUN_REPORT_RETRY_BASE_DELAY_SECONDS` and doubles up to `RUN_REPORT_RETRY_MAX_DELAY_SECONDS`, then stays there. `RunDetector.retry_failed_reports` runs from the monitor's once-per-second tick and sends at most one request per tick. A new stable file in the run is still sent right away, and a failure there keeps doubling the same delay. Replaying a POST is safe because the server inserts a run only when `(instrument_id, run_id)` is new. A 4xx is never retried; a new file or a restart tries again, because the initial scan queues any file the server never accepted. From 1.4.1, once the server has accepted a POST or PATCH, the detector writes what the next start needs in one SQLite transaction: the run (for a POST), the file manifest and, in auto mode, a `pending_uploads` row for each file it is about to upload. A kill or a failed write leaves all of it or none of it. After a failed write the watcher goes on: the server has the files, so the run's cursors move on and the run is not POSTed again, the first of a row of failed writes is reported as a `state_write_failed` error event, nothing is uploaded yet, and the write is retried on the backoff of a failed report. Until the write works the detector sends nothing more for that run: a retry, and a new file of the run, only try the write again, and the files that finish in the meantime wait for one PATCH after it. The write goes first because a PATCH refused for good (a 4xx) is not retried and would cancel the scheduled write. A kill before a write works leaves none of it. With none of it, the next start's initial scan finds the files again and reports them again, which the server accepts without adding a second row for a file. With all of it, the upload worker retries the files from `pending_uploads`. Before 1.4.1 these were separate writes, and a kill between them left reported files that nothing would ever upload. Upgrading doesn't re-queue files that an older watcher already left that way, because a startup pass over every reported file would also upload old manual-mode files after an instrument switches to auto, and files whose retries ran out or that went missing; request those from the run page. Files inside the watch tree that don't match the pattern emit a `pattern_mismatch` event (throttled to one per parent directory) so misconfigured patterns surface in the dashboard.
- **Uploader** requests a presigned S3 URL from the API and uploads each file via HTTP PUT right after run detection (auto mode), and processes the server's upload queue (both modes from watcher 1.2.1; manual mode only before that). The watcher does not need AWS credentials. Only one thread uploads a given file at a time, because a second multipart start makes the server abort the first; a thread that had to wait skips the file if the other thread uploaded it. Files of 100 MB or more (watcher 1.2.0) are uploaded as 64 MB parts: the server starts the multipart upload, the watcher fetches a few part URLs at a time, and the server finishes the upload after checking a CRC64NVME checksum of the whole file. A failed part is retried on its own, up to 6 attempts, and a failed part-URL request counts as one of them (a 4xx fails the file at once). Each upload retries up to 3 times with exponential backoff (1, 2, 4 s) and is recorded locally with its SHA-256 so retries and restarts don't re-upload the same bytes. A restart in the middle of a multipart upload starts that file over. From 1.3.0, `upload_parallelism` (default 4, 1–32) is one budget of simultaneous S3 PUTs, whole files and parts together, shared by auto mode, the upload queue, pending-upload retries, and the one-shot `upload` command. A slot is held only while a PUT runs, and for a part from fetching its URL through the PUT, so a URL never waits in line and expires. The parts of one file upload on daemon threads started for that file. A lock-protected cache hands out part URLs in batches of 8 (one part is refreshed alone on a retry, or when its URL is over 5 minutes old). The lock is never held across a request, so a slow request for one part's URL doesn't hold up the cached URLs of the others, and parts that miss on the same batch share one request. The first part to fail for good stops the file's parts that have not started. A part fails for good when it runs out of retries, or when its part-URL request gets a 4xx, which isn't retried. The multipart upload is aborted only after every part in flight has returned. A stop starts no new file or part, and lets the parts in flight finish; a file that was still being hashed when the stop came is deferred before its first PUT. `Uploader.abort`, which a config rebuild calls once its drain limit passes, is a stop that also cuts off the PUT bodies and hashing in progress, each at its next read, and defers those files the same way. Auto-mode batches, queue polls and pending-upload retries run their files on daemon threads started for that call, and return once every file is done. With one worker, or one file, nothing is started and the work runs on the calling thread. The calling thread waits for these threads in 0.5 s steps, because Python on Windows can't deliver Ctrl-C to a thread that waits with no timeout. Daemon threads are dropped when the process exits, so a PUT in flight doesn't hold up shutdown the way a thread pool's join would. The same goes for the hash of a file and its upload-URL request, which run side by side on two daemon threads started for each file (`_DaemonCalls`; a file that an earlier try found unreadable, below, is hashed first and then asked for, on the calling thread, which is a daemon thread as well): a thread pool's threads would be joined at exit, and a URL request waiting on a server that has stopped answering can last 35 s (5 s to connect, 30 s to read). The file is retried at the next start, from its `pending_uploads` row in auto mode or from the server's queue. From 1.4.2 a file that is on disk but can't be opened or read yet is a separate result from a failed upload. That is a `PermissionError`, from the `stat`, the open or a read, for a file that is still there. CPython maps the Windows sharing violation (32) and lock violation (33) to `PermissionError`, and on Linux and macOS it is `EACCES` or `EPERM`, so the check looks at no Windows error code. An instrument may keep a file open with exclusive sharing after its last write, and on any OS a file's permissions may be fixed later. Every other `OSError` is a real failure, handled as before: a bad sector (`EIO`), a share that drops in the middle of a read (`EINVAL`, WinError 64) or a stale handle (`ESTALE`) doesn't clear by itself, and a wait with no time limit would hide it. `_upload_single_unlocked` stats the file, then opens it and reads one byte, before it asks the server for an upload URL, so a file that is still locked costs no request. A file in a folder that this user can't search fails the `stat` with the same error, so it is classified the same way, and the existence checks in the retry paths (`_is_file`, `_exists`) count such a file as there, because `Path.is_file` and `Path.exists` raise for it on Python 3.12. A file that is locked only past its first byte passes the open check. On a first try the hash and the URL request run in parallel, so a hash that then fails with a `PermissionError` has already asked for a URL, and a multipart upload that the request started is aborted. Once a try has found a file unreadable, the next tries hash it before they ask for the URL, so such a file costs no request on the polls after that, however far into the file the lock is. An upload that fails with the file no longer openable is classified by opening the file again, because `requests` wraps an error raised while it sends the body: if that open raises a `PermissionError`, the file can't be read yet, and a multipart upload is aborted. A read that fails with any other error, after the open check passed, is an ordinary failure of the hash or the upload. `_upload_single` then raises `CantReadYet`, nothing is recorded or counted as a failed attempt, and no `Hashing failed` or `Upload failed` event is queued. Three callers handle it. The auto-mode batch and the start-up retry keep the file's `pending_uploads` row, add no attempt, and put the file in an in-memory waiting collection. An unexpected error on one file of an auto-mode batch no longer ends the batch: the other files are tried, and the first error is raised after them, so the monitor still reports it as `stable_callback_failed`. The queue path adds nothing to `_queue_attempts`, so the request stays queued and the server returns it on the next poll. All three queue one `upload_failed` event per file per uploader (a config rebuild makes a new one) when the file is first found unreadable, with `details.will_retry: true`. The uploader forgets that it reported a file when the file is uploaded, when it stops waiting, and, for a queued file, when a poll finds it neither queued nor waiting, so a later lock is reported again. Later polls log a debug line, so a locked file can't fill the 500-event queue, and a queue poll logs the size of the queue at INFO only when the queued files differ from the last poll's. A file that has vanished keeps its current handling. The one-shot `upload --file` command has nothing that waits, so it fails with a message that names the file. Queue-poll failures are throttled (1st failure, then every 10th) to keep a sustained outage visible without flooding the events stream. Failed uploads record S3's error code and message. Error text replaces the query string of a signed S3 URL with `?<redacted>`, since that query string holds temporary AWS credentials.
- **Upload worker** polls the server's upload queue on its own long-lived thread every 60 seconds, decoupled from the heartbeat so a slow or large upload can't delay heartbeats and make a busy watcher look offline. It runs in both modes, so **Request upload** on a run page reaches auto-mode watchers too. In auto mode it first retries uploads the previous process left unfinished (see `pending_uploads` under [Local state](#local-state)). On every poll, before it fetches the queue, it tries each file in the uploader's waiting collection again (watcher 1.4.2): the open comes first and, for a file that an earlier try found unreadable, the hash after it, both before any request, so a file that is still locked, even partway through, asks the server for nothing, and then the upload. There is no time limit, and a poll that finds the file still locked isn't a failed attempt. A file that can be read but whose upload fails for another reason leaves the collection, and its `pending_uploads` row is retried at the next start like any failed upload. A file that has vanished is dropped with a `pending_upload_missing` event. The collection is in memory: the start-up retry fills it again for rows whose files are still locked. The poll's wait is the worker's stop-aware one, and the retries start no file after a stop, so a stop isn't delayed. On shutdown it is stopped and joined before the state DB is closed. Auto-mode uploads of newly detected files still run on the monitor's stability-checker thread via the run detector's upload callback. They share the worker's stop signal, so a shutdown also stops them between parts and retries; an interrupted file keeps its `pending_uploads` row and is retried at the next start.
- **Heartbeat loop** sends periodic heartbeats (every 60 seconds) to the API. The payload includes the watcher version, instrument ID, watch directory, upload mode, per-interval activity counters, process uptime, and from 1.4.0 the highest config revision the watcher has applied (`config_revision`); a final `status="stopped"` heartbeat is sent on graceful shutdown, with `status_reason="system_shutdown"` (1.4.1) when the Windows service stops because Windows is restarting or shutting down. The reply carries the server's latest config revision, which is how the watcher learns about a change from the web app. From 1.1.0 the same version is also sent on every request as `X-Data-Hub-Watcher-Version`. The server uses that header, not the version stored from the last heartbeat, when a request has no watcher id (an upload-link request does not). A missing header means a watcher older than 1.1.0, and the server keeps the behavior that watcher was built for. From 1.4.3 the activity counters carry over (see [Heartbeat counts](#heartbeat-counts)). The loop counts the heartbeats that the server answers with its "deregistered" reply: a 404 whose JSON error code is `WATCHER_DEREGISTERED` (`ApiError.is_deregistered_reply`), which the server sends only when the watcher's row exists and was deregistered. A watcher ID that the server has no row for gets `NOT_FOUND` instead, and that, like any other result, a success included, starts the count again, so rows that went missing from the server's database can't stop a watcher. The count (`DeregisteredReplies`) belongs to the supervisor and is shared by every heartbeat loop it builds, so a watcher that switches between watching and waiting can't postpone its stop by starting the count again. On the third reply in a row (`DEREGISTERED_HEARTBEAT_THRESHOLD`), the loop ends itself and calls `on_deregistered` once. The runtime then logs one error that says to run `init`, tells the uploader to start nothing new (`Uploader.request_stop`), and stops the watcher. A config rebuild that was in progress when the third reply arrived builds nothing more. The stop cuts off the uploads in progress (`Uploader.abort`), with the short joins of a Windows shutdown. It sends no `watcher_stopped` event and no final heartbeat, because the server would answer both with the same 404, and the stop sends nothing else to Data Hub either, queued events included. The events saved in `pending_events` stay saved (see [Observability](#observability)). It still closes the state DB, unless an upload thread is still running. The waiting state stops the same way. See [A deregistered watcher](#a-deregistered-watcher).
- **Event reporter** batches and flushes lifecycle events (started, stopped, file uploaded, errors) to the API, at most 100 events per request, which is what the server takes. The supervisor's reporter also saves every queued event in the state DB (`pending_events`) until the server has it (1.4.3), so events that were queued when the watcher was killed are sent after the restart. See [Observability](#observability) for how, and for the full taxonomy.
- **Auto-updater** runs from the same heartbeat tick on every platform — not only Windows services. It polls `GET /watchers/:id/update-check` roughly hourly and applies new releases when the watcher has been idle long enough not to clobber an in-flight run. The full activity-window guard, mandatory-update behavior, and rollback flow are documented in [Roll out watcher releases](https://datahub.arcadiascience.com/docs/watcher-releases); auto-update is hard-disabled in the `preview` environment.

Use `--dry-run` to validate config and preview what would happen without starting the monitor.

### `upload`

One-shot file upload for manual use:

```sh
# Upload a specific file.
uv run data-hub-watcher upload --file /path/to/file.csv --run-id RUN001

# Process the server-side upload queue.
uv run data-hub-watcher upload

# Preview without uploading.
uv run data-hub-watcher upload --dry-run
```

Both forms use the instrument's `upload_parallelism`. Ctrl-C stops new parts and files from starting and ends the command without waiting for parts that are already sending, which run on daemon threads. The interrupted file isn't recorded as uploaded. Run the command again to upload it; the server aborts the unfinished multipart upload when the new one starts.

### `config`

Subcommands for managing the YAML config file:

| Subcommand | Description |
| --- | --- |
| `config show` | Pretty-print the current config |
| `config validate` | Validate the config file (offline). Also fails when the watch folder is missing or unreadable, although the watcher itself still starts and waits for it, and warns when Data Hub can't read the settings (see [Settings Data Hub can't read](#settings-data-hub-cant-read)) |
| `config set-environment ENV` | Switch the active API environment (see [Switching environments](#switching-environments)) |
| `config edit` | Re-prompt each field with current values as defaults |
| `config open` | Open the config in your editor, then re-validate |
| `config path` | Print the resolved config file path |

### `service` (Windows only)

Requires the `windows-service` extra (`uv sync --all-packages --extra windows-service`).

Manage the watcher as a Windows service:

| Subcommand | Description |
| --- | --- |
| `service install` | Install the Windows service |
| `service uninstall` | Remove the Windows service |
| `service start` | Start the service |
| `service stop` | Stop the service |
| `service status` | Show service status |
| `service reinstall` | Stop, uninstall, install, and start in one go |

`service install` (and `service reinstall`) accept `--env-path PATH` to override which `.env` file the SCM-launched process loads (defaults to `~/.data-hub/.env.<environment>`). `service reinstall` is the right command after an out-of-band wheel swap (e.g. `pip install -U data-hub-watcher` from an Administrator shell): the stop and uninstall steps are best-effort so it works equally well when the service is already gone. The installer:

- Registers the service with `Tcpip` and `Dnscache` as start dependencies and `delayedstart=True` so it does not race the boot-time network stack.
- Configures recovery actions (restart after 60 s on first failure, 120 s on second) with `SERVICE_CONFIG_FAILURE_ACTIONS_FLAG` set, so a non-zero `SystemExit` from the runtime — notably the upgrade-driven restart request — is treated as a failure and the SCM picks the new wheel up automatically.
- Persists the config and env-file paths under `HKLM\SYSTEM\CurrentControlSet\Services\DataHubWatcher\{ConfigPath,EnvPath}` so `SvcDoRun` can locate them regardless of which account the service runs under.

#### Stopping, and a restart or a full shutdown of the PC

The service accepts two controls that stop it: `SERVICE_CONTROL_STOP` (`service stop`, the Services console) and, from 1.4.1, `SERVICE_CONTROL_PRESHUTDOWN`, which Windows sends before it restarts or shuts down completely. `SvcStop` and the preshutdown branch of `SvcOtherEx` both call `_begin_stop`, which reports `STOP_PENDING` and sets the stop event. `SvcStop` reports a 30 s wait hint (`SERVICE_STOP_WAIT_HINT_MILLISECONDS`), for a stop that can take 25 s; a preshutdown keeps pywin32's default 5 s, which Windows ignores. `_run_service_loop` then stops the runtime as `watch` does on Ctrl-C: the uploader is told to stop, the monitor and the upload worker are stopped, the heartbeat loop is stopped, a `watcher_stopped` event is sent, and the final `stopped` heartbeat follows it. Every stop has a time limit, 25 s, or about 8 s for a preshutdown; see [How long a stop takes](#how-long-a-stop-takes).

A preshutdown also marks the stop as caused by Windows, in three places:

- The `watcher_stopped` event reads `Service stopped: Windows is shutting down`, not `Service stopped`, so a restart of the PC can be told from a `service stop`. (A shutdown that arrives while an auto-update restart is pending wins: the message and the mark are the shutdown's, and the service doesn't exit with the failure code that asks the SCM for a restart.)
- The final `stopped` heartbeat carries `status_reason: system_shutdown`. See below for what the server does with it. The web app shows such a watcher as Stopped, with a tooltip that gives the time it will show as Unresponsive if it isn't back.
- `watcher.log` has `Data Hub Watcher stopping: Windows is shutting down`. The handler writes it after it has started the stop, because a control handler shouldn't block. The Application log gets the same line from the Event Log handler.

##### Requested uploads stay queued across a restart

When the server gets a `stopped` heartbeat it cancels every `upload_requested` file on the instrument at once (they go back to `detected`), because nothing is left to upload them. Lab PCs restart often, so a `stopped` heartbeat with `status_reason: system_shutdown` is the exception: the server skips that cancellation, and the watcher uploads the requests after the PC starts again. If no heartbeat follows, the offline sweep (`UPLOAD_REQUEST_REVERT_GRACE_MS`, 15 minutes, run by the `upload-queue-sweep` cron every 5 minutes) cancels them as for a watcher that died. A `stopped` heartbeat without the mark behaves as before, which is what older watchers send, and a server older than this change ignores the mark.

The server also stores the reason on the watcher row, so the web app can tell this stop from a plain one. `RESTART_STOP_REASONS` in `web/lib/api/watcher-status.ts` lists the reasons it keeps for a `stopped` heartbeat: `system_shutdown`, and `auto_update` for a watcher that stops to install an automatic update. The server accepts `auto_update`, and watcher 1.4.2 and later send it. Any other `stopped` reason is dropped, and `waiting` keeps its reason as before.

A stop for an automatic update carries `status_reason: auto_update` (`AUTO_UPDATE_STATUS_REASON` in `constants.py`, which must match the server's constant of the same name), and the server treats it like `system_shutdown`: requested uploads stay queued, and the watcher reads `stale` after `UPLOAD_REQUEST_REVERT_GRACE_MS` if it doesn't come back. `WatcherSupervisor.stop` picks the reason of the final heartbeat, once, at the top of the stop (it freezes the updater first, see below). `system_shutdown` wins when Windows is shutting down. Otherwise it is `auto_update` when an in-process update was installed (`upgrade_restart_event` is set, as for the `watch` command and for a pip-installed service) or when the supervisor's `UpgradeHandoff` holds an upgrade that the updater handed to the Windows worker (see below). Otherwise there is none. A stop the operator asks for, Ctrl+C or SIGTERM in `watch`, passes `operator_stop=True` and never gets a reason, even with an update under way. The `watcher_stopped` messages don't change: a service that the worker stops still logs `Service stopped`, and only an in-process update reads `... restarting for auto-update`.

Only an update that the running watcher starts itself sends the reason. `data-hub-watcher self-update` on a service host dispatches the same worker, but from a separate process that has no say in the service's `UpgradeHandoff`, and the stop that the worker causes carries no reason: the server cancels the requested uploads, as for `service stop`.

`computeEffectiveStatus` (in `web/lib/api/watchers.ts`) uses the stored reason. A watcher that stopped for one of these reasons reads `stale` (Unresponsive) once its last heartbeat is more than `UPLOAD_REQUEST_REVERT_GRACE_MS` old, the same window the sweep uses. Any other `stopped` watcher reads `stopped` however old its last heartbeat is, because it can't send another one. A `watching` or `waiting` watcher reads `stale` after 5 minutes, and a deregistered watcher always reads `stopped`. `GET /api/v1/watchers?status=…` follows the same rules through `effectiveStatusCondition`, so a watcher is listed under exactly the status it shows. The status badge in the web app turns the reason and the last heartbeat into a tooltip that gives the time the watcher will read Unresponsive.

##### An upgrade handed to the Windows worker

On Windows with a uv-tool install the updater doesn't install in process. `Updater._apply_via_worker` writes the upgrade marker and the request, triggers the `DataHubWatcherUpgrade` scheduled task, and leaves the rest to the worker, which stops the service from outside (`Stop-Service`), runs `uv`, and starts the service again. Nothing in the process says the upgrade is under way, so once `schtasks` has accepted the task the updater records the hand-off in an `UpgradeHandoff` (in `updater.py`). A refusal before the task is triggered, such as no `uv` on disk, or a failed `schtasks`, records nothing and reports `update_failed`. A failed `schtasks` also clears the request and the marker.

`WatcherSupervisor` owns the one `UpgradeHandoff`, with its own lock, and gives it to every `Updater` it builds: through `build_runtime(upgrade_handoff=...)` for the runtime, and directly for the updater of the waiting state. The runtime is built again in the same process for a config revision, when the watch folder comes back (the waiting state to watching), and after a failed start (the fallback to waiting, and the rollback to the previous config), so the memory can't belong to an `Updater`: a rebuilt runtime would forget the hand-off, dispatch the same upgrade again, and send the worker's stop with no reason.

For `UPGRADE_HANDOFF_TIMEOUT_SECONDS` (10 minutes) after the hand-off, the updater's tick skips the update check with the reason `upgrade handed to the worker`, so the next heartbeat can't dispatch the same upgrade again. The first tick after the window is over ends the hand-off (`UpgradeHandoff.take_expired`, the only thing that does): it queues `update_failed` with `reason: worker_did_not_stop_service` and the target version, whose message points at `upgrade-worker.log`. A worker that ran but couldn't stop the service (`Stop-Service` failed, or `uv` failed on the files the running service holds) left `.upgrade-result.json` with the real error, so the event carries its `worker_*` details, the same ones the report after a restart has, and the file is cleared with the request and the marker. The tick then goes on with its checks as usual, so a later check can dispatch again. A worker that hasn't started yet finds no request and does nothing, and one that is already running has read it and carries on.

A stop can begin while all of this runs, so `WatcherSupervisor.stop` calls `UpgradeHandoff.begin_stop()` before anything else. From then on `Updater.on_tick` does nothing, so no tick during the stop ends the hand-off or dispatches an update. A heartbeat tick that is already running when the stop begins still reaches `on_tick` when it finishes, and one that ended the hand-off would delete the request and the marker of a worker that is installing. `begin_stop` says whether a hand-off is held, and the stop reason is chosen from that, once. A hand-off counts until a tick ends it, not until the clock says the window is over: the worker may stop the service just before the window ends, and the service loop takes up to a second to notice the stop. The reason is still not safe from a tick that ends the hand-off in that second, before `stop` begins, and then the stop is sent with no reason. A stop that begins after the tick that ended the hand-off is not the worker's.

The heartbeat loop keeps ticking through the first part of a stop, until step 4 of [How long a stop takes](#how-long-a-stop-takes), which comes once the uploads have stopped or been cut off, up to 15 s in. So a tick that reaches `on_tick` during a stop is the usual case, not a rare one. The freeze comes first because of that: `begin_stop()` runs before `stop_runtime` begins any step, and the reason is already chosen by then.

##### Why preshutdown

pywin32 311's `ServiceFramework.GetAcceptedControls` reports `SERVICE_ACCEPT_STOP` for a class that has a `SvcStop`, pause and continue for one that has both `SvcPause` and `SvcContinue`, and `SERVICE_ACCEPT_SHUTDOWN` for one that has a `SvcShutdown`. It has nothing for preshutdown: a class that wants it overrides `GetAcceptedControls` to add `SERVICE_ACCEPT_PRESHUTDOWN` (0x100), and handles `SERVICE_CONTROL_PRESHUTDOWN` (0x0F) in `SvcOtherEx`, which `ServiceCtrlHandlerEx` calls for any control it has no route for. The service does both. Before 1.4.1 the class accepted neither, `sc queryex` listed `IGNORES_SHUTDOWN`, and a restart killed the process with no stop. With 1.4.1 `sc queryex` is expected to list `ACCEPTS_PRESHUTDOWN` (Microsoft's description of `sc` on Windows 7 and later; the end-to-end test reads it on a Windows runner).

The service reports the controls it accepts each time it runs, so nothing is stored at install, and a PC upgraded in place has this from the restart into the new wheel, with no `service reinstall`.

Preshutdown is sent before any shutdown control, and the SCM waits until the service stops or the preshutdown timeout passes before it goes on. The shutdown control is sent to the services that accept it in the order of the services database, with no regard to dependencies (Microsoft's [service control handler page](https://learn.microsoft.com/en-us/windows/win32/services/service-control-handler-function)), so the network services can already be stopping while a service sends its last request. A service that stops on preshutdown isn't sent the shutdown control. The time allowed for the shutdown control is "about 20 seconds" on Microsoft's [`HandlerEx` page](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nc-winsvc-lphandler_function_ex), but for a reboot the SCM waits no longer than the `WaitToKillServiceTimeout` value under `HKLM\SYSTEM\CurrentControlSet\Control`, which Microsoft doesn't document for Windows 10 and 11 and which is commonly reported as 5 s. The preshutdown timeout is documented: 10 s by default from Windows 10 build 15063 (version 1703), and 180 s before that (Windows 10 1507 and 1607, and the 2015 and 2016 LTSB releases), set per service with `SERVICE_CONFIG_PRESHUTDOWN_INFO` ([`SERVICE_PRESHUTDOWN_INFO`](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/ns-winsvc-service_preshutdown_info)). The service keeps the default: a longer one would be a change to the registration, which PCs upgraded in place don't get. Microsoft asks services to use preshutdown only where it is needed to avoid data loss or a long recovery at the next start. Here it gives the final heartbeat and the queued events a chance to get out before the network goes down. An upload in flight is cut off and retried after the restart.

##### How long a stop takes

Every stop has a time limit, so a stop can't hang when the server stops answering. A normal stop (`service stop`, Ctrl+C or SIGTERM for `watch`, a restart for an update) has 25 s (`STOP_BUDGET_SECONDS`), and the last 10 s of it (`STOP_RESERVE_SECONDS`) are kept for the event and the final heartbeat. A stop for a preshutdown has 7 s, because the wait hint can't raise Windows' limit: it waits until the service stops or the preshutdown timeout passes. So that stop limits itself to its 7 s, and with the time the process needs to end it is done in about 8 s on any Windows build, the 10 s default or the 180 s of older builds. `WatcherSupervisor.request_stop` is the one signal for a stop (watcher 1.4.3), and both entry points call it: the signal handler of the `watch` command, and the service loop. `request_stop` sets the supervisor's `stop_requested` event and wakes `poll`. The service loop starts a daemon thread before `supervisor.start()` that waits for the service's stop event, which `SvcStop` and the preshutdown control set (`_begin_stop`), and calls `request_stop` the moment it is set. So `stop_runtime` starts its budget, and the uploader its stop, without waiting for `poll`'s 1 s timeout, and a start-up scan that is running ends at its next entry (see [`watch`](#watch)). Once a stop is requested, `poll` leaves pending work (a config revision, a folder check) alone, because it would only hold the stop up. The loop can't see a stop while it is busy with the parts of starting the watcher that don't read the signal (the config sync, the first heartbeat and flush), with applying a config revision (a drain of up to 120 s), or with the few steps of a folder check that have only an HTTP timeout; see [What the limit doesn't cover](#what-the-limit-doesnt-cover). The folder checks themselves do read it: the look at the folder, the wait before the second look, and the move to the waiting state or the rebuild that follows end within a second of a stop, and leave the runtime to `stop` (see [The waiting state](#the-waiting-state)). `SvcStop` reports a 30 s wait hint, so `net stop` and the Services console don't report the service as hung during a long stop.

`WatcherSupervisor.stop` comes before these steps. It freezes the updater and chooses the `status_reason` of the final heartbeat, if there is one (see [Requested uploads stay queued across a restart](#requested-uploads-stay-queued-across-a-restart) and [An upgrade handed to the Windows worker](#an-upgrade-handed-to-the-windows-worker)), and passes it to `stop_runtime`. The steps of `stop_runtime`, in order, for a normal stop:

1. `Uploader.request_stop()` sets the uploader's stop signal, which the upload worker shares. Nothing new starts: no part and no file, in the stability checker's own auto-mode upload or in the worker's uploads. Parts already sending finish. This comes before any wait, so a wait for the monitor can't leave an upload free to start more.
2. The file monitor is told to stop (the stability checker is signalled and the observer is waited for, at most 5 s), and then the stability checker is waited for. watchdog's `Observer.stop()` joins its emitter threads with no timeout, so `FileMonitor.stop` runs it on its own thread and waits for the stop and the observer's thread together for the 5 s (watcher 1.4.3). An observer stuck on a hung network share is then left behind, as a daemon thread, instead of holding the stop.
3. The upload worker is stopped. Steps 2 and 3 wait for uploads in progress until 15 s into the stop, which is the deadline less the reserve. A thread that is still running then is cut off: `Uploader.abort()` ends each PUT and each hash in progress at its next read, and each thread gets at most 1 s more (`STOP_MIN_WAIT_SECONDS`).
4. The heartbeat loop is stopped. It ticks until this step, so a long upload doesn't leave a gap in the heartbeats. A tick in progress is waited for until 15 s into the stop, and for at least 1 s. A tick that is still running after that is left behind: it is a daemon thread and ends with the process. If its request is slow, its `watching` heartbeat can reach the server after the final one, which then looks like a watcher that was killed.
5. The `watcher_stopped` event is queued and the events are flushed, so the server hears the event before it sees the watcher stopped. The flush is done in time to leave the final heartbeat its share, which is the last 5 s of the budget (`STOP_FINAL_HEARTBEAT_SECONDS`), or half of what is left when less than 10 s remain. It retries as the usual flush does (3 attempts, waiting 1 s and 2 s), but only while a retry would have a second left to run, and only after a connection error or a 5xx. After a read timeout it doesn't retry, because the server may already have stored the batch and the events route has no dedup, so a retry could store it twice. Events that don't get out stay saved in the state DB (from 1.4.3) and are sent after the next start; before 1.4.3 they were dropped. A batch the server refuses with a 4xx is dropped either way.
6. The final `stopped` heartbeat is sent with what is left of the budget, with the reason chosen at the top of the stop. The two requests have the client's usual timeout (`DEFAULT_TIMEOUT`: 5 s to connect and 30 s to read), cut down by `timeout_until` so that each fits in its time, so a server that answers in several seconds still gets the event and the heartbeat. The final heartbeat is sent even when the deadline has passed, with a short timeout.
7. The event reporter's store is detached, after a wait of at most 2 s (`STOP_FLUSH_WAIT_SECONDS`), within what is left of the budget, for a flush that a tick left running (see [Saved events](#saved-events)). Then the state DB is closed, unless the upload worker or the stability checker is still running, which leaves it open because the process is about to end.

Against a server that doesn't answer and with no uploads running, a stop therefore waits for a stuck heartbeat tick until 15 s, tries the event for 5 s and the final heartbeat for 5 s, and ends at 25 s.

A stop for a preshutdown is the same sequence with a budget of 7 s (`SYSTEM_SHUTDOWN_STOP_BUDGET_SECONDS`) and much shorter waits:

1. `Uploader.abort()` runs first instead of `request_stop()`. Each PUT and each hash in progress ends at its next read.
2. The file monitor is stopped, waiting at most 1 s for the observer and its stop and 1 s for the stability checker (`SYSTEM_SHUTDOWN_JOIN_SECONDS`).
3. The upload worker is stopped, waiting at most 1 s. There is no second wait.
4. A heartbeat tick in progress is waited for 1 s at most.
5. The event is flushed, and then the final heartbeat is sent. The two requests have a connect timeout of at most 2 s and a read timeout of at most 3 s (`SYSTEM_SHUTDOWN_HTTP_TIMEOUT`), and the final heartbeat gets the last half of what is left, up to 5 s.

A stop of a watcher whose registration was deleted on Data Hub (see [A deregistered watcher](#a-deregistered-watcher)) takes the first four steps of that sequence, with the same 1 s waits, and has no step 5 or 6: it sends no `watcher_stopped` event and no final heartbeat, because the server would answer both with the same 404, and queued events are not sent either. It is done in about 4 s at most. In the waiting state it is the heartbeat loop's 1 s. The state DB is closed as in any stop.

In all of these, a cut-off upload doesn't count as a failed attempt. What happens to the file depends on how it was queued. In auto mode it keeps its `pending_uploads` row, and the next start uploads it again. A file someone requested is not retried by a normal stop: that stop ends with a plain `stopped` heartbeat, and the server then cancels every requested upload of the instrument (the heartbeat route calls `revertUploadQueueIfWatcherOffline`), so the file has to be requested again. Only a final heartbeat with a restart reason keeps the queue: `system_shutdown`, and `auto_update` (watcher 1.4.2 and later; `RESTART_STOP_REASONS` in `web/lib/api/watcher-status.ts`). So a requested file survives a stop for a Windows restart or for an automatic update, and the next start uploads it.

A stop in the waiting state (the watch folder is missing) has only a heartbeat loop to stop, and follows steps 4 to 6 with the same limits and the same reason, so a watcher that waits for its folder while it updates also keeps its requested uploads queued. A config rebuild is not a stop: the watcher keeps running, so `_stop_upload_threads` keeps its 120 s drain, and `HeartbeatLoop.stop(send_stopped=False)` sends no `stopped` heartbeat and no `watcher_stopped` event. The move to the waiting state when the watch folder disappears is not a stop either, and sends neither. It gives uploads 10 s (`WATCH_FOLDER_GONE_DRAIN_TIMEOUT_SECONDS`) and bounds its other waits, which a share that has hung could hold; see [The waiting state](#the-waiting-state) for each of them.

##### What the limit doesn't cover

A stop can still run past its limit where no timeout reaches:

- The service loop and the `watch` command don't see a stop until they have finished the work they are in, where that work doesn't read the stop signal. While the watcher is starting, the initial scan does (it ends at its next entry, so one slow `scandir` or `stat` on a share is the most it can take to notice), but the config sync, the first heartbeat and its flush don't: each is limited by its HTTP timeouts only (`DEFAULT_TIMEOUT`, 5 s to connect and 30 s to read), so a server that doesn't answer can hold a stop that arrives then for as long as those requests take. While it applies a config revision from Data Hub, it is the drain, which waits up to 2 minutes for uploads to finish (the scan of the new runtime reads the stop signal). A folder check reads the stop at every wait (see [The waiting state](#the-waiting-state)), so a stop during the move to the waiting state, or during the rebuild of a runtime that can't see its folder, ends the move and goes to `stop` within about a second, with two exceptions. One is a request already in flight: the flush of the old runtime's events (5 s at most) is not interrupted mid-request, and the move stops at the next check. The other is the end of a move that has got past its last check: the waiting state's first heartbeat (and the flush that goes with it) is sent before the poll loop looks at the stop, and has only the client's HTTP timeouts. The look that starts a runtime (a rebuild, a resume, a start) keeps its 10 s limit when a stop arrives. `stop_runtime` starts its budget only after those.
- A thread that is blocked reading a share that has hung doesn't see `Uploader.abort()`, which takes effect at the next read, and a thread can't be killed. `stop_runtime` doesn't wait for it past its limit: it leaves the state DB open and the process ends. The move to the waiting state and the rebuild of a blind runtime give up on it too, after their own limits, and start no new runtime on the same folder until it has exited. A config rebuild of a runtime that is running does wait for it, with no limit, because it must not start the next runtime next to an upload thread of the old one, and a stop doesn't end that wait. A config change that comes while a thread from an earlier give-up is still there waits for it only up to 120 s, and not at all when the folder changes (see [The waiting state](#the-waiting-state)).
- A connect timeout doesn't cover a name lookup. `requests` resolves the host before its timeout starts, and a lookup that blocks makes a request outlast its timeout by as long as the lookup takes.

For `service stop` that means a stop that takes longer than 25 s. A stop for a preshutdown can run past the time Windows allows, and a stop that Windows cuts off is the same as the kill of before 1.4.1: the final heartbeat is not sent, and an upload in flight is retried at the next start. The events that were queued are saved in the state DB (from 1.4.3) and sent then too. Before 1.4.3 they were lost. No `stopped` heartbeat arrives then, so the server doesn't cancel the requested uploads either, and the watcher shows as unresponsive once the PC has been down for more than five minutes.

##### Fast Startup

On Windows 10 and 11, Fast Startup is on by default. With it, **Shut down** in the Start menu doesn't stop the services: Microsoft describes it as hibernating the kernel session instead of closing it, and the service carries on from there at the next boot. Because the service isn't stopped, there is no `stopped` heartbeat and no `watcher_stopped` event. **Restart** always stops the service, and so does a shutdown with Fast Startup turned off.

### `self-update`

Checks the API for a newer published version and runs the appropriate `uv tool install --reinstall` (or `pip install -U`) subprocess in place. See [Install and update the watcher](https://datahub.arcadiascience.com/docs/install-the-watcher#manual-update-self-update) for supported install methods, and [Roll out watcher releases](https://datahub.arcadiascience.com/docs/watcher-releases) for the activity-window guard, mandatory updates, and rollback flow.

### A deregistered watcher

A watcher whose registration was deleted on Data Hub, in the web app or by retiring its instrument, can't upload or report again. It stops and does not start again by itself. A running watcher finds this out from three heartbeats in a row that the server answers with its "deregistered" reply, a 404 with the error code `WATCHER_DEREGISTERED`, about 3 minutes at the production interval. A watcher that is started after its registration was deleted is refused by the start-up check, which gets the same reply to `GET /watchers/{id}`. Both cases show the same message, which says to run `init`. A plain `NOT_FOUND`, which the server sends for a watcher ID it has no row for, stops nothing: a heartbeat that gets it counts as a failed heartbeat, and the start-up check lets the watcher start.

From the third reply on, the supervisor builds nothing: no runtime, no waiting loop and no config rebuild, and its folder checks do nothing (the move to the waiting state, the rebuild of a runtime that can't see its folder, the start again when the folder is back). `WatcherSupervisor._stopping()` is true for a deregistration, as it is for a stop request or an update restart, and the loops set `deregistered_event` a moment before `shutdown_event`, which `poll` returns on, so a check that runs in that moment sees it too. A runtime whose own first heartbeat is the third reply is kept for the stop to unwind, with none of its threads started.

The exit codes of `watch` are:

- `0`: a stop you asked for, such as Ctrl+C or SIGTERM
- `1`: an update restart, or any other error (a start that is refused because the instrument is still pending, say)
- `3`: deregistered, while running or at start-up, `watch --dry-run` included (`DEREGISTERED_EXIT_CODE`); a restart can't help until `init` registers the watcher again. A systemd unit can list it in `RestartPreventExitStatus=3`.

The Windows service returns normally when it stops because its watcher was deregistered while it was running, so it exits with 0. The SCM's recovery actions restart a service that exits with a failure, so the service stays stopped. A refused start-up exits with 1, a failure, so the SCM tries again. With the SCM's failure count at 0 it tries twice, a minute and two minutes later, and then leaves the service stopped. The count starts again at 0 only after 24 hours without a failure (`ResetPeriod`), so a service that failed earlier that day gets fewer tries.

## Configuration

The config file lives at `~/.data-hub/config.yaml` by default. Override with `--config` or the `DATA_HUB_CONFIG_PATH` environment variable. The API key is stored separately in `~/.data-hub/.env.<environment>` (e.g. `.env.staging`, `.env.production`, or `.env.preview`); the legacy `~/.data-hub/.env` is also loaded for backwards compatibility, with the per-environment file taking precedence.

### API key binding and rotation

Each watcher is bound to the personal access token (PAT) that registered it. Heartbeats, config sync, events, upload-queue polls, and update-checks from a different PAT receive `403 Forbidden`. Those agent endpoints also reject browser sessions — they accept a PAT only. Prefer **one PAT per instrument PC** so a compromised key on one machine cannot control other watchers.

When you rotate a PC's PAT:

1. **Recommended for a straight rotation:** delete the old PAT in the Data Hub UI (Settings → Tokens). That nulls `watchers.registered_by_token`; the next check-in with the new key re-claims the binding (trust-on-first-use). Update `~/.data-hub/.env.<environment>` with the new key before the watcher checks in again.
2. **Clean reinstall:** deregister the watcher in the UI (Watchers → open the watcher → Deregister), then re-run `data-hub-watcher init` on the PC with the new PAT. That registers a fresh watcher row bound to the new credential.

There is no token-adoptable API for rebinding an already-claimed watcher — any such endpoint gated by `watchers:report` would reopen cross-watcher control.

### Config file format

```yaml
version: 1
environment: production          # "staging", "production", or "preview"
api_base_urls:                   # one API base URL per environment (no default)
  production: https://datahub.example.com/api/v1
watcher_ids:                     # one registration id per environment
  production: <assigned-by-api>
initial_scan: null               # null (default), "full", or "new-only"
instrument:
  id: akta-fplc                  # kebab-case instrument ID
  watch_directory: /path/to/data
  file_patterns:
    - "*.csv"
    - "*.xlsx"
  enabled: true
  upload_mode: auto              # "auto" or "manual"
  stability_period_seconds: 5    # 1–300
  max_stability_wait_seconds: 300  # 1–86400; must be >= stability_period_seconds
  upload_parallelism: 4          # 1–32 files uploaded at once
  run_detection:
    pattern: '^([^/]+)/'         # regex with one capture group (run ID)
    recursive: true
```

### Run detection

The `pattern` regex is applied (via `re.search`) to each file's path relative to `watch_directory`, with backslashes normalized to `/`. Capture group 1 is the run ID. The pattern must have exactly one capture group.

When `recursive` is `true`, the watcher monitors subdirectories; when `false`, only files directly in the watch directory are considered.

The `init` wizard offers the following presets (you can also supply a custom regex):

| Preset | Pattern | Recursive | Description |
| --- | --- | --- | --- |
| Filename prefix | `^([^_]+)` | no | Run ID is everything before the first underscore. `RUN001_data.csv` → `RUN001`. |
| Top subdirectory | `^([^/]+)/` | yes | Run ID is the top-level subdirectory name. `RUN001/data.csv` → `RUN001`. |
| Deepest subdirectory | `([^/]+)/[^/]+$` | yes | Run ID is the immediate parent directory. `plate-a/well-b/data.csv` → `well-b`. |
| Timestamp subdirectory | `(?:^\|/)(\d{8}_\d{6}_\d{3})/` | yes | Run ID is a `YYYYMMDD_HHMMSS_fff`-shaped directory name anywhere in the path. |
| Filename stem | `^(?:.+/)?([^/]+?)\.[^/.]+$` | no | Each file is its own run. Run ID is the filename without its final extension. |

In YAML, prefer single-quoted strings for patterns so that backslash sequences like `\d` don't need escaping.

A config written by an older watcher used a single top-level `watcher_id`. It is migrated transparently on load: the value is lifted into `watcher_ids` under the active `environment`, and the legacy key is dropped on the next save.

### Switching environments

A single PC can move between `staging`, `production`, and `preview` and back. Because these are separate Data Hub deployments with separate databases, each holds its own watcher registration and its own API base URL — `watcher_ids` stores one id per environment, `api_base_urls` stores one URL per environment, and the credentials live in per-environment `~/.data-hub/.env.<environment>` files.

The first switch to an environment needs its URL via `--api-base-url`; later switches reuse the stored value, so you never re-enter it.

Switch with:

```sh
# First switch to an environment: provide its base URL (stored for next time).
uv run data-hub-watcher config set-environment staging \
  --api-base-url https://datahub-staging.example.com/api/v1

# Subsequent switches reuse the stored URL — no flag needed.
uv run data-hub-watcher config set-environment production \
  --api-base-url https://datahub.example.com/api/v1
uv run data-hub-watcher config set-environment staging
```

`config edit` also re-prompts for the environment and runs the same switch flow when it changes. Useful flags: `--api-key` (otherwise the key is read from the env file or prompted), `--show-key`, and `--no-register` (fail instead of registering a new watcher if none is stored for the target).

A switch validates the target API with the resolved key, reuses the stored `watcher_id` for that environment (or registers a new one), pushes the config to the target, and leaves a `watcher_stopped` breadcrumb in the old environment. The running `watch` process or Windows service keeps using the old environment until restarted — on Windows the service registry env path is rewritten and you must `service stop && service start`; elsewhere restart the `watch` process.

#### Initial scan and the backlog

Each environment keeps its own local state database (see [Local state](#local-state)), so switching never re-uploads files across environments. The first time an environment is entered — whether by `init` or by `config set-environment` — the initial scan mode decides what happens to files already sitting in the watch directory. It defaults by environment:

- `production` → `full`: the existing backlog is uploaded (production is the source of truth).
- `staging` / `preview` → `new-only`: the files already on disk when the environment is first entered are recorded as a baseline and skipped; only files created afterwards are uploaded.

This means a **fresh `init` on `staging` or `preview` does not upload the pre-existing backlog** — a deliberate guard so a test environment isn't flooded with a PC's entire history. Set `initial_scan: full` in the config to opt back in (e.g. to deliberately populate a staging environment), or `initial_scan: new-only` on production to suppress its backlog.

Upgrading an existing watcher is unaffected: the environment's database already carries upload/run history, so the one-shot baseline seeding is skipped and detection continues exactly as before. Switching a preview to a different deployment URL resets that environment's local state so the new target gets a clean baseline.

### Upload modes

- **`auto`**: Files are uploaded to S3 immediately after run detection. The upload worker also processes the queue, so a file whose upload failed can be requested again from the run page.
- **`manual`**: Runs are reported to the API without uploading. The server decides which files to upload via a queue, polled by the upload worker thread every 60 seconds. Useful when uploads need human approval.

Queued files are resolved against the current `watch_directory` (each queue entry carries a `relative_path` anchored to the root that was active when the file was detected). Two safeguards keep a stale queue entry from erroring forever:

- **On `watch_directory` change**: the server reverts every pending upload request for that instrument back to `detected` (clearing `upload_requested_at`) as soon as the new config is pushed, so the queue drains immediately. The reverted files remain re-requestable detections; an operator can queue them again from their new location.
- **Per-file 3-try cap (`MAX_QUEUE_FILE_ATTEMPTS`)**: a queued file that keeps failing — missing on disk or failing to upload — is retried on at most three upload-queue polls. After that the watcher cancels the request server-side (revert to `detected`) so the file leaves the queue instead of re-erroring each poll. The attempt count resets on watcher restart, so a transient outage longer than three polls is recovered on the next start. An upload cut off by a stop or a config rebuild isn't counted, so it can't use up the last attempt and cancel the request.

## Config revisions from the web app

From watcher 1.4.0, admins can edit a watcher's config in the web app. The server stores each change as a numbered config revision, and the watcher applies it without a restart. The code lives in `WatcherSupervisor` in `runtime.py`, with the validation and merge helpers in `remote_config.py`. The CLI `watch` command and the Windows service both run a `WatcherSupervisor`.

An admin can change these fields: `watch_directory`, `file_patterns`, `run_detection.pattern`, `run_detection.recursive`, `upload_mode`, `stability_period_seconds`, `max_stability_wait_seconds`, and `upload_parallelism`. The environment, API URLs, watcher IDs, `initial_scan`, the instrument ID and `enabled` always come from the file on the PC.

### The revision protocol

- Every heartbeat sends `config_revision`, the highest revision this watcher has applied.
- The heartbeat reply carries `config_revision`, the server's latest revision.
- If the reply's number is higher than the last revision this watcher has seen, the heartbeat thread signals the supervisor. "Seen" covers revisions the watcher applied, rejected, or found already resolved, so a rejected revision is never fetched again.
- The seen and applied numbers are stored with the watcher ID they belong to. If `init` registers a new watcher on a PC that keeps its state DB, they are dropped, because the new watcher's revisions start again at 1.
- The supervisor calls `GET /watchers/:id/config-revisions/latest`, which returns the pending revision if there is one, else the highest. A revision that isn't `pending` is only recorded as seen. It is also recorded as applied if its status is `applied` and its settings match the running config, as with a revision the server made from this watcher's own push.
- A pending revision is merged into the running config and checked with the same rules as the server. The watcher also checks that the folder exists and can be listed, which only the PC can do.
- If a check fails, the watcher posts `rejected` with the reason to `POST /watchers/:id/config-revisions/:revision/result`, logs a warning, and keeps running unchanged.
- If the checks pass, the watcher saves `config.yaml`, rebuilds its loops (below), posts `applied`, and pushes the new YAML through `PUT /watchers/:id/config` with `based_on_revision`.
- A revision whose settings the watcher already runs needs no rebuild. If `config.yaml` differs, as after `config edit` on a running PC (the watcher reads the file only at startup), the watcher still saves the revision over it, so a restart doesn't bring the edit back.
- The saved file keeps the folder exactly as the revision has it. The server treats different slashes, letter case and trailing separators as the same folder, but it can't tell that a path resolves elsewhere, such as a mapped drive that resolves to a UNC path, or a symlink. A push with the resolved form would be recorded as a new edit on the PC and as a folder move, which cancels pending upload requests. Loading the file resolves the folder again.
- A result the server didn't receive (no connection, a 5xx, or a reply the watcher couldn't read) is kept in `meta` and retried after each successful heartbeat, including after a restart. A 404 or 409 isn't retried.

After an offline conflict that the web change won, the server keeps the web revision pending and stores the PC's edit after it as a higher `superseded` revision. Heartbeat replies then announce the superseded number, but `…/latest` returns the pending web revision first, so the watcher applies that. The next fetch returns the superseded revision, which is only recorded as seen: the watcher never applies it or reports a result for it, and stops fetching.

Applying runs on the main thread, in `WatcherSupervisor.poll`, never on the heartbeat thread, because the rebuild has to stop and join the heartbeat.

### Startup sync

At startup the watcher pushes its config, if the checksum differs from the server's, with two extra fields:

- `based_on_revision`: the highest revision it had applied.
- `modified_at`: the config file's modification time.

The server uses them to settle a conflict between an edit made on the PC while offline and a pending web change. The newer one wins, and the other stays in the history. The watcher also records the checksum it pushed (`config_synced_checksum`) and logs when the file was edited on the PC since the last sync.

If the push reply's `config_revision` is higher than anything the watcher has seen, or if nothing was pushed, the watcher fetches the latest revision and applies it before the monitor starts. `config edit`, `config open` and `init` send `modified_at` on their pushes too.

### The in-process rebuild

Applying a revision doesn't restart the process:

1. The upload worker and the file monitor are stopped. They share the uploader's stop signal with auto-mode uploads and with the file and part threads those start, so no new file or part starts and the PUTs already sending finish. A file that didn't finish, such as a large file with parts left to send, keeps its `pending_uploads` row in auto mode or stays in the server's queue, because a rebuild sends no `stopped` heartbeat and the server cancels nothing. The new runtime uploads it again from the start: it retries `pending_uploads` rows when its config is in auto mode, and polls the queue in both modes. A revision that changes the folder drops both instead (see [Reporting newly matching files](#reporting-newly-matching-files)). Each thread waits for the threads it started, so once the worker and the monitor's stability checker have exited, no upload thread of the old runtime is left. The wait is capped at `CONFIG_APPLY_DRAIN_TIMEOUT_SECONDS` (120 s), or at `WATCH_FOLDER_GONE_DRAIN_TIMEOUT_SECONDS` (10 s) when the rebuild is the move to the waiting state because the watch folder disappeared. Past that, `Uploader.abort` cuts off the PUT bodies and hashing still in progress, each at its next read, and the rebuild keeps waiting, in 0.25 s steps, until those threads have exited. The old runtime's state DB is closed only then, so nothing writes to it after it closes, the new runtime never uploads next to the old one, and the new uploader has the whole new `upload_parallelism`. The move to the waiting state, and the rebuild of a runtime that can't see its watch folder, are the exception to the wait after the cut-off, because a thread blocked reading a hung share never sees it: they give up after `WATCH_FOLDER_GONE_JOIN_SECONDS`, keep that runtime's state DB open, and start the next runtime on that folder only once the threads have exited (see [The waiting state](#the-waiting-state)). Their waits also end on a stop.
2. The heartbeat is stopped. It sends no `stopped` status and no `watcher_stopped` event is queued, because the watcher never actually stops.
3. `build_runtime` and `start_runtime` run again with the new config. The new runtime shares the supervisor's event reporter, heartbeat counters and shutdown events, so queued events, heartbeat counts not yet sent and a pending auto-update restart carry over. It shares the supervisor's run of "deregistered" heartbeat replies too (see [A deregistered watcher](#a-deregistered-watcher)). If the third reply arrived while the old loops were stopping, nothing is built, and the watcher stops instead. The waiting state shares all of these too.

The post-upgrade marker check (`report_upgrade_outcome`) runs only for the first runtime or waiting state of a process, never on a rebuild. If the updater has just written a marker for the restart it requested, a rebuild would otherwise consume it, report a false failure, and delete the Windows worker's request sentinel before the worker reads it.

If anything fails after the old loops stop, the watcher writes the previous `config.yaml` back byte for byte, starts the previous config again, and reports the revision as `rejected`.

Before saving, the watcher re-reads the environment, watcher ID and instrument ID from `config.yaml`. If `config set-environment` switched the file to something else while the watcher was running, it rejects the revision instead of undoing the switch.

The Windows service still exits with code 1 for an auto-update restart and for a refused start-up, so the SCM recovery actions are unchanged for those. A deregistered watcher is the exception: the service returns normally, so it exits with 0 and the SCM leaves it stopped. See [A deregistered watcher](#a-deregistered-watcher).

### Reporting newly matching files

A revision can widen what the watcher sees: a new file pattern, recursion turned on, a new run-detection regex, or a new folder. The scan after such a change is a report-only scan. A file found by that scan is reported as detected without being uploaded when both of these are true:

- it isn't in `uploaded_files`, `detected_files` or `baseline_files`
- the old config wouldn't have reported it, and it was last modified before the change was applied

Admins upload these files with the existing **Request upload** buttons. Files written after the change, and files the old config also matched (such as a file that arrived during the rebuild), follow `upload_mode` as usual. So does a picked-out file that is written to again before it becomes stable, since its data is newer than the change. `FileMonitor` takes the `report_only` predicate and sends those files to `RunDetector.on_stable_file(path, upload=False)`. A report-only file never reaches the upload callback, even when later files in the same run upload.

The supervisor keeps each widening change's predicate for the life of the process and scans with all of them on every later rebuild. Otherwise a second revision that arrived before the first scan had reported every file would rebuild without the first predicate and upload those files. A predicate only matches files modified before its change that no state row covers, so keeping it doesn't affect anything already handled or written later.

State rows are keyed by the path relative to the watch folder, so after a folder change a file is still skipped if an old row has the same relative path, size and modification time. That only happens when the new folder holds a copy of the old one's files, where skipping them is what we want. `pending_uploads` rows are dropped on a folder change, though, because retrying them against the new folder could upload a different file that sits at the same relative path. The server also cancels pending upload requests when the folder changes.

### The waiting state

A missing or unreadable watch folder no longer stops the config from loading. `config validate`, `init` and `config edit` still report it, so an operator at the PC hears about it.

If the folder is missing or unreadable at startup, the watcher starts in the waiting state:

- Only the heartbeat and the auto-updater run. Heartbeats send `status: "waiting"` with a `status_reason` such as `watch_directory not found: D:\Exports`.
- The watcher queues a `watch_directory_unavailable` error event.
- On each heartbeat tick it checks the folder again and starts watching once the folder can be listed.
- A config revision can also fix the folder. The waiting heartbeat checks for revisions like the normal one.

A watcher that is already watching moves to the waiting state when its folder disappears (watcher 1.4.3), for example when a network drive drops or the folder is deleted:

- Every heartbeat tick of a running runtime, watchdog's report that the watch folder itself was deleted (`FileMonitor`'s `on_watch_root_gone`; a delete inside the folder is ignored), and an upload thread whose look at the folder, made because it can't find a file (see below), finds the folder itself unavailable, call `WatcherSupervisor._request_folder_check`. It sets `_folder_check_due` and wakes the `poll` thread, the way the waiting state's tick does, so the check and the move run on the `poll` thread and never on the heartbeat, watchdog or upload thread. `poll` clears the flag before it checks, so a tick during a check asks for another. The flag is a `threading.Event`, so setting it from another thread needs no lock. Whether watchdog 6.0.0 reports a root delete, and how soon, depends on the platform, and no emitter reports a root move, so the handler's `on_moved` for the root is never called there. It is kept in case a later release does. A folder that is renamed is found by its identity (below), not by a report.
- The look at the folder is `FolderProbe`'s. `watch_directory_problem` stats and lists the folder, which on a share that has hung can block for the SMB timeout (about a minute on Windows) or, on a hard NFS mount, for good. The `poll` thread is the one that sees a stop, so the look runs on a daemon thread that is waited for `FOLDER_PROBE_TIMEOUT_SECONDS` (10 s). A look that takes longer is a problem, "watch_directory not responding: <path>", and its thread is left to finish. While it is still running, no further look starts another: they wait for the same one, so a share that stays hung costs one blocked thread. The waiting state's check and the start of a runtime use the same bounded look. `FolderProbe.look` takes a `should_cancel` callable, which the supervisor's checks and the uploader pass, and waits for the look in steps of 0.1 s: a stop ends the wait within that, the look says `None`, and the caller does nothing (it leaves the runtime, the waiting state and the backoff as they are, and the poll loop then sees the stop). The look itself carries on in its thread, for whoever asks next.
- One failed look is not enough (`_check_running_folder`). A second look `FOLDER_CONFIRM_DELAY_SECONDS` (3 s) later has to find a problem too, and its reason is the one reported. A share that drops for a moment costs the watcher nothing: no upload is cut off, and no start-up scan follows. On Windows a folder that was just deleted is "delete pending": it can still be statted but can't be listed, so the first look can read "not readable" where the second reads "not found", and only the second is reported, with one `watch_directory_unavailable` event. The wait for the second look ends at once on a stop, and so does the second look, and the stop is checked again before the move. With the heartbeat's tick of 60 s, the move begins about a minute and 3 s at most after the folder went away (a look at a hung share adds up to 10 s each, so up to 83 s). The move itself takes no time when nothing is blocked. On a dead share it takes up to 31 s, with each wait at its limit: 10 s of drain, 5 s for the observer's stop and 1 s for the stability checker, 5 s for the threads after the cut-off, 5 s for a heartbeat tick, and 5 s to flush the queued events. It ends with the first heartbeat of the waiting state, which has only the client's HTTP timeouts. The watcher starts again at a tick after the folder is back (at most a minute later), with a new runtime and a start-up scan.
- On a confirmed problem the runtime is torn down as for a config rebuild (see [The in-process rebuild](#the-in-process-rebuild)), but with the waits below bounded, and the watcher enters the waiting state with the problem as its reason. It logs one warning that names the reason and queues the `watch_directory_unavailable` error. It queues no `watcher_started` event, because the watcher has not stopped (`_enter_waiting` is given no started message). The next heartbeat says `waiting`, with the reason. What the move includes, in order, each with the limit it has:
  1. Uploads in progress get `WATCH_FOLDER_GONE_DRAIN_TIMEOUT_SECONDS` (10 s) to finish, not the 120 s of a config rebuild. Every part of a large file opens the file again, so once the folder is gone the parts that have not started can't be read, and waiting longer would only keep the watcher reporting `watching` with its folder missing.
  2. The file monitor's observer is stopped on its own thread, and the stop and the observer's thread are waited for together for at most `WATCH_FOLDER_GONE_JOIN_SECONDS` (5 s), because watchdog's `Observer.stop()` has no timeout of its own.
  3. Uploads still running after the drain are cut off (`Uploader.abort`), and their threads are waited for `WATCH_FOLDER_GONE_JOIN_SECONDS` more. A thread that is blocked reading the dead share doesn't see the cut-off, so it can still be running then. It is left behind: the runtime goes to `WatcherSupervisor._cut_off` with the folder it was on, and with its state DB open, because a thread that is still running may write to it. A rebuild of a runtime that is running, for a config change, waits for such a thread without limit instead. The log says what is left: the upload threads, which are probably blocked on the share, or only a heartbeat tick, which is probably blocked on Data Hub.
  4. The heartbeat loop is stopped and its tick in progress waited for `WATCH_FOLDER_GONE_JOIN_SECONDS` (`HeartbeatLoop.stop_loop` returns whether the thread has exited). A tick that outlasts that is left behind too, and the runtime is kept like the one in the step before.
  5. The queued events are flushed, with a deadline of `WATCH_FOLDER_GONE_JOIN_SECONDS`.
  6. The waiting state starts: its `HeartbeatLoop.start` sends the first heartbeat and flushes the events before it returns, and that has only the client's HTTP timeouts, no limit of the move's own.

  Every wait in steps 1 to 4 is in steps of at most 0.25 s (`_wait_for`), and a stop ends it (`_stop_upload_threads` and the observer's stop take the supervisor's stop as `should_stop`, and the observer's stop as `should_cancel`). The move then stops where it is: it returns without entering the waiting state, with the runtime still in `WatcherSupervisor.rt`, partly stopped, and `stop` stops it the usual way (steps 1 to 7 of [How long a stop takes](#how-long-a-stop-takes), which cut the uploads off within their own budget and are harmless for what the move already stopped). The move doesn't start at all when a stop was requested before it begins. The flush in step 5 is skipped on a stop, and the events stay queued for the stop's own flush.

  A file that is cut off keeps its `pending_uploads` row, or its place in the server's queue, and the next runtime uploads it again, unless a config revision that changes the watch folder drops it first (`_forget_old_folder_uploads`).
- A runtime does not start next to a thread that was left behind on the same folder. While the folder is back but `_cut_off` still holds a runtime of that folder whose threads are running, `_check_waiting_folder` changes the waiting reason to `uploads stuck on <folder> have not ended`, in place of the "not found" or "not responding" it still showed, and waits for a later tick. The heartbeat carries the new reason, and one error event reports it. `_reap_cut_off` closes the state DB of each runtime whose threads have exited. It only looks at the threads and logs nothing (`FileMonitor.has_exited`, `UploadQueueWorker.has_exited` and `HeartbeatLoop.has_exited`, where `FileMonitor.join` logs "FileMonitor stopped" at every call), because it runs at every check and in every step of a wait. A start that follows a rebuild instead of a tick (`_start_watching_or_wait`) checks the same thing and enters the waiting state with that reason.
- A config change that comes with threads left behind on its folder is applied as follows (`_apply`). When the revision changes the watch folder, there is nothing to wait for: the threads can't touch the new folder, and `_forget_old_folder_uploads` drops the `pending_uploads` rows they would have retried. The new runtime starts, and the old one stays in `_cut_off` until its threads have exited, which `_check_running_folder` notices. When the folder stays the same, the rebuild waits for the threads for `CONFIG_APPLY_DRAIN_TIMEOUT_SECONDS` (120 s), logs every `_CUT_OFF_LOG_INTERVAL_SECONDS` (60 s) that it still waits, and ends the wait on a stop. If they are still there after that, the config is applied and saved all the same and the start waits, with the reason above, for a later tick.
- Before the supervisor moves, the uploader asks whether the folder is gone. Between the folder disappearing and the check, every file in it looks missing, so the upload worker would drop each `pending_uploads` row (`_drop_missing_pending`, for good: the file is then not uploaded after the folder returns) and count a "Queued file missing" attempt toward `MAX_QUEUE_FILE_ATTEMPTS` for each requested file. The `Uploader` is given a `watch_folder_unavailable` callback, built by `build_runtime` from the supervisor's `FolderProbe`. Before it drops a row, counts a missing attempt, or counts an upload that failed as an attempt, it calls it. When the folder is gone or not answering, nothing is dropped, queued as an error or counted, the row or queue entry stays, and the callback asks the supervisor for a folder check at once. During a stop the uploader doesn't look at all (`Uploader._folder_is_gone` says yes first when a stop was requested): a stop is not a missing file either, the look has a limit of its own that `abort` can't cut short, and an upload thread in it would hold the stop up. A look that was cancelled by a stop (the callback is given the stop of the uploader and of the supervisor) says the same, without asking for a check. A file that is really gone stays until the next start, which drops it then.
- Resuming is the existing path: `_check_waiting_folder` starts a new runtime on a tick once the folder can be listed, and a `watcher_started` event says the watcher resumed.
- A folder that is there can still leave the watcher blind, in two ways, and the runtime is then rebuilt with a `watcher_started` event that says it resumed. The rebuild has the 120 s drain of a config rebuild, and then the bounded waits of the move (the cut-off, the observer, the heartbeat tick, the `_cut_off` gating and the stop), because the identity can change while upload threads are blocked on the old, hung filesystem (`umount -l` of a hung NFS mount, a DFS failover). First, watchdog's emitter stops itself when its folder is deleted, and a folder created again at the same path is not watched: `FileMonitor.is_watching()` (the observer and its emitters are alive) says so. Second, the folder is not the one the runtime started on, which watchdog 6.0.0's inotify emitter doesn't report (it ignores IN_MOVE_SELF, so after `mv data data.old && mkdir data` it watches the renamed folder), and nothing reports for a mount point that was unmounted and is an empty folder again, or for a folder that Explorer moved to the Recycle Bin and that was created again. The supervisor records the folder's `(st_dev, st_ino)` from the look that found it fit to watch, before the scan, and compares it at each check; a mismatch is a rebuild, and the warning gives both values. An inode number of 0, which some SMB servers report for everything, is ignored.
- A runtime that keeps going blind is not rebuilt at every check, and what the watcher does instead depends on which of the two it is. The first time it is rebuilt. If the rebuilt runtime goes blind again before it has watched for `MONITOR_RESTART_WINDOW_SECONDS` (2 minutes):
  - When watchdog has stopped watching (`FileMonitor.is_watching()` is false), the folder can't be watched. An emitter can die as soon as it starts with the folder fine: on `ReadDirectoryChangesW` returning `ERROR_INVALID_FUNCTION`, as on VirtualBox shared folders, the Windows NFS client or WinFsp and Dokan mounts, watchdog emits a root delete event and stops. The watcher doesn't rebuild again: it tears the runtime down as for a rebuild and enters the waiting state with the reason `watch_directory can't be watched: <path>`, queues the error event once and no `watcher_started`. It starts again on the waiting state's backoff (`_next_start_attempt`): one heartbeat interval after the first such wait, then twice as long each time, up to `WAITING_START_RETRY_MAX_SECONDS`.
  - When watchdog is still watching and only the folder's identity differs, the filesystem doesn't give the folder an identity that lasts (FUSE mounts without `use_ino`, on macOS especially, and SMB or virtual drives without persistent file IDs report a new number at every look), and live uploads must not stop for that. The waiting state is only for the first kind. The watcher keeps the runtime, logs both identities once, and stops comparing the identity (`_identity_untrusted`, `_watch_identity` is `None`) until the next config change or restart. A folder that is really swapped after that is found by watchdog's own report, or by the next restart. A monitor that has stopped watching takes priority over an identity that changed, in the same check.

  `_blind_rebuilds` counts the rebuilds, and goes back to 0 once a runtime has watched for the window, when the folder goes away (a "not found", or a second problem in a row while waiting), and on a config revision.
- A rebuild whose start fails, or whose folder is gone when it starts, falls back to the waiting state without a `watcher_started` event (`already_started`), because nothing resumed.
- A stop that arrives during a folder check ends it (watcher 1.4.3). Every wait the `poll` thread makes for it reads the stop: the look at the folder (`FolderProbe.look` with the supervisor's `_stopping`), the wait before the second look, the second look, the move's drain, the waits after the cut-off, the observer's stop and the wait for the heartbeat tick, and so do the same waits of a blind rebuild and the wait for threads left behind. The checks also look at the stop after each look and before each teardown, and a check that finds a stop leaves the runtime to `stop`, which cuts its uploads off within its own budget. What a stop can't end is a request in flight, the flush of the move (5 s at most) and the first heartbeat of the waiting state (see [What the limit doesn't cover](#what-the-limit-doesnt-cover)), and a look that starts a runtime. The `poll` loop returns within about a second otherwise.
- A watcher whose registration was deleted on Data Hub does none of this. Its folder checks end at once, and it builds no runtime and no waiting loop, because the stop that follows has nothing to report to (see [A deregistered watcher](#a-deregistered-watcher)).

The watcher also waits, with a `status_reason` such as `could not start watching: …`, when the folder is there but starting fails. It then tries again after about 1, 2, 4 and 8 minutes, then every 15 minutes (`WAITING_START_RETRY_MAX_SECONDS`), and at once if the folder goes away and comes back. Events are queued only when waiting starts (`watcher_started` and the error) and when the reason changes (the error only). A retry that fails the same way logs one line and queues nothing, and a retry that succeeds queues a `watcher_started` event saying the watcher resumed.

While it waits, each check says what is wrong now: a look that finds a problem becomes the reason, and a look that finds nothing wrong puts back the reason the wait was entered with, when the wait is not over (a backoff, or threads left behind). The backoff of a start that keeps failing, and the count of a runtime that keeps going blind, are cleared when the folder is "not found", or when two looks in a row find a problem, so the first start after the folder is back isn't held up. One "not responding" on a share that is slow once doesn't clear them.

The waiting state replaces the old behavior of exiting at startup, which made the Windows service restart in a loop.

### Settings Data Hub can't read

The server reads the editable settings out of each pushed `config.yaml` with the same rules it applies to web edits. The watcher runs some configs those rules refuse: more than 50 file patterns, a pattern longer than 200 characters, or a Python-style named group such as `(?P<run>…)` in the run regex. For such a config the server records no revision for edits made on the PC, and the web app shows a notice on the Configuration tab naming the setting it can't read. `init` and `config edit` refuse those values, `config validate` warns about them without failing, and the watcher logs a warning at startup. Existing configs still load.

### Older servers

The new request fields are ignored by servers that don't know them. A server without config revisions leaves `config_revision` out of its replies, so the watcher never fetches anything. A 404 from a config-revision endpoint means either no revisions yet or an older server. Either way there is nothing to apply, and it is logged once per process. An older server rejects the `waiting` heartbeat status, so a waiting watcher shows as offline there.

## Local state

The watcher maintains one SQLite database per environment at `~/.data-hub/watcher-<environment>.db` (e.g. `watcher-production.db`). `watch` and `upload` use that folder even when started with `--config`. The Windows service keeps the database beside the config file stored in its registry key instead; `state_db_dir` in `constants.py` holds both rules. Isolating state per environment is what lets a PC switch back and forth without one environment's uploads being recorded against another. A pre-multi-environment `~/.data-hub/watcher.db` is renamed to the active environment's file on first start. Each database has the following tables:

- `uploaded_files` — one row per successful S3 upload, keyed on `(filename, sha256, s3_key)`. Used by the uploader to skip re-uploads on retry and by the initial scan to skip files that have already been sent. Records older than 90 days are pruned automatically.
- `runs` — tracks which run IDs have been reported and (in auto mode) when their files finished uploading. The most recent `reported_at` timestamp is what the auto-updater consults to gate restarts on a quiet-instrument window.
- `detected_files` — the file manifest for every reported run, keyed on `(run_id, relative_path)`. Lets the initial scan skip files that are already part of a reported run even in manual mode (where `uploaded_files` stays empty), and lets the run detector hydrate its in-memory state on startup so a restart doesn't re-POST runs the API has already seen.
- `baseline_files` — files that already existed on disk when a `new-only` environment was first entered, keyed on `relative_path`. A baseline row means "skip" (never uploaded), as opposed to `uploaded_files` which means "sent". Unlike `uploaded_files`, baseline rows are never pruned. Empty in `full`-scan (production) environments.
- `pending_uploads` — auto-mode uploads that have not succeeded yet, keyed on `relative_path`. A row is added in the transaction that records the accepted run report and its `detected_files` rows (from 1.4.1; before that, a separate write when the run detector handed the file to the uploader), so an auto-mode file is never recorded as reported without one. Files reported without upload (the report-only rescan after a config change) never get a row, and neither does anything in manual mode. A row is removed when the file is uploaded by any path. On startup the upload worker retries every row once. Each start counts as one attempt, including a retry that raised an unexpected error; after `MAX_PENDING_UPLOAD_ATTEMPTS` (3) the row is dropped with an `upload_retries_exhausted` event. A file that can't be read yet isn't an attempt (from 1.4.2): its row keeps its count, and the upload worker tries the file again on every poll (see **Uploader** above). A row whose file is no longer on disk is dropped with a `pending_upload_missing` event. `detected_files` can't serve this purpose: hydration treats every reported file as handled, and `uploaded_files` is pruned while `detected_files` is not, so "detected but not uploaded" would also match every file uploaded more than 90 days ago.
- `pending_events` — events the watcher queued that the server hasn't taken yet (from 1.4.3), tagged with the watcher ID, and sent after a restart if the process was killed first. See [Saved events](#saved-events). A watcher that registered again on the same PC keeps the file, and its predecessor's rows are deleted at start. Rows are deleted as soon as the server has the events. An older watcher ignores the table.
- `meta` — a small key/value store. Holds the preview deployment URL the database was seeded against, so the watcher can reset local state when a preview is redeployed to a new URL. From 1.4.0 it also holds the config revision bookkeeping described in [Config revisions from the web app](#config-revisions-from-the-web-app): `config_revision_seen`, `config_revision_applied`, `config_synced_checksum`, and `config_revision_unsent_result`, plus `config_revision_watcher_id`, the watcher those belong to.

Logs are written to `C:\ProgramData\DataHubWatcher\watcher.log` on Windows and `~/.data-hub/watcher.log` on macOS/Linux (10 MB rotating, 5 backups). Both the CLI `watch` command and the Windows service write to the same file so a single `Get-Content -Wait` (or `tail -F`) covers all entry points.

The Windows service also writes to the Application event log, but only warnings, errors and its own lifecycle lines (starting, running, stopped). The INFO lines the other modules write for each file stay in `watcher.log`, so a run of thousands of files can't fill the Application log and push out older warnings and errors.

`DATA_HUB_WATCHER_LOG_LEVEL` sets the root log level. The service applies it a second time after it loads its registered env file (1.4.2), so a value set there counts. The service's own logger keeps INFO when the level is WARNING or ERROR, so its lifecycle lines stay in `watcher.log` and the Event Log. The `urllib3` logger stays at INFO or above whatever the root level is, `--verbose` included, because at DEBUG it logs every request URL and an upload goes to a pre-signed S3 URL.

When the service can't load its env file or its config, whatever the reason (a file that isn't UTF-8, for example, as Windows PowerShell 5.1 writes with `>` and `>>`), it logs one error that names the file and exits with `SystemExit(1)` like the other start-up refusals. The exception doesn't escape `SvcRun`.

### Initial scan identity

When the watcher starts it walks the watch directory to catch files that arrived while it was stopped. Identity for "have I already uploaded this?" is `(relative_path, size, mtime)` rather than a full-content hash — this keeps startup fast even on directories holding hundreds of GB of instrument output. Content integrity is still verified at upload time: the uploader computes a SHA-256 on every file it PUTs to S3 and records it alongside the upload.

The relative path is the file's location relative to the watch directory (e.g. `run-2026-04-17/sample-a/output.nd2`), not just the basename. This matters in recursive watches where two runs might both emit files with the same name — they're disambiguated by subdirectory.

Practical consequences:

- Instrument output files are write-once, so the cheap stat-based check is effectively as strong as a hash in normal operation.
- If an external tool (antivirus, OneDrive/Dropbox sync, backup restore) rewrites a file's mtime without changing its contents, the watcher will re-enqueue it. The server-side dedup (keyed on SHA-256) prevents a duplicate S3 object.
- If a run's parent folder is renamed or moved, its files look "new" to the next scan and will be re-enqueued. The uploader's own SHA-based dedup prevents a redundant S3 PUT, but it will pay the cost of hashing each affected file once.
- Upgrading from a pre-`relative_path`/`size_bytes`/`mtime` state DB is a silent, self-healing migration: legacy rows miss the stat lookup, so files are re-enqueued once and then recorded with full stat data on their next upload.

In a `new-only` environment (staging/preview by default — see [Switching environments](#switching-environments)), the first start also seeds `baseline_files` with everything currently on disk so the historical backlog is skipped rather than uploaded. The seeding is one-shot: it only runs when the environment's database has no upload, run, or baseline history yet.

### Forgetting a folder

`data-hub-watcher state forget --prefix alice/` deletes the `uploaded_files`, `detected_files`, `baseline_files`, and `pending_uploads` rows whose path is that folder or sits inside it. The next start reports those files again. Stop the watcher first: a running process does not rescan until it starts. Names that merely begin with the same letters (`alice_notes/`) are left alone; the match is not a `LIKE` pattern, because `_` would otherwise match any character.

Because `watch` and the Windows service keep state in different folders, the command clears every state database a watcher on the PC can open: the one in `~/.data-hub`, the one beside the `--config` file, and on Windows the one beside the installed service's config. It lists the databases it found before asking to continue, then prints the rows removed from each. It refuses to run when none exists, and it prints the paths it looked for. When the prefix matches nothing, it warns: paths are case-sensitive and relative to the watch directory.

This is how a file the watcher already marked as uploaded gets a second chance after the server learns to keep same-named files from different folders.

### Adding a server behavior that needs a newer watcher

1. Ship the watcher change and bump `[project].version` in `watcher/pyproject.toml`.
2. Add the feature to `WATCHER_FEATURES` in `web/lib/api/watcher-compat.ts`, mapped to that version.
3. In the route, call `watcherClientFrom(request).supports("…")` and keep the previous behavior in the other branch.
4. Delete the feature entry and the old branch once `watcher_release_config.min_supported_version` reaches that version. Heartbeats already turn away every older watcher then.

A missing or unreadable version always takes the old branch. That is the opposite of the heartbeat floor check, which lets an unreadable version through rather than locking a lab PC out.

## Observability

The watcher's primary observability surface is the per-watcher event log served by `POST /watchers/:id/events`. Events are queued by the long-running components (uploader, run detector, monitor, heartbeat, updater) and flushed in batches of at most 100 on every heartbeat tick. From 1.4.3 each queued event is also saved in the state DB until the server has it (see [Saved events](#saved-events)). The queue is bounded to 500 events; on overflow the oldest are dropped (FIFO) and surfaced via a synthetic `events_dropped` event prepended to the next successful flush, so an outage that loses observability data is itself observable when the link recovers.

### Event types

| Event type | When |
| --- | --- |
| `watcher_started` / `watcher_stopped` | Process lifecycle. The stopped message distinguishes a normal stop from an upgrade-driven restart and, from 1.4.1, from the Windows service stopping because Windows is shutting down (`Service stopped: Windows is shutting down`). `watcher_stopped` is also emitted in the *old* environment as a breadcrumb when the watcher switches environments. |
| `config_synced` | Local config differed from the remote checksum and was pushed. Triggered by `init`, `config edit`, `config open`, on watcher startup, and after applying a config revision (`trigger=config_revision`). The server writes one with `details.kind="config_revision_applied"` when the watcher reports a revision as applied; a rejected revision becomes an `error` event with `details.kind="config_revision_rejected"`, also written by the server. The server also emits one with `details.kind="upload_requests_cancelled"` (and `cancelled_count`) when a `watch_directory` change drained pending upload requests. |
| `run_reported` | A run was POSTed to the API for the first time. |
| `file_uploaded` / `upload_failed` | Per-file upload outcome. `file_uploaded` details carry `s3_key` and `sha256` and, from 1.3.0, `size_bytes`, `prep_seconds` (hashing and the upload-URL request, which run together, or one after the other for a file that was found unreadable before, from 1.4.2), `upload_seconds` (from the first upload slot taken until the single PUT succeeds or the multipart complete call returns, so later waits for a slot and retry backoff count), and `part_count` (1 for a single PUT). `upload_failed` carries the S3 key and last error. From 1.4.2 `upload_failed` is also queued, once per file, when a file can't be read yet (see **Uploader** above): the message reads `Can't read scan.csv yet (Permission denied). Trying again on each upload poll.` (on Windows, the reason is the OS's text for the sharing violation), and `details` carry `error` (the OS error text), `will_retry: true`, `relative_path`, `run_id` and, for a requested file, `file_id`. The event for the upload itself follows once the file goes through. |
| `upload_requests_cancelled` | The server writes this one, never the watcher, and `POST /watchers/:id/events` rejects it. A run was deleted while some of its files waited in the upload queue, so the server reverted them to `detected`. It goes on the instrument's active watcher, and none is written when the instrument has no active watcher. `details` is `{kind: "upload_requests_cancelled", reason: "run_deleted", run_id, cancelled_count}`. Only run deletion uses this type. The other server-side cancellations keep theirs: a watcher stop or removal and an instrument retirement write `watcher_stopped`, the offline sweep writes `error`, and a `watch_directory` change writes `config_synced`. All of them put `kind: "upload_requests_cancelled"` in `details`. |
| `update_started` / `update_succeeded` / `update_failed` | Auto-update lifecycle. `update_succeeded` is emitted from the *next* process startup once the new version is confirmed to be loaded. |
| `error` | Generic bucket; use `details.kind` to discriminate (table below). |

### Error kinds

`error` events use a `details.kind` discriminator so new failure modes can be added without a database migration. Known kinds:

| Kind | Meaning |
| --- | --- |
| `run_report_failed` | POST/PATCH against `/instruments/:id/runs[/:run_id]` failed. Emitted for the first of a row of retried failures, including ones from new files in the run, and for every 4xx because it is not retried. `details` includes `operation`, `status_code` (0 when no HTTP status came back), `file_count`. |
| `config_sync_failed` | The startup `PUT /watchers/:id/config` (or its checksum probe) failed. |
| `stability_timeout` | A file kept changing past the configured max wait (default 5 minutes) and was abandoned. `details.max_wait_seconds` reports the cap used. |
| `stable_callback_failed` | The on-stable-file callback raised. |
| `state_write_failed` | The server accepted a run report, but writing it to the state database failed (a full disk, say). The watcher retries the write, and uploads nothing and sends nothing more for that run until it works. Emitted for the first of a row of failed writes for a run. `details` includes `run_id`, `error`, `file_count`. |
| `pattern_mismatch` | A file inside the watch tree did not match `run_detection.pattern`. Throttled to one emission per parent directory per process. |
| `events_dropped` | Synthetic event prepended after events were dropped: the oldest ones when the queue is past its cap, a batch that the server refused (a 4xx), a saved batch that failed three flushes in a way that may have reached the server (a 500 or a read timeout), or a batch that wasn't saved and couldn't be sent. `details.dropped_count` reports the gap size. |
| `heartbeat_recovered` | First successful heartbeat after one or more consecutive failures. `details.gap_seconds` reports the outage length. |
| `upload_queue_poll_failed` | `GET /watchers/:id/upload-queue` failed. Emitted on the 1st failure and every 10th repeat. |
| `queued_file_missing` | A queued file was not found on disk at its resolved path. Emitted once per file (throttled across polls). `details` includes `file_id`, `expected_path`. |
| `upload_request_cancelled` | The watcher gave up on a queued file after `MAX_QUEUE_FILE_ATTEMPTS` failed polls (missing or upload error) and reverted it to `detected` server-side. `details` includes `file_id`, `attempts`, `reason`. |
| `upload_retries_exhausted` | An auto-mode upload still failed after `MAX_PENDING_UPLOAD_ATTEMPTS` watcher starts and is no longer retried. It can still be requested from the run page. `details` includes `relative_path`, `run_id`, `attempts`. |
| `pending_upload_missing` | An auto-mode upload waiting for a retry was no longer on disk when the watcher started, so the retry was dropped. `details` includes `relative_path`, `run_id`. |
| `update_check_failed` | `GET /watchers/:id/update-check` failed for 3 consecutive attempts (~3 hours of going dark on the update channel). |
| `watch_directory_unavailable` | The watch folder was missing, unreadable, not answering (`watch_directory not responding`) or can't be watched (`watch_directory can't be watched`), so the watcher entered the [waiting state](#the-waiting-state), at startup or, from 1.4.3, while it was running. `details` includes `watch_directory`, `reason`. |

### File timestamps

Each file's on-disk creation time (`st_birthtime` where the OS provides it, otherwise `st_mtime`) is captured at stabilization, persisted in `detected_files`, and sent to the API on every run report and presigned-URL request. This lets the dashboard order events by when the instrument actually wrote the file rather than when the watcher uploaded it — useful when an initial scan or backfill uploads files long after their original write time.

### Saved events

Watchers before 1.4.3 kept the event queue in memory only, so the events queued when the watcher was killed were lost. From 1.4.3 the supervisor's `EventReporter` also saves each event in the state DB's `pending_events` table (`id`, `watcher_id`, the event as JSON, `created_at`) until the server has taken it.

- **One list.** The in-memory queue is still the one list of what waits to be sent, and each entry knows its row. Adding an event, dropping the oldest to stay within the 500-event cap, a batch the server took and a batch that is given up on each update the queue and the rows together, under the reporter's lock. The table is read only when it is attached, so the two don't drift apart: the rows are the entries that are saved. An event whose write fails (a full disk, say) is logged and stays in the queue, so this process still sends it; a row that can't be deleted is sent again after the next start. Events are queued from many threads, each with its own connection, and every write takes the state DB's write lock.
- **Attach and detach.** `WatcherSupervisor.start` attaches its own state DB (`attach_store`) right after it opens it, before anything queues an event. The saved events of an earlier process join the front of the queue and go out with the first flush, which is the start-up heartbeat's. Events saved under another watcher ID are deleted, because one DB file can serve a watcher that registered again, as with the config revision keys. A row this version can't read, such as an event type from a newer version, is deleted. `WatcherSupervisor.stop` detaches the DB (`detach_store`) before it closes it, so an event queued after that, such as one from a heartbeat tick that was left running, stays in memory and doesn't open the closed DB again. What is saved and not yet sent stays in the table for the next start, and leaves the queue so this process doesn't send it as well. A flush that a tick was running when the stop began holds the flush lock and has its batch in flight, and can delete the batch's rows only while the DB is attached. So before it detaches, the stop waits for that lock, for at most `STOP_FLUSH_WAIT_SECONDS` (2 s) and never past the stop's own limit, and holds it through the detach: a flush that ends in time has deleted its rows before the DB is detached. If the stop's budget is already used up (a server that answers slowly leaves the final heartbeat all of it), the wait is zero.
- **Which reporters save.** The supervisor's does, and so does everything that uses it: the runtimes it rebuilds and the waiting state. The reporters of the environment switch and of the `upload` command don't attach a DB and keep their events in memory. `upload` can run while the watcher is running and has the same file open, and two processes that each sent the saved events would send them twice.
- **A deregistered watcher.** The stop of a watcher whose registration was deleted sends nothing (see [A deregistered watcher](#a-deregistered-watcher)), so the events still saved stay in the table. `detach_store` sends nothing either: it only waits for a flush that is already running. The next start after `init` has given the PC a new watcher ID deletes those rows with the others saved under another ID, and a watcher that came back under the same ID would send them. Before the third reply, the heartbeat ticks still flush, and the server answers a deregistered watcher's events with a 404, which drops those batches as any 4xx does (see **A batch that fails** below).
- **Batches.** `flush` sends the oldest events first, at most 100 per request (`MAX_EVENTS_PER_REQUEST`, the server's `max(100)`), the `events_dropped` event included, and keeps going until what was queued when it began has been sent or a request fails. A batch is deleted once the server has answered with a 2xx. Each batch gets the usual retries and the deadline, with what is retried as the next item describes. Only one flush runs at a time, so a tick left running by a stop and the stop's own flush never send the same events.
- **A batch that fails.** What happens to a saved batch depends on how its request failed.
  - Nothing reached the server: a connection error that isn't a read timeout (status 0), or a 502, 503 or 504. The batch stays queued and in the table, and every later flush sends it again, for as long as it takes. Nothing was stored, so no number of retries can store it twice.
  - It may have reached the server: a 500 or any other 5xx, or a read timeout. The batch stays queued and in the table, but each of its events counts the flush as failed (`_Queued.failed_flushes`, in memory only), and an event that has been in `MAX_FAILED_FLUSHES` (3) failed flushes is dropped and counted in `events_dropped`, as 1.4.2 did after one. Without the limit, a batch that the server fails on every time would sit in front of every later event, and be loaded again at every start. The events route inserts `details` as `jsonb`, and Postgres refuses `\u0000` and a lone UTF-16 surrogate (from a Windows file name, say), which the route answers with an unhandled 500. A failure that reached nothing doesn't count, and doesn't reset the count either. A restart starts the count again, so such a batch is dropped by the third failed flush of the process that loaded it. The batch isn't split to find the bad event: three failed flushes can't isolate one event among 100, so everything in the failing request goes, as it did in 1.4.2.
  - Anything else is dropped and counted at once: a batch that isn't saved, a 4xx (the server validates the whole batch, so one event it refuses would otherwise stay in front of every later one for good) and an error after a 2xx (the server stored it).

  The retries inside a flush follow the same line. A connection error, a read timeout and a 5xx are retried (3 attempts, waiting 1 s and 2 s, and only after something other than a read timeout when the flush has a deadline), and a 4xx or an error after a 2xx is sent once, because it would fail again or the server has the batch. A queue past the cap still drops the oldest events, rows included.
- **Duplicates.** The events route has no de-duplication, so an event is stored twice only when a request that the server stored was not taken as done. These are the cases, and how many copies each can make:
  - A kill between the server's 2xx and the delete of the rows, or a delete that fails: the batch is sent once more after the restart.
  - A read timeout on a request that the server did store, in a flush without a deadline: the flush sends the batch 3 times, and the batch stays for 3 failed flushes, so up to 9 copies are stored before it is dropped. A flush with a deadline, such as the stop's, sends it once after a read timeout, and the batch is sent again after the restart, where the count starts again from zero and up to 9 more copies can follow. This needs a server that stores a batch and then takes longer than 30 s (3 s at a Windows shutdown) to answer, every time.
  - A flush that a tick left running at a stop, which is still running when `detach_store`'s wait ends: it can no longer delete its rows, and if the server then takes its batch, the next start sends it once more. A flush that ends within the wait doesn't do this.

  A request that fails with a 500 from the events route stores nothing: the route inserts the batch in one statement. The watcher can't tell that from a 500 that something in front of the route sent after the route had stored the batch, so a 500 is counted like a read timeout.
- **Costs.** The reporter's lock is held across each SQLite write. A write waits for the state DB's write lock, which the run detector's transaction and the upload bookkeeping take too, and when another process has the file open (the `upload` command can) it waits for SQLite's busy timeout, 5 s, before it fails. Every thread that queues an event, and a flush's short look at the queue, waits for all of that, so a long write on the runtime's own `StateDB` can stall the producers of events for up to 5 s. And the start-up flush sends what earlier processes saved, up to 500 events in 5 requests of 100, before the initial scan. It has no deadline and a stop can't cut it short (see [What the limit doesn't cover](#what-the-limit-doesnt-cover)), so against a server that answers slowly it delays start-up by up to the client's timeouts for each request, 5 s to connect and 30 s to read, and it ends at the first batch that fails.

### Heartbeat counts

The payload's `files_uploaded_since_last_heartbeat`, `runs_reported_since_last_heartbeat` and `errors_since_last_heartbeat` come from `WatcherCounters`. The supervisor owns one and gives it to every runtime and to the waiting state, so counts a rebuild or a pause for the watch folder caught between two heartbeats go out with the next one.

The uploader and the run detector count through its methods (`add_files_uploaded`, `add_runs_reported`, `add_errors`), which take the counters' own lock. A heartbeat doesn't read or reset the fields: `take()` moves the counts out under the lock before the request, and `restore()` adds them back if the request failed. So from 1.4.3:

- the counts of a heartbeat that failed go out with the next one that gets through;
- a count added while a request is in flight goes out with the one after it, and isn't wiped when the request returns, as it was before;
- two heartbeats that overlap, such as a tick left running by a stop and the final heartbeat, take different counts and never report the same one.

A request that fails for a reason the server may have acted on, such as a read timeout, gives its counts back too, so they can be reported twice. The counts are informational, and that is rare.

The auto-updater's idle check reads `last_files_uploaded`. `take()` sets it, from what was counted since the previous heartbeat began to send, and `restore()` leaves it alone. Counts carried over an outage are therefore not new activity: the tick of the interval in which a file was uploaded sees it once, and the later intervals are idle if nothing else is uploaded.

## Test-only overrides

The [end-to-end suite](testing.md#end-to-end-tests-of-the-watcher) runs the real watcher, and the watcher's timers are minutes long. These environment variables shrink them and point self-update at a local package index, so the suite doesn't have to wait or patch the process it tests. They exist for that suite only. Don't set them on a lab PC. They are left out of the operator docs on purpose.

| Variable | Replaces |
| --- | --- |
| `DATA_HUB_WATCHER_HEARTBEAT_INTERVAL_SECONDS` | `HEARTBEAT_INTERVAL_SECONDS` (60). The heartbeat interval, including the waiting state's heartbeat. The [waiting state](#the-waiting-state) rechecks its folder on every heartbeat tick, and from 1.4.3 so does a running watcher, so this also sets how often either does. It is the base of the waiting state's start-failure backoff, which doubles from one interval up to `WAITING_START_RETRY_MAX_SECONDS` (15 minutes). |
| `DATA_HUB_WATCHER_UPLOAD_POLL_INTERVAL_SECONDS` | `UPLOAD_POLL_INTERVAL_SECONDS` (60). How often the upload worker polls the server's upload queue. |
| `DATA_HUB_WATCHER_UPDATE_CHECK_INTERVAL_TICKS` | `DEFAULT_CHECK_INTERVAL_TICKS` (60). Heartbeat ticks between auto-update checks. |
| `DATA_HUB_WATCHER_UPDATE_IDLE_TICKS` | `DEFAULT_IDLE_TICKS_REQUIRED` (5). Idle heartbeat ticks before a non-mandatory update may install. |
| `DATA_HUB_WATCHER_INDEX_URL` | `DEFAULT_INDEX_URL` (`https://pypi.org/simple/`). The index that `self-update`, the in-process updater and the Windows upgrade worker install from. |

The values are read when they are needed, never at import. The interval and tick variables are read each time the supervisor builds a runtime or a waiting state. That happens at startup, again after a config revision rebuilds the watcher, and again each time the waiting state tries to start watching again, whether the attempt works or not. The upload poll interval only matters to a runtime, because the waiting state has no upload worker. The heartbeat variable is also read when a failed start schedules its retry. The index is read each time an upgrade is dispatched, and by `self-update`.

The watcher announces the overrides once, when it starts. `WatcherSupervisor.start` logs one warning that lists every override with a usable value, and it reports any unusable value then too. The warning appears even when only the index URL is set, which would otherwise go unmentioned until an upgrade installs from it. Both `watch` and the Windows service call `start` after they have loaded their env files and set up logging, so the warning reaches the log file and, on Windows, the Event Log. It is made once per process. `self-update` doesn't go through the supervisor, so it makes the same announcement the first time it reads an override.

The Windows service loads its registered env file before it builds the supervisor, so a variable written there takes effect once the service has restarted. The upgrade worker runs as another account, so it never reads the variable itself: the service writes the index URL into the worker's request file.

A blank value counts as unset, and whitespace around a value is trimmed. A whole-number variable must be at least 1. The two interval variables are capped at 86400 seconds, because a much longer wait raises an error on some platforms, and the two tick variables at 999999999 (nine digits). The index URL must start with `http://` or `https://`. It can't contain a space, any other whitespace or a control character, and it can't contain a username or password. The URL reaches `uv` or `pip` as one argument, and the Windows worker passes it through `Start-Process -ArgumentList`, which splits at spaces. It is also written to `watcher.log`, `upgrade-worker.log`, the Windows Event Log and the `UPDATE_FAILED` event details that go to the server, so a password in it would spread. A value that isn't usable logs a warning that names the variable and then falls back to the default, so a typo never stops a watcher. The warning leaves out the value of a rejected index URL that contains an `@`, in case it holds credentials.

The code is in `watcher/src/data_hub_watcher/testing_overrides.py`. The module is named `testing_overrides` rather than `test_…` so that pytest doesn't collect it. To make another timer overridable, add its variable and check there and call its accessor where the timer is used, not a module-level constant.
