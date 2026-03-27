# Watcher: Configuration & Validation

Prerequisite reading: [ARCHITECTURE.md](../ARCHITECTURE.md).

Maps to `models.py`, `config_io.py`, `constants.py` in the watcher module structure.

## Config File Location

- Default path: `~/.data-hub/config.yaml`
- Overridable via `--config` flag or `DATA_HUB_CONFIG_PATH` environment variable
- The CLI must create `~/.data-hub/` on first run if it doesn't exist

## Schema Definition

```yaml
version: 1

environment: staging
watcher_id: a1b2c3d4-e5f6-7890-abcd-ef1234567890

instrument:
  id: spectramax-id3-plate-reader
  watch_directory: /path/to/instrument/output
  file_patterns:
    - "*.xls"
  enabled: true
  upload_mode: auto
```

For instruments that generate large amounts of data, the watcher can be configured to report detected instrument runs without uploading them, allowing users to select which instrument runs to upload via the web UI:

```yaml
version: 1

environment: staging
watcher_id: a1b2c3d4-e5f6-7890-abcd-ef1234567890

instrument:
  id: mass-spec-instrument
  watch_directory: /path/to/instrument/output
  file_patterns:
    - "*.csv"
  enabled: true
  upload_mode: manual
  run_detection:
    method: prefix
    prefix_pattern: "^([^_]+)"
```

## Field Definitions

| Field | Type | Required | Description |
|---|---|---|---|
| `version` | `int` | Yes | Schema version for forward compatibility. Currently `1`. |
| `environment` | `str` | Yes | Must be `"staging"` or `"production"`. Determines which S3 bucket and API URL to target. |
| `watcher_id` | `str` | No | UUID assigned by the Data Hub API during registration. Written automatically by `init`; not user-editable. |
| `instrument` | `InstrumentConfig` | Yes | The instrument configuration. |
| `instrument.id` | `str` | Yes | Kebab-case identifier for the instrument (e.g., `spectramax-id3-plate-reader`). Must be registered with the Data Hub API. Also used as the S3 key prefix. |
| `instrument.watch_directory` | `str` | Yes | Absolute path to the local directory to watch. Must exist on the filesystem. |
| `instrument.file_patterns` | `list[str]` | Yes | One or more glob patterns (e.g., `*.xls`, `*.csv`). At least one required. |
| `instrument.enabled` | `bool` | No | Defaults to `true`. Allows disabling the watcher without removing the config. |
| `instrument.upload_mode` | `str` | No | `"auto"` (default) or `"manual"`. In `auto` mode, files are uploaded to S3 immediately on detection (existing behavior). In `manual` mode, the watcher detects and groups files into instrument runs and reports them to the API, but does not upload. Users select runs for upload via the web UI. |
| `instrument.run_detection` | `RunDetectionConfig` | Conditional | Required when `upload_mode` is `"manual"`. Configures how files are grouped into instrument runs. |
| `instrument.run_detection.method` | `str` | Yes | `"prefix"` or `"directory"`. `"prefix"`: files whose names share a common prefix (extracted via regex) belong to the same run. `"directory"`: files within the same top-level subdirectory belong to the same run, and the directory name is the run ID. |
| `instrument.run_detection.prefix_pattern` | `str` | No | Regex applied to filenames; the first capture group extracts the run ID. Default: `^([^_]+)` (everything before the first underscore). Only used when `method` is `"prefix"`. |

## Derived Values (not stored in config)

The following values are derived at runtime, not stored in the config file:

| Value | Derivation |
|---|---|
| **API base URL** | Resolved from `environment` via a hardcoded mapping in the codebase (see [API_CLIENT.md](./API_CLIENT.md)). |
| **S3 bucket** | `arcadia-raw-data-hub-{environment}` |
| **S3 key prefix** | `{instrument.id}/` (always equals the instrument ID) |
| **Heartbeat interval** | Codebase constant (default: 60 seconds) |

## Pydantic Models

Define the following Pydantic models (e.g., in `src/data_hub_utils/watcher/models.py`):

- **`RunDetectionConfig`** — validates the run detection settings (used only when `upload_mode` is `"manual"`)
  - `method`: Literal `"prefix"` or `"directory"`
  - `prefix_pattern`: Optional regex string. Required if `method` is `"prefix"`. Must contain exactly one capture group. Default: `^([^_]+)`.
- **`InstrumentConfig`** — validates the instrument entry
  - `id`: Non-empty kebab-case string (regex: `^[a-z0-9]+(-[a-z0-9]+)*$`)
  - `watch_directory`: Must be a `Path` that exists and is a directory
  - `file_patterns`: Non-empty list of strings; each must be a valid glob pattern
  - `enabled`: Defaults to `True`
  - `upload_mode`: Literal `"auto"` or `"manual"`, default `"auto"`
  - `run_detection`: Optional `RunDetectionConfig`. Required if `upload_mode` is `"manual"`.
- **`WatcherConfig`** — validates the full config file
  - `version`: Must be `1`
  - `environment`: Literal `"staging"` or `"production"`
  - `watcher_id`: Optional UUID string
  - `instrument`: Single `InstrumentConfig` (required)

## Validation Rules

**Errors (block operation):**

- `instrument.id` is not valid kebab-case
- `instrument.watch_directory` does not exist or is not a directory
- `instrument.file_patterns` is empty
- `environment` is not `"staging"` or `"production"`
- Config file is malformed YAML or does not match the schema
- `instrument.upload_mode` is not `"auto"` or `"manual"`
- `instrument.upload_mode` is `"manual"` but `instrument.run_detection` is missing
- `instrument.run_detection.method` is not `"prefix"` or `"directory"`
- `instrument.run_detection.method` is `"prefix"` but `prefix_pattern` is not a valid regex or does not contain exactly one capture group

**Warnings (logged, do not block):**

- `instrument.watch_directory` contains no files matching any pattern
- `instrument.enabled` is `false`

Config validation (`data-hub watcher config validate`) is purely local — no network calls. API-side checks (instrument exists, watcher is registered) happen at `init` time and `watch` startup.

## Module Structure

```
src/data_hub_utils/
├── watcher/
│   ├── __init__.py
│   ├── models.py          # Pydantic models for config validation
│   ├── constants.py       # API URL mapping, heartbeat interval, file stability defaults
│   ├── config_io.py       # YAML read/write, path resolution, checksum
│   ├── api_client.py      # Data Hub API client
│   ├── monitor.py         # watchdog event handler and stability detection
│   ├── run_detector.py    # Run detection, grouping, and reporting
│   ├── uploader.py        # S3 upload logic with retry and ledger
│   ├── heartbeat.py       # Heartbeat loop (background thread)
│   ├── events.py          # Event reporting to the Data Hub API
│   ├── service.py         # Windows Service wrapper (pywin32, Windows only)
│   └── cli.py             # Click CLI commands
```

## Dependencies

| Dependency | Purpose | Status |
|---|---|---|
| `click` | CLI framework | Already in `pyproject.toml` |
| `pydantic` | Config validation | Already in `pyproject.toml` |
| `pyyaml` | YAML parsing | **New** |

## Acceptance Criteria

1. `data-hub watcher config validate` catches all structural errors (malformed YAML, non-kebab-case ID, missing fields) without network calls.
2. `data-hub watcher config validate` catches missing `run_detection` when `upload_mode` is `manual` and invalid `prefix_pattern`.
