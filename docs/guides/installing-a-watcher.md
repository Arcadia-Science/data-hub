# Installing a watcher

This guide is for lab operators setting up the Data Hub Watcher on an instrument PC. The watcher monitors a directory for new files, uploads them to S3, and reports run data to the Data Hub web app.

## Prerequisites

- **[uv](https://docs.astral.sh/uv/getting-started/installation/)** — the recommended Python package manager. Install it if you don't have it yet; it will handle Python for you.
- **A personal access token** — ask your Data Hub admin to create one for you, or create one yourself at **Settings > Access Tokens** in the web app (see [Managing tokens](managing-tokens.md))
- **The watch directory** — the folder where the instrument writes its output files
- **File patterns** — the file extensions you want to upload (e.g., `*.csv`, `*.xlsx`, `*.tiff`)

## Installation

The watcher is published as a versioned package — for production lab PCs, install it directly from the index without cloning the repo:

```sh
uv tool install data-hub-watcher
```

This installs the `data-hub-watcher` CLI into an isolated venv managed by `uv`, on PATH for any shell.

After installation, every example below that says `data-hub-watcher …` runs the installed CLI directly. `data-hub-watcher` (used by developers working from a checkout) also works.

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
uv sync --all-packages
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
   - **`prefix`** — extracts a run ID from each filename using a regex. The default pattern `^([^_]+)` captures everything before the first underscore (e.g., `RUN001_data.csv` → run ID `RUN001`).
   - **`directory`** — each subdirectory under the watch directory is treated as a separate run.

7. **Stability period** — how many seconds a file must remain unchanged (size + modification time) before it's considered fully written. Increase this for instruments that produce large files slowly. Default is 5 seconds.

8. **Upload mode**:
   - **`auto`** — files are uploaded to S3 immediately after detection.
   - **`manual`** — files are reported to the server but not uploaded until an admin approves them via the upload queue.

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

If the watcher was installed from PyPI (recommended for lab PCs), it can
upgrade itself in place:

```sh
data-hub-watcher self-update            # check + upgrade if needed
data-hub-watcher self-update --check    # report status only, no upgrade
data-hub-watcher self-update --force    # re-run the upgrade subprocess
                                         # even if the version already matches
```

The command asks the Data Hub API for the latest published version, compares
it to the locally installed version, and runs the appropriate upgrade
command for your install method:

- **`uv tool install` installs** → `uv tool install --reinstall data-hub-watcher==<latest>`
- **plain venv pip installs** → `<python> -m pip install -U data-hub-watcher==<latest>`
- **editable / `uv sync` checkouts** → refused with a clear error; upgrade
  these manually with `git pull && uv sync` since auto-upgrading would
  shadow your source tree.

After a successful upgrade you must restart the watcher (or the Windows
service) for the new code to take effect — `self-update` does not restart
the running process. To run upgrades unattended, schedule the command via
Windows Task Scheduler (e.g. weekly).

### Automatic background updates

When the watcher runs as a Windows service it also polls the Data Hub
API roughly once an hour and applies new releases on its own — no
operator action and no Task Scheduler entry required. The service:

1. Calls `GET /api/v1/watchers/<watcher-id>/update-check` and compares
   the server's `latest_version` against its own.
2. Only attempts an upgrade if **all** of these are true:
   - a newer version is available;
   - no files have been uploaded for several heartbeats in a row; and
   - no run has been reported within roughly 5× the configured
     `stability_period_seconds`.
3. Runs the same `uv tool install --reinstall` (or `pip install -U`)
   command described above on a dedicated background thread, so
   heartbeats keep flowing while the install executes (which can
   take 30–60 s on slow links). The service emits an `update_started`
   event before the subprocess starts, so you'll see the upgrade
   begin in the Watchers page even if the install itself is slow.
4. On success, exits non-zero so the Windows SCM restarts the service
   into the new wheel. The new process emits `update_succeeded` once
   it confirms the new version is actually loaded; if something went
   wrong (e.g. the new code crashes at startup) you'll see
   `update_failed` instead.

When the server flags a release as **mandatory**, the activity-window
guard is skipped and the upgrade fires on the next hourly check
regardless of in-flight uploads — use this only for security fixes or
wire-protocol changes where running known-bad code is worse than a
brief outage.

Auto-update is **disabled** in the `preview` environment so PR
preview deployments can never push code to production lab PCs.

If you'd rather pin a specific version, run `data-hub-watcher
self-update --check` to see the server's target and follow up with a
manual `uv tool install data-hub-watcher==<pinned>` — the next
auto-update tick will see the pin matches the server's target and skip.

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

Deregistration is a soft-delete: heartbeats, events, and runs reported by the old watcher remain visible in the **Deregistered** tab for auditing.

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
- Check `~/.data-hub/watcher.log` for error details.
- Verify your API token hasn't expired.

### Logs

The watcher writes rotating logs to `~/.data-hub/watcher.log` (10 MB, 5 backups). Check this file for detailed error information. You can also run with `--verbose` for debug-level console output:

```sh
data-hub-watcher --verbose watch
```
