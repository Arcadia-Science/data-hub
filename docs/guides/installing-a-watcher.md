# Installing a watcher

This guide is for lab operators setting up the Data Hub Watcher on an instrument PC. The watcher monitors a directory for new files, uploads them to S3, and reports run data to the Data Hub web app.

## Prerequisites

- **Python >= 3.12** installed on the instrument PC
- **A personal access token** — ask your Data Hub admin to create one for you, or create one yourself at **Settings > Access Tokens** in the web app (see [Managing tokens](managing-tokens.md))
- **The watch directory** — the folder where the instrument writes its output files
- **File patterns** — the file extensions you want to upload (e.g., `*.csv`, `*.xlsx`, `*.tiff`)

## Installation

### From the repository (recommended for development)

```sh
git clone <repo-url>
cd data-hub
uv sync --all-packages
```

### Standalone install

```sh
pip install ./watcher
```

### Windows service support

If you want the watcher to run as a Windows service:

```sh
pip install "./watcher[windows-service]"
```

## Setup

Run the interactive setup wizard:

```sh
data-hub-watcher init
```

The wizard will walk you through:

1. **Environment** — choose `staging` (for testing) or `production`.

2. **API key** — paste the personal access token. You can also set the `DATA_HUB_API_KEY` environment variable to skip this prompt.

3. **Instrument** — select an existing instrument from the list, or register a new one by choosing the last option. New instruments start as `pending` and must be activated by an admin in the web app before the watcher can start.

4. **Watch directory** — the absolute path to the folder the instrument writes to.

5. **File patterns** — comma-separated glob patterns (e.g., `*.csv,*.xlsx`). Only files matching these patterns will be uploaded.

6. **Run detection method**:
   - **`prefix`** — extracts a run ID from each filename using a regex. The default pattern `^([^_]+)` captures everything before the first underscore (e.g., `RUN001_data.csv` → run ID `RUN001`).
   - **`directory`** — each subdirectory under the watch directory is treated as a separate run.

7. **Stability period** — how many seconds a file must remain unchanged (size + modification time) before it's considered fully written. Increase this for instruments that produce large files slowly. Default is 5 seconds.

8. **Upload mode**:
   - **`auto`** — files are uploaded to S3 immediately after detection.
   - **`manual`** — files are reported to the server but not uploaded until an admin approves them via the upload queue.

The wizard saves configuration to `~/.data-hub/config.yaml` and syncs it to the server.

## Starting the watcher

First, verify your setup with a dry run:

```sh
data-hub-watcher watch --dry-run
```

This validates the config, checks that the API is reachable and the instrument is active, and previews what files would be uploaded — without actually starting the monitor.

When you're ready:

```sh
data-hub-watcher watch
```

The watcher will now:

- Monitor the watch directory for new and modified files.
- Wait for files to stabilize before processing them.
- Group files into runs and report them to the API.
- Upload files to S3 (in auto mode) or wait for server approval (in manual mode).
- Send heartbeats every 60 seconds so the web dashboard shows watcher health.

Press `Ctrl+C` to stop.

## Running as a Windows service

On Windows, you can install the watcher as a service so it starts automatically:

```sh
data-hub-watcher service install
data-hub-watcher service start
```

Other service commands:

```sh
data-hub-watcher service status    # Check if the service is running
data-hub-watcher service stop      # Stop the service
data-hub-watcher service uninstall # Remove the service
```

## Changing configuration

To re-prompt each config field with current values as defaults:

```sh
data-hub-watcher config edit
```

To open the YAML file directly in your editor:

```sh
data-hub-watcher config open
```

To view the current config:

```sh
data-hub-watcher config show
```

Changes are automatically synced to the server after editing.

## Manual uploads

To upload a specific file outside the normal watch loop:

```sh
data-hub-watcher upload --file /path/to/file.csv --run-id RUN001
```

To process the server-side upload queue (manual mode):

```sh
data-hub-watcher upload
```

Add `--dry-run` to preview without uploading.

## Troubleshooting

### "Instrument is still pending activation"

The instrument was registered but hasn't been confirmed by an admin yet. Ask your admin to click "Confirm" on the instrument in the web app's Instruments page.

### "Connection error" or "Request timed out"

The watcher can't reach the Data Hub API. Check:

- Your internet connection.
- That the correct environment is set in the config (`staging` vs `production`).
- That the API URL is reachable: `https://data-hub.arcadiascience.com` (production) or `https://data-hub-env-staging-arcadia-science.vercel.app` (staging).

### Files aren't being detected

- Verify the watch directory is correct: `data-hub-watcher config show`
- Check that file patterns match your files. The watcher uses glob matching (e.g., `*.csv` matches `data.csv` but not `data.CSV` on case-sensitive systems).
- Run `data-hub-watcher watch --dry-run` to see what files the watcher would pick up.

### Files are detected but not uploading

- In **manual mode**, files are not uploaded until approved via the upload queue. Check the web dashboard.
- Check `~/.data-hub/watcher.log` for error details.
- Verify your API token hasn't expired.

### Logs

The watcher writes rotating logs to `~/.data-hub/watcher.log` (10 MB, 5 backups). Check this file for detailed error information. You can also run with `--verbose` for debug-level console output:

```sh
data-hub-watcher --verbose watch
```
