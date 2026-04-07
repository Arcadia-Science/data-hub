# Watcher

The Data Hub Watcher is a CLI agent that runs on lab instrument PCs. It monitors a directory for new files, groups them into runs, uploads them to S3, and reports status to the Data Hub API.

## Installation

The watcher is a Python package with a CLI entry point:

```sh
# From the repo root (development):
uv sync --all-packages
uv run data-hub-watcher --help

# Or install as a standalone tool:
pip install ./watcher
data-hub-watcher --help
```

On Windows, the watcher can optionally be installed as a Windows service (requires `pywin32`). Install the extra, then use the `service install` CLI command to register it with Windows:

```sh
pip install "./watcher[windows-service]"
data-hub-watcher service install
```

## Quick start

```sh
# Run the interactive setup wizard.
data-hub-watcher init

# Start watching for files.
data-hub-watcher watch
```

## Commands

### `init`

Interactive setup wizard that:

1. Prompts for the environment (`staging` or `production`).
2. Prompts for an API key (or reads `DATA_HUB_API_KEY` from the environment).
3. Fetches existing instruments from the API or registers a new one.
4. Prompts for the watch directory, file patterns, run detection method, stability period, and upload mode.
5. Registers the watcher with the API.
6. Saves the config to `~/.data-hub/config.yaml` and syncs it to the API.

### `watch`

Starts the file monitoring loop. Before entering the loop it:

- Validates the config and checks that the instrument is active (not pending).
- Syncs the config checksum with the API.
- Initializes the local state database (`~/.data-hub/watcher.db`).
- Retries any runs that were detected but not successfully reported (crash recovery).

While running:

- **File monitor** watches the directory for new/modified files using `watchdog` and waits for each file to stabilize (size + mtime unchanged for the configured stability period).
- **Run detector** groups stable files into runs using the configured method (prefix regex or subdirectory).
- **Uploader** uploads files to S3 at `{instrument_id}/{run_id}/{filename}` (auto mode) or polls the server's upload queue (manual mode).
- **Heartbeat loop** sends periodic heartbeats (every 60 seconds) to the API. In manual mode, it also polls the upload queue on each tick.
- **Event reporter** batches and flushes lifecycle events (started, stopped, file uploaded, errors) to the API.

Use `--dry-run` to validate config and preview what would happen without starting the monitor.

### `upload`

One-shot file upload for manual use:

```sh
# Upload a specific file.
data-hub-watcher upload --file /path/to/file.csv --run-id RUN001

# Process the server-side upload queue.
data-hub-watcher upload

# Preview without uploading.
data-hub-watcher upload --dry-run
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

Requires the `windows-service` extra (`pip install "./watcher[windows-service]"`).

Manage the watcher as a Windows service:

| Subcommand | Description |
| --- | --- |
| `service install` | Install the Windows service |
| `service uninstall` | Remove the Windows service |
| `service start` | Start the service |
| `service stop` | Stop the service |
| `service status` | Show service status |

## Configuration

The config file lives at `~/.data-hub/config.yaml` by default. Override with `--config` or the `DATA_HUB_CONFIG_PATH` environment variable.

### Config file format

```yaml
version: 1
environment: production          # "staging" or "production"
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
    method: prefix               # "prefix" or "directory"
    prefix_pattern: "^([^_]+)"   # regex with one capture group (run ID)
```

### Run detection methods

- **`prefix`**: The run ID is extracted from each filename using a regex with one capture group. For example, `^([^_]+)` matches everything before the first underscore, so `RUN001_data.csv` yields run ID `RUN001`.
- **`directory`**: Each subdirectory under the watch directory is treated as a separate run. The subdirectory name is the run ID.

### Upload modes

- **`auto`**: Files are uploaded to S3 immediately after run detection.
- **`manual`**: Runs are reported to the API without uploading. The server decides which files to upload via a queue, polled on each heartbeat tick. Useful when uploads need human approval.

## Local state

The watcher maintains a SQLite database at `~/.data-hub/watcher.db` to track which files have been uploaded. Records older than 90 days are pruned automatically. Logs are written to `~/.data-hub/watcher.log` (10 MB rotating, 5 backups).
