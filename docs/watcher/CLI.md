# Watcher: CLI Interface

Prerequisite reading: [ARCHITECTURE.md](../ARCHITECTURE.md), [CONFIG_AND_VALIDATION.md](./CONFIG_AND_VALIDATION.md), [API_CLIENT.md](./API_CLIENT.md).

Built with Click, extending the existing CLI pattern. All commands are namespaced under `data-hub watcher`. Maps to `cli.py` in the watcher module structure.

## Command Tree

```
data-hub watcher
├── init                  # Interactive setup wizard + API registration
├── config
│   ├── show              # Pretty-print current config
│   ├── validate          # Validate config file (offline)
│   ├── edit              # Edit the instrument config interactively
│   ├── open              # Open config file in a text editor
│   └── path              # Print the config file path
├── watch                 # Start file watcher + heartbeat
│   └── --dry-run         # Log activity without uploading or sending heartbeats
├── upload                # One-shot upload of a specific file
│   ├── --file <path>
│   └── --dry-run
└── service               # Windows Service management (Windows only)
    ├── install           # Install the watcher as a Windows Service
    ├── uninstall         # Remove the Windows Service
    ├── start             # Start the service
    ├── stop              # Stop the service
    └── status            # Show service status
```

## `data-hub watcher init`

Interactive wizard that creates a config file and registers with the Data Hub API. The API must be reachable for `init` to succeed.

Steps:

1. Ask for environment (`staging` / `production`). The API URL is resolved automatically.
2. Fetch the list of registered instruments from the Data Hub API and display them.
3. Prompt: "Select an instrument or register a new one."
  - **Existing instrument:** Select from a numbered list. The API returns metadata including suggested file patterns, which are used as defaults in step 5.
  - **New instrument:** User enters a kebab-case ID (validated locally). The CLI sends `POST /instruments` to the API. The API creates the instrument in a **pending** state. An admin confirms it via the Data Hub web UI.
4. Prompt for watch directory (validate that the path exists).
5. Prompt for file patterns (pre-populated from API metadata for existing instruments; blank for new instruments).
6. Prompt for run detection method (`prefix` / `directory`). Default: `prefix`.
  - If `prefix`: prompt for prefix pattern (default: `^([^_]+)`). Show an example of how filenames in the watch directory would be grouped.
7. Prompt for file stability period in seconds (default: `5`). Explain that this controls how long the watcher waits after a file stops changing before uploading it.
8. Prompt for upload mode (`auto` / `manual`). Default: `auto`.
9. Register the watcher with the API via `POST /watchers/register`. The API returns a `watcher_id` (UUID).
10. Write config to disk.
11. Push config to the API via `PUT /watchers/{watcher_id}/config`.
12. Run local validation and display the result.

If a config file already exists, prompt to overwrite.

**Auto mode example:**

```
$ data-hub watcher init

? Select environment:
  > staging
    production

Fetching instruments from Data Hub API...

? Select an instrument or register a new one:
    1. Agilent 4150 TapeStation
    2. Akta FPLC
    3. Azure 600 Gel Doc
    4. Azure Cielo qPCR
    5. SpectraMax iD3 Plate Reader
    6. SpectraMax iD5 Plate Reader
    n. Register a new instrument

> 5

? Watch directory: /data/spectramax-id3
? File types [*.xls]: *.xls

? Run detection method:
  > prefix    — Group files by a shared filename prefix (e.g., "20260325_file1.csv" → run "20260325")
    directory — Group files by subdirectory (e.g., "20260325_exp/file1.csv" → run "20260325_exp")

? Prefix pattern [^([^_]+)]:

  Preview — files in /data/spectramax-id3 would be grouped as:
    Run "20260326": 20260326_experiment.xls

? File stability period in seconds [5]:

? Upload mode:
  > auto   — Upload files to S3 automatically when detected
    manual — Report new instrument runs without uploading; upload on demand via the web UI

Registering watcher with Data Hub API...
✓ Watcher registered (ID: a1b2c3d4-e5f6-7890-abcd-ef1234567890)
✓ Configuration saved to ~/.data-hub/config.yaml
✓ Configuration synced to Data Hub API
```

**Manual mode example:**

```
$ data-hub watcher init

? Select environment:
  > staging
    production

Fetching instruments from Data Hub API...

? Select an instrument or register a new one:
    1. Mass Spectrometer
    ...
> 1

? Watch directory: /data/mass-spec
? File types [*.csv]: *.csv

? Run detection method:
  > prefix    — Group files by a shared filename prefix (e.g., "20260325_file1.csv" → run "20260325")
    directory — Group files by subdirectory (e.g., "20260325_exp/file1.csv" → run "20260325_exp")

? Prefix pattern [^([^_]+)]:

  Preview — files in /data/mass-spec would be grouped as:
    Run "20260325": 20260325_data_file_1.csv, 20260325_data_file_2.csv
    Run "20260326": 20260326_data_file_1.csv

? File stability period in seconds [5]: 30

? Upload mode:
    auto   — Upload files to S3 automatically when detected
  > manual — Report new instrument runs without uploading; upload on demand via the web UI

Registering watcher with Data Hub API...
✓ Watcher registered (ID: b2c3d4e5-f6a7-8901-bcde-f12345678901)
✓ Configuration saved to ~/.data-hub/config.yaml
✓ Configuration synced to Data Hub API
```

## `data-hub watcher config show`

Pretty-prints the current config as a summary:

