# Watcher

The Data Hub Watcher is a CLI agent that runs on lab instrument PCs. It monitors a directory for new files, groups them into runs, uploads them to S3, and reports status to the Data Hub API.

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

For lab-PC installs (PyPI), see [Installing a watcher](../guides/installing-a-watcher.md). For releasing new versions and how the in-place upgrade flow works (CLI `self-update` and the Windows-service auto-updater), see [Upgrading the watcher](../guides/upgrading-the-watcher.md).

## Commands

All commands accept two global flags:

- `--config PATH` (or the `DATA_HUB_CONFIG_PATH` env var): override the config file path.
- `--verbose`: enable debug-level logging on stderr.

### `init`

Interactive setup wizard that:

1. Prompts for the environment (`staging`, `production`, or `preview`). Choosing `preview` also prompts for a custom API base URL.
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
- Syncs the config checksum with the API.
- Initializes the local state database for the active environment (`~/.data-hub/watcher-<environment>.db`).
- Hydrates in-memory run state from the local DB so the initial scan skips files that were already reported in a previous session.

While running:

- **File monitor** watches the directory for new/modified files using `watchdog` and waits for each file to stabilize (size + mtime unchanged for the configured stability period). Files that keep changing for longer than 5 minutes are abandoned and surface as a `stability_timeout` error event.
- **Run detector** groups stable files into runs by applying the configured regex to each file's relative path. The first file for a run triggers `POST /instruments/:id/runs`; subsequent files for the same run incrementally `PATCH` only the new entries onto the manifest. Files inside the watch tree that don't match the pattern emit a `pattern_mismatch` event (throttled to one per parent directory) so misconfigured patterns surface in the dashboard.
- **Uploader** requests a presigned S3 URL from the API and uploads each file via HTTP PUT (auto mode), or processes the server's upload queue (manual mode). The watcher does not need AWS credentials. Each upload retries up to 3 times with exponential backoff (1, 2, 4 s) and is recorded locally with its SHA-256 so retries and restarts don't re-upload the same bytes. In manual mode, queue-poll failures are throttled (1st failure, then every 10th) to keep a sustained outage visible without flooding the events stream.
- **Upload worker** (manual mode only) polls the server's upload queue on its own long-lived thread every 60 seconds, decoupled from the heartbeat so a slow or large upload can't delay heartbeats and make a busy watcher look offline. On shutdown it is stopped and joined before the state DB is closed. Auto mode has no worker: uploads run on the monitor's stability-checker thread via the run detector's upload callback.
- **Heartbeat loop** sends periodic heartbeats (every 60 seconds) to the API. The payload includes the watcher version, instrument ID, watch directory, upload mode, per-interval activity counters, and process uptime; a final `status="stopped"` heartbeat is sent on graceful shutdown.
- **Event reporter** batches and flushes lifecycle events (started, stopped, file uploaded, errors) to the API. See [Observability](#observability) for the full taxonomy.
- **Auto-updater** runs from the same heartbeat tick on every platform — not only Windows services. It polls `GET /watchers/:id/update-check` roughly hourly and applies new releases when the watcher has been idle long enough not to clobber an in-flight run. The full activity-window guard, mandatory-update behavior, and rollback flow are documented in [Upgrading the watcher](../guides/upgrading-the-watcher.md); auto-update is hard-disabled in the `preview` environment.

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

### `config`

Subcommands for managing the YAML config file:

| Subcommand | Description |
| --- | --- |
| `config show` | Pretty-print the current config |
| `config validate` | Validate the config file (offline) |
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

### `self-update`

Checks the API for a newer published version and runs the appropriate `uv tool install --reinstall` (or `pip install -U`) subprocess in place. See [Upgrading the watcher](../guides/upgrading-the-watcher.md) for the supported install methods, the activity-window guard, mandatory updates, and rollback flow.

## Configuration

The config file lives at `~/.data-hub/config.yaml` by default. Override with `--config` or the `DATA_HUB_CONFIG_PATH` environment variable. The API key is stored separately in `~/.data-hub/.env.<environment>` (e.g. `.env.staging`, `.env.production`, or `.env.preview`); the legacy `~/.data-hub/.env` is also loaded for backwards compatibility, with the per-environment file taking precedence.

### Config file format

```yaml
version: 1
environment: production          # "staging", "production", or "preview"
api_base_url: null               # required when environment is "preview"
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

A single PC can move between `staging`, `production`, and `preview` and back. Because staging and production are separate Data Hub deployments with separate databases, each holds its own watcher registration — `watcher_ids` stores one id per environment, and the credentials live in per-environment `~/.data-hub/.env.<environment>` files.

Switch with:

```sh
# Switch to staging (reuses a stored registration, or registers one).
uv run data-hub-watcher config set-environment staging

# Point at a preview deployment (the base URL is required).
uv run data-hub-watcher config set-environment preview \
  --api-base-url https://data-hub-git-my-branch.vercel.app/api/v1
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

- **`auto`**: Files are uploaded to S3 immediately after run detection.
- **`manual`**: Runs are reported to the API without uploading. The server decides which files to upload via a queue, polled by the upload worker thread every 60 seconds. Useful when uploads need human approval.

Queued files are resolved against the current `watch_directory` (each queue entry carries a `relative_path` anchored to the root that was active when the file was detected). Two safeguards keep a stale queue entry from erroring forever (ENG-1397):

- **On `watch_directory` change**: the server reverts every pending upload request for that instrument back to `detected` (clearing `upload_requested_at`) as soon as the new config is pushed, so the queue drains immediately. The reverted files remain re-requestable detections; an operator can queue them again from their new location.
- **Per-file 3-try cap (`MAX_QUEUE_FILE_ATTEMPTS`)**: a queued file that keeps failing — missing on disk or failing to upload — is retried on at most three upload-queue polls. After that the watcher cancels the request server-side (revert to `detected`) so the file leaves the queue instead of re-erroring each poll. The attempt count resets on watcher restart, so a transient outage longer than three polls is recovered on the next start.

## Local state

The watcher maintains one SQLite database per environment at `~/.data-hub/watcher-<environment>.db` (e.g. `watcher-production.db`). Isolating state per environment is what lets a PC switch back and forth without one environment's uploads being recorded against another. A pre-multi-environment `~/.data-hub/watcher.db` is renamed to the active environment's file on first start. Each database has the following tables:

- `uploaded_files` — one row per successful S3 upload, keyed on `(filename, sha256, s3_key)`. Used by the uploader to skip re-uploads on retry and by the initial scan to skip files that have already been sent. Records older than 90 days are pruned automatically.
- `runs` — tracks which run IDs have been reported and (in auto mode) when their files finished uploading. The most recent `reported_at` timestamp is what the auto-updater consults to gate restarts on a quiet-instrument window.
- `detected_files` — the file manifest for every reported run, keyed on `(run_id, relative_path)`. Lets the initial scan skip files that are already part of a reported run even in manual mode (where `uploaded_files` stays empty), and lets the run detector hydrate its in-memory state on startup so a restart doesn't re-POST runs the API has already seen.
- `baseline_files` — files that already existed on disk when a `new-only` environment was first entered, keyed on `relative_path`. A baseline row means "skip" (never uploaded), as opposed to `uploaded_files` which means "sent". Unlike `uploaded_files`, baseline rows are never pruned. Empty in `full`-scan (production) environments.
- `meta` — a small key/value store. Currently holds the preview deployment URL the database was seeded against, so the watcher can reset local state when a preview is redeployed to a new URL.

Logs are written to `C:\ProgramData\DataHubWatcher\watcher.log` on Windows and `~/.data-hub/watcher.log` on macOS/Linux (10 MB rotating, 5 backups). Both the CLI `watch` command and the Windows service write to the same file so a single `Get-Content -Wait` (or `tail -F`) covers all entry points.

### Initial scan identity

When the watcher starts it walks the watch directory to catch files that arrived while it was stopped. Identity for "have I already uploaded this?" is `(relative_path, size, mtime)` rather than a full-content hash — this keeps startup fast even on directories holding hundreds of GB of instrument output. Content integrity is still verified at upload time: the uploader computes a SHA-256 on every file it PUTs to S3 and records it alongside the upload.

The relative path is the file's location relative to the watch directory (e.g. `run-2026-04-17/sample-a/output.nd2`), not just the basename. This matters in recursive watches where two runs might both emit files with the same name — they're disambiguated by subdirectory.

Practical consequences:

- Instrument output files are write-once, so the cheap stat-based check is effectively as strong as a hash in normal operation.
- If an external tool (antivirus, OneDrive/Dropbox sync, backup restore) rewrites a file's mtime without changing its contents, the watcher will re-enqueue it. The server-side dedup (keyed on SHA-256) prevents a duplicate S3 object.
- If a run's parent folder is renamed or moved, its files look "new" to the next scan and will be re-enqueued. The uploader's own SHA-based dedup prevents a redundant S3 PUT, but it will pay the cost of hashing each affected file once.
- Upgrading from a pre-`relative_path`/`size_bytes`/`mtime` state DB is a silent, self-healing migration: legacy rows miss the stat lookup, so files are re-enqueued once and then recorded with full stat data on their next upload.

In a `new-only` environment (staging/preview by default — see [Switching environments](#switching-environments)), the first start also seeds `baseline_files` with everything currently on disk so the historical backlog is skipped rather than uploaded. The seeding is one-shot: it only runs when the environment's database has no upload, run, or baseline history yet.

## Observability

The watcher's primary observability surface is the per-watcher event log served by `POST /watchers/:id/events`. Events are queued in memory by the long-running components (uploader, run detector, monitor, heartbeat, updater) and flushed in batches on every heartbeat tick. The queue is bounded to 500 events; on overflow the oldest are dropped (FIFO) and surfaced via a synthetic `events_dropped` event prepended to the next successful flush, so an outage that loses observability data is itself observable when the link recovers.

### Event types

| Event type | When |
| --- | --- |
| `watcher_started` / `watcher_stopped` | Process lifecycle. The stopped message distinguishes a normal stop from an upgrade-driven restart. `watcher_stopped` is also emitted in the *old* environment as a breadcrumb when the watcher switches environments. |
| `config_synced` | Local config differed from the remote checksum and was pushed. Triggered by `init`, `config edit`, `config open`, and on watcher startup. The server also emits one with `details.kind="upload_requests_cancelled"` (and `cancelled_count`) when a `watch_directory` change drained pending upload requests. |
| `run_reported` | A run was POSTed to the API for the first time. |
| `file_uploaded` / `upload_failed` | Per-file upload outcome. `upload_failed` carries the S3 key and last error. |
| `update_started` / `update_succeeded` / `update_failed` | Auto-update lifecycle. `update_succeeded` is emitted from the *next* process startup once the new version is confirmed to be loaded. |
| `error` | Generic bucket; use `details.kind` to discriminate (table below). |

### Error kinds

`error` events use a `details.kind` discriminator so new failure modes can be added without a database migration. Known kinds:

| Kind | Meaning |
| --- | --- |
| `run_report_failed` | POST/PATCH against `/instruments/:id/runs[/:run_id]` failed. `details` includes `operation`, `status_code`, `file_count`. |
| `config_sync_failed` | The startup `PUT /watchers/:id/config` (or its checksum probe) failed. |
| `stability_timeout` | A file kept changing past 5 minutes and was abandoned. |
| `stable_callback_failed` | The on-stable-file callback raised. |
| `pattern_mismatch` | A file inside the watch tree did not match `run_detection.pattern`. Throttled to one emission per parent directory per process. |
| `events_dropped` | Synthetic event prepended after one or more prior batches were dropped. `details.dropped_count` reports the gap size. |
| `heartbeat_recovered` | First successful heartbeat after one or more consecutive failures. `details.gap_seconds` reports the outage length. |
| `upload_queue_poll_failed` | `GET /watchers/:id/upload-queue` failed in manual mode. Emitted on the 1st failure and every 10th repeat. |
| `queued_file_missing` | A manual-mode queued file was not found on disk at its resolved path. Emitted once per file (throttled across polls). `details` includes `file_id`, `expected_path`. |
| `upload_request_cancelled` | The watcher gave up on a queued file after `MAX_QUEUE_FILE_ATTEMPTS` failed polls (missing or upload error) and reverted it to `detected` server-side. `details` includes `file_id`, `attempts`, `reason`. |
| `update_check_failed` | `GET /watchers/:id/update-check` failed for 3 consecutive attempts (~3 hours of going dark on the update channel). |

### File timestamps

Each file's on-disk creation time (`st_birthtime` where the OS provides it, otherwise `st_mtime`) is captured at stabilization, persisted in `detected_files`, and sent to the API on every run report and presigned-URL request. This lets the dashboard order events by when the instrument actually wrote the file rather than when the watcher uploaded it — useful when an initial scan or backfill uploads files long after their original write time.
