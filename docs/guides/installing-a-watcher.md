# Installing a watcher

This guide is for lab operators setting up the Data Hub Watcher on an instrument PC. The watcher monitors a directory for new files, uploads them to S3, and reports run data to the Data Hub web app.

## Prerequisites

- **[uv](https://docs.astral.sh/uv/getting-started/installation/)** — the recommended Python package manager. Install it if you don't have it yet; it will handle Python for you.
- **A personal access token** — ask your Data Hub admin to create one for you, or create one yourself at **Settings > Access Tokens** in the web app (see [Managing tokens](managing-tokens.md))
- **The watch directory** — the folder where the instrument writes its output files
- **File patterns** — the file extensions you want to upload (e.g., `*.csv`, `*.xlsx`, `*.tiff`)

## Installation

The watcher is published as a versioned package on PyPI. For use on lab PCs, install it directly from PyPI:

```sh
uv tool install data-hub-watcher
```

This installs the `data-hub-watcher` CLI into an isolated venv managed by `uv`, on PATH for any shell.

After installation, every example below that says `data-hub-watcher …` runs the installed CLI directly.

### Windows service support

The watcher can run as a Windows service. Install it with the `windows-service` extra so the `pywin32` dependency is included:

```sh
uv tool install "data-hub-watcher[windows-service]"
```

### Developer install (from a checkout)

If you're modifying the watcher itself, install in editable mode from the repo so your local edits are reflected immediately:

```sh
git clone https://github.com/Arcadia-Science/data-hub
cd data-hub
uv sync --all-packages --extra windows-service
uv run data-hub-watcher --help
```

When working from the checkout, prefix every example below with `uv run` (e.g. `uv run data-hub-watcher init`) so the editable install in `.venv/` is used.

## Setup

Run the interactive setup wizard:

```sh
data-hub-watcher init
```

The wizard will walk you through:

1. **Environment** — choose `staging` (for testing), `production`, or `preview` (for testing against a Vercel preview deployment). If you choose `preview`, you'll be prompted for the deployment's API base URL (e.g. `https://data-hub-git-my-branch.vercel.app/api/v1`).
2. **API key** — paste the personal access token. The key is saved to `~/.data-hub/.env.<environment>` (e.g. `~/.data-hub/.env.staging`), so each environment keeps its own key and you can switch between them by re-running `init` without re-entering credentials. You can also set the `DATA_HUB_API_KEY` environment variable before running `init` to skip this prompt.
3. **Instrument** — select an existing instrument from the list, or register a new one by choosing the last option. New instruments start as `pending` and must be activated by an admin in the web app before the watcher can start.
4. **Watch directory** — the absolute path to the folder the instrument writes to.
5. **File patterns** — comma-separated glob patterns (e.g., `*.csv,*.xlsx`). Only files matching these patterns will be uploaded.
6. **Run detection method**:
  - `**prefix`** — extracts a run ID from each filename using a regex. The default pattern `^([^_]+)` captures everything before the first underscore (e.g., `RUN001_data.csv` → run ID `RUN001`).
  - `**directory**` — each subdirectory under the watch directory is treated as a separate run.
7. **Stability period** — how many seconds a file must remain unchanged (size + modification time) before it's considered fully written. Increase this for instruments that produce large files slowly. Default is 5 seconds.
8. **Upload mode**:
  - `**auto`** — files are uploaded to S3 immediately after detection.
  - `**manual**` — files are reported to the server but not uploaded until an admin approves them via the upload queue.

The wizard saves configuration to `~/.data-hub/config.yaml`, the API key to `~/.data-hub/.env.<environment>`, and syncs the config to the server.

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
data-hub-watcher service reinstall # Stop, uninstall, install, and start (e.g. after a manual wheel upgrade)
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

## Upgrading the watcher

The watcher can upgrade itself in place, either on demand via `data-hub-watcher self-update` or — when running as a Windows service — automatically on an hourly background tick. The full release flow, mandatory-update behavior, rollback steps, and operator troubleshooting all live in [Upgrading the watcher](upgrading-the-watcher.md).

If you just want the quick command:

```sh
data-hub-watcher self-update            # check + upgrade if needed
data-hub-watcher self-update --check    # report status only, no upgrade
data-hub-watcher self-update --force    # re-run the upgrade subprocess even if the version already matches
```

After a successful upgrade you must restart the watcher (or the Windows service) for the new code to take effect — `self-update` does not restart the running process. Lab PCs running the Windows service get auto-restart for free via the SCM's failure-actions policy; see the [upgrade guide](./upgrading-the-watcher.md) for details.

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

### "Instrument already has an active watcher"

Each instrument can have at most one active watcher at a time. If `init` fails with this error, an earlier install (often on a different PC, or before a reimage) is still registered against the instrument. The CLI prints the existing watcher's id; deregister it before re-running `init`:

- **Web UI** — go to **Watchers**, open the existing watcher, and click **Deregister**.
- **API** — `curl -X DELETE -H "Authorization: Bearer $DATA_HUB_API_KEY" https://<host>/api/v1/watchers/<existing_watcher_id>`

Deregistration is a soft-delete: heartbeats, events, and runs reported by the old watcher remain visible in **Watchers > Deregistered** (in the web app) for auditing.

### "Connection error" or "Request timed out"

The watcher can't reach the Data Hub API. Check:

- Your internet connection.
- That the correct environment is set in the config (`staging`, `production`, or `preview`).
- That the API URL is reachable: `https://data-hub.arcadiascience.com` (production), `https://data-hub-env-staging-arcadia-science.vercel.app` (staging), or the custom URL you provided (preview).

### Files aren't being detected

- Verify the watch directory is correct: `data-hub-watcher config show`
- Check that file patterns match your files. The watcher uses glob matching (e.g., `*.csv` matches `data.csv` but not `data.CSV` on case-sensitive systems).
- Run `data-hub-watcher watch --dry-run` to see what files the watcher would pick up.

### Files are detected but not uploading

- In **manual mode**, files are not uploaded until approved via the upload queue. Check the web dashboard.
- Check the log file at `C:\ProgramData\DataHubWatcher\watcher.log` (Windows) or `~/.data-hub/watcher.log` (macOS/Linux) for error details.
- Verify your API token hasn't expired.

### Logs

The watcher writes rotating logs to:

- **Windows**: `C:\ProgramData\DataHubWatcher\watcher.log`
- **macOS / Linux**: `~/.data-hub/watcher.log`

Files are 10 MB each with 5 backups kept (`watcher.log.1` through `watcher.log.5`). Both the CLI `watch` command and the Windows service write to the same path so a single `Get-Content -Wait` (or `tail -F`) shows everything regardless of which entrypoint is running. You can also pass `--verbose` for debug-level console output on the CLI:

```sh
data-hub-watcher --verbose watch
```

#### Don't run `watch` alongside the service

Running `data-hub-watcher watch` interactively while the Windows service is also running is not supported — both processes would race on the same rotating log file (and on the same watch directory). Stop the service first if you need to run the CLI for debugging:

```powershell
data-hub-watcher service stop
data-hub-watcher --verbose watch
data-hub-watcher service start   # when you're done
```

#### Bootstrap log for pre-dispatcher crashes

The service writes a separate `service-bootstrap.log` next to `watcher.log` that captures crashes happening before the service control dispatcher takes over — for example, a missing `pywin32`, a moved virtualenv, or a corrupt install. If `watcher.log` is empty after a crash, check `C:\ProgramData\DataHubWatcher\service-bootstrap.log` for the traceback.

#### Turning on debug logging for the service

Add `DATA_HUB_WATCHER_LOG_LEVEL=DEBUG` to the env file the service is registered against (typically `~/.data-hub/.env.<environment>`) and restart the service. No redeploy or `service reinstall` is needed.

#### Triaging a service that crashes immediately

If the service exits before writing anything to `watcher.log`, two read-only commands will surface the failure:

1. Query the Windows Application event log for entries from the watcher or the underlying Python service host:

   ```powershell
   Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=(Get-Date).AddHours(-1)} |
     Where-Object { $_.ProviderName -match 'Python|DataHubWatcher' -or $_.Message -match 'DataHubWatcher' } |
     Format-List TimeCreated, ProviderName, Id, LevelDisplayName, Message
   ```

2. Run the service in the foreground from the venv `pywin32` itself ships:

   ```powershell
   & "C:\path\to\venv\Scripts\python.exe" -m win32serviceutil debug DataHubWatcher
   ```

   This bypasses the SCM, runs the same startup path the service uses, and prints the full traceback to the console — the fastest way to see why a phase-A/B crash is happening.

