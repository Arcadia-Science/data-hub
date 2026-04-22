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

## Commands

### `init`

Interactive setup wizard that:

1. Prompts for the environment (`staging`, `production`, or `preview`). Choosing `preview` also prompts for a custom API base URL.
2. Prompts for an API key (or reads `DATA_HUB_API_KEY` from the environment). The key is saved to `~/.data-hub/.env`.
3. Fetches existing instruments from the API or registers a new one.
4. Prompts for the watch directory, file patterns, run detection pattern, stability period, and upload mode.
5. Registers the watcher with the API.
6. Saves the config to `~/.data-hub/config.yaml`, the API key to `~/.data-hub/.env`, and syncs the config to the API.

### `watch`

Starts the file monitoring loop. Before entering the loop it:

- Validates the config and checks that the instrument is active (not pending).
- Syncs the config checksum with the API.
- Initializes the local state database (`~/.data-hub/watcher.db`).
- Retries any runs that were detected but not successfully reported (crash recovery).

While running:

- **File monitor** watches the directory for new/modified files using `watchdog` and waits for each file to stabilize (size + mtime unchanged for the configured stability period).
- **Run detector** groups stable files into runs by applying the configured regex to each file's relative path.
- **Uploader** requests a presigned S3 URL from the API and uploads each file via HTTP PUT (auto mode), or polls the server's upload queue (manual mode). The watcher does not need AWS credentials.
- **Heartbeat loop** sends periodic heartbeats (every 60 seconds) to the API. In manual mode, it also polls the upload queue on each tick.
- **Event reporter** batches and flushes lifecycle events (started, stopped, file uploaded, errors) to the API.

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

## Configuration

The config file lives at `~/.data-hub/config.yaml` by default. Override with `--config` or the `DATA_HUB_CONFIG_PATH` environment variable. The API key is stored separately in `~/.data-hub/.env`.

### Config file format

```yaml
version: 1
environment: production          # "staging", "production", or "preview"
api_base_url: null               # required when environment is "preview"
watcher_id: <assigned-by-api>
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

### Upload modes

- **`auto`**: Files are uploaded to S3 immediately after run detection.
- **`manual`**: Runs are reported to the API without uploading. The server decides which files to upload via a queue, polled on each heartbeat tick. Useful when uploads need human approval.

## Local state

The watcher maintains a SQLite database at `~/.data-hub/watcher.db` to track which files have been uploaded. Records older than 90 days are pruned automatically. Logs are written to `~/.data-hub/watcher.log` (10 MB rotating, 5 backups).

### Initial scan identity

When the watcher starts it walks the watch directory to catch files that arrived while it was stopped. Identity for "have I already uploaded this?" is `(relative_path, size, mtime)` rather than a full-content hash — this keeps startup fast even on directories holding hundreds of GB of instrument output. Content integrity is still verified at upload time: the uploader computes a SHA-256 on every file it PUTs to S3 and records it alongside the upload.

The relative path is the file's location relative to the watch directory (e.g. `run-2026-04-17/sample-a/output.nd2`), not just the basename. This matters in recursive watches where two runs might both emit files with the same name — they're disambiguated by subdirectory.

Practical consequences:

- Instrument output files are write-once, so the cheap stat-based check is effectively as strong as a hash in normal operation.
- If an external tool (antivirus, OneDrive/Dropbox sync, backup restore) rewrites a file's mtime without changing its contents, the watcher will re-enqueue it. The server-side dedup (keyed on SHA-256) prevents a duplicate S3 object.
- If a run's parent folder is renamed or moved, its files look "new" to the next scan and will be re-enqueued. The uploader's own SHA-based dedup prevents a redundant S3 PUT, but it will pay the cost of hashing each affected file once.
- Upgrading from a pre-`relative_path`/`size_bytes`/`mtime` state DB is a silent, self-healing migration: legacy rows miss the stat lookup, so files are re-enqueued once and then recorded with full stat data on their next upload.