```
Environment:     staging
Config path:     ~/.data-hub/config.yaml
Watcher ID:      a1b2c3d4-e5f6-7890-abcd-ef1234567890

Instrument:      spectramax-id3-plate-reader
Watch directory: /data/spectramax-id3
File patterns:   *.xls
Run detection:   prefix (pattern: ^([^_]+))
Upload mode:     auto
Stability:       5s
Enabled:         ✓
```

If the config file is missing, malformed YAML, or fails validation, `config show` prints the error and exits with code 1 instead of crashing with a traceback. This lets users diagnose issues without needing to run `config validate` separately.

## `data-hub watcher config validate`

Loads the config, runs the Pydantic validation layer, and reports all errors and warnings. Exit code 0 on success, 1 on errors. No network calls.

## `data-hub watcher config edit`

Loads the current config and re-prompts for each field, showing the current value as the default. The user presses Enter to keep current values.

After writing the updated config to disk, pushes the config to the API. If the API is unreachable, the local write succeeds and a warning is logged: "Config saved locally but could not be synced to the API. It will be synced on next `watch` startup."

```
$ data-hub watcher config edit

Current instrument: spectramax-id3-plate-reader
? Watch directory [/data/spectramax-id3]:
? File types [*.xls]: *.xls, *.xlsx
? Run detection method [prefix]:
? Prefix pattern [^([^_]+)]:
? File stability period in seconds [5]:
? Upload mode [auto]:
? Enabled [true]:

✓ Configuration updated.
✓ Configuration synced to Data Hub API.
```

## `data-hub watcher config open`

Opens the config file in the user's preferred text editor:

- Uses the `$EDITOR` environment variable if set
- Falls back to `notepad` on Windows, `nano` on macOS/Linux
- Overridable via `--editor` flag (e.g., `--editor code`)

After the editor closes, re-runs validation and pushes the config to the API (same sync behavior and failure handling as `config edit`).

## `data-hub watcher config path`

Prints the resolved config file path to stdout. Useful for scripting.

## `data-hub watcher watch`

Starts a long-running process that monitors the configured directory and uploads matching files to S3. See [FILE_MONITORING.md](./FILE_MONITORING.md) and [UPLOAD.md](./UPLOAD.md) for detailed behavior.

Startup sequence:

1. Load and validate the config.
2. Confirm the instrument and watcher are registered with the API.
3. Compare the local config file checksum against the API (see [API_CLIENT.md](./API_CLIENT.md), config sync section). If they differ, push the local config.
4. Perform an initial scan of the watch directory (see [FILE_MONITORING.md](./FILE_MONITORING.md)).
5. Begin filesystem monitoring and heartbeat loop.

The process runs until interrupted with Ctrl+C (SIGINT/SIGTERM), at which point it sends a final "stopping" heartbeat and exits cleanly.

**Manual mode behavior:** When `upload_mode` is `manual`, the `watch` command operates differently after startup:

1. **Run detection** replaces immediate upload. Detected files are grouped into instrument runs using the `run_detection` config (see [FILE_MONITORING.md](./FILE_MONITORING.md)). Files are not uploaded to S3 automatically.
2. **Run reporting.** As files become stable (file-level stability), they are grouped into runs and reported to the API immediately via `POST /api/instrument-runs` with status `reported`. If a run has already been reported and new files arrive for it, the watcher sends an update via `PATCH /api/instrument-runs/{id}` with the updated file list. The watcher does not attempt to determine when a run is "complete" — it reports what it has observed so far. **A run must be reported to the API before any of its files can be uploaded to S3** — this applies to both auto and manual mode.
3. **Upload queue polling.** On each heartbeat interval, the watcher polls `GET /api/watchers/{watcher_id}/upload-queue` for runs that a user has selected for upload via the web UI. For each queued run, the watcher uploads all associated files to S3, then notifies the API via `PATCH /api/instrument-runs/:id` with the updated status and file records. Only runs that have already been reported (step 2) can appear in the upload queue.
4. The local state database (see [FILE_MONITORING.md](./FILE_MONITORING.md)) tracks which runs have been reported and which have been uploaded, preventing duplicate reports on restart.

**`--dry-run` flag:** Logs all detected files and the S3 keys they would be uploaded to, without performing actual uploads or sending heartbeats. In manual mode, logs detected runs and their file groupings without reporting to the API.

## `data-hub watcher upload`

One-shot upload of a single file to S3.

- `--file <path>`: Path to the file to upload (required).
- `--dry-run`: Log the S3 key without performing the upload.
- The S3 key is `{instrument.id}/{filename}`, derived from config.
- Validates config before uploading.
- Confirms the instrument is registered and not pending (same check as `watch`). Refuses to upload if the instrument is still pending.
- Does not require the watcher to be running.

## Acceptance Criteria

1. `data-hub watcher init` fetches instruments from the API, registers a watcher, writes a valid config to `~/.data-hub/config.yaml`, and pushes the config to the API.
2. `data-hub watcher init` with a new instrument ID sends a registration request to the API and writes the pending instrument to config.
3. `data-hub watcher init` fails if the Data Hub API is unreachable.
4. `data-hub watcher config show` displays a human-readable summary including watcher ID and environment.
5. `data-hub watcher config edit` updates the local config and pushes to the API; warns if the API is unreachable.
6. `data-hub watcher config open` opens the config in the system editor, re-validates on close, and pushes to the API.
7. `data-hub watcher watch --dry-run` logs all activity without performing uploads or sending heartbeats.
8. `data-hub watcher upload --file <path>` uploads a single file to the correct S3 path.
9. `data-hub watcher upload` refuses to upload if the instrument is still pending.
10. `data-hub watcher init` prompts for `run_detection` and `upload_mode` independently.
