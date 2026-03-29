# Database Schema

PostgreSQL, hosted via a managed service (e.g., Supabase, Neon, or RDS). Schema managed via Drizzle ORM with migrations checked into version control.

## Entity-Relationship Summary

```
User 1──* PersonalAccessToken

Instrument 1──* InstrumentRun 1──* File 1──* RunReportData
     │                │              │
     │                │              └── metadata, status (per-file processing)
     │                │
     │                ├──* RunReportData (run-level analyses, file_id NULL)
     │                │
     │                └──* ReportedFile
     │
     └──* Watcher ──* WatcherHeartbeat
              │
              ├──* WatcherEvent
              │
              └──* InstrumentRun (via watcher_id, for manual-mode runs)
```

## Tables

### `users`

Authenticated users. Managed by Auth.js — rows are created automatically on first sign-in via Google OAuth.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `text` | PK | Auth.js-generated user ID. |
| `name` | `text` | | Display name from Google profile. |
| `email` | `text` | UNIQUE | Google email address. |
| `email_verified` | `timestamptz` | | When the email was verified. |
| `image` | `text` | | Profile image URL from Google. |

### `accounts`

OAuth account links. Managed by Auth.js — one row per provider per user.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `user_id` | `text` | FK → `users.id`, NOT NULL | |
| `type` | `text` | NOT NULL | Account type (e.g., `oauth`). |
| `provider` | `text` | NOT NULL | OAuth provider (e.g., `google`). |
| `provider_account_id` | `text` | NOT NULL | Provider's user ID. |
| `refresh_token` | `text` | | OAuth refresh token. |
| `access_token` | `text` | | OAuth access token. |
| `expires_at` | `integer` | | Token expiry (Unix timestamp). |
| `token_type` | `text` | | |
| `scope` | `text` | | |
| `id_token` | `text` | | |

Primary key on `(provider, provider_account_id)`.

### `sessions`

Active browser sessions. Managed by Auth.js.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `session_token` | `text` | PK | Opaque session token. |
| `user_id` | `text` | FK → `users.id`, NOT NULL | |
| `expires` | `timestamptz` | NOT NULL | Session expiry. |

### `personal_access_tokens`

User-created tokens for authenticating with the API from external clients (e.g., the file upload service, the Lambda function, or scripts).

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `uuid` | PK, DEFAULT `gen_random_uuid()` | |
| `user_id` | `text` | FK → `users.id`, NOT NULL | The user who created this token. |
| `name` | `text` | NOT NULL | User-provided label (e.g., "Lab PC watcher", "Lambda production"). |
| `token_hash` | `text` | NOT NULL, UNIQUE | SHA-256 hash of the token. The plaintext token is shown once at creation and never stored. |
| `token_prefix` | `text` | NOT NULL | First 8 characters of the token, stored for display purposes (e.g., `dhub_a1b2...`). |
| `last_used_at` | `timestamptz` | | Updated on each API call authenticated with this token. |
| `expires_at` | `timestamptz` | | Optional expiry. `NULL` means no expiry. |
| `created_at` | `timestamptz` | NOT NULL, DEFAULT `now()` | |

Tokens use a `dhub_` prefix for easy identification (e.g., `dhub_a1b2c3d4e5f6...`). The full token is returned once in the `POST` response; only the hash is persisted.

### `instruments`

The source of truth for registered instruments. Replaces the `Instrument` enum for API consumers (the watcher, the web UI). The Lambda function may continue to reference the enum internally.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `text` | PK | Kebab-case identifier (e.g., `spectramax-id3-plate-reader`). Also used as the first segment of the S3 key (`{instrument_id}/{run_id}/{filename}`). |
| `display_name` | `text` | NOT NULL | Human-readable name (e.g., "SpectraMax iD3 Plate Reader"). |
| `status` | `text` | NOT NULL, DEFAULT `'active'` | One of `pending`, `active`, `inactive`. New instruments registered via the watcher CLI start as `pending` until confirmed by an admin. |
| `file_patterns` | `text[]` | | Suggested glob patterns for the file upload service (e.g., `["*.xls"]`). |
| `s3_trigger_suffix` | `text` | | The file extension suffix configured on the S3→Lambda trigger (e.g., `.xls`). Used for validation warnings in the watcher. |
| `created_at` | `timestamptz` | NOT NULL, DEFAULT `now()` | |
| `updated_at` | `timestamptz` | NOT NULL, DEFAULT `now()` | |

Seed data: the six instruments currently in the `Instrument` enum, all with `status = 'active'`.

### `watchers`

Registered file upload service instances. One watcher per instrument PC.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `uuid` | PK, DEFAULT `gen_random_uuid()` | The `watcher_id` returned to the CLI on registration. |
| `instrument_id` | `text` | FK → `instruments.id`, NOT NULL | |
| `hostname` | `text` | | The hostname of the machine running the watcher. |
| `os_info` | `text` | | OS description (e.g., "Windows 11 23H2"). |
| `config_checksum` | `text` | | SHA-256 of the last-pushed config YAML. |
| `config_yaml` | `text` | | The raw YAML text of the watcher's config file, stored verbatim as pushed by the watcher. |
| `last_heartbeat_at` | `timestamptz` | | Updated on each heartbeat. |
| `status` | `text` | NOT NULL, DEFAULT `'registered'` | One of `registered`, `watching`, `stopped`, `stale`. |
| `created_at` | `timestamptz` | NOT NULL, DEFAULT `now()` | |
| `updated_at` | `timestamptz` | NOT NULL, DEFAULT `now()` | |
| `deleted_at` | `timestamptz` | | Soft-delete marker. `NULL` means active; non-`NULL` means deregistered. Queries should filter on this column to exclude deregistered watchers. |

A watcher is considered `stale` if no heartbeat has been received for more than 5 minutes (configurable). This can be determined at query time or via a periodic job.

### `watcher_heartbeats`

Append-only log of heartbeats from watchers. Used for uptime monitoring and diagnostics. Rows should be pruned periodically (e.g., retain 30 days) to prevent unbounded growth.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `bigint` | PK, generated | |
| `watcher_id` | `uuid` | FK → `watchers.id`, NOT NULL | |
| `timestamp` | `timestamptz` | NOT NULL | Client-reported timestamp. |
| `status` | `text` | NOT NULL | Status string from the heartbeat payload (e.g., `watching`, `stopping`). |
| `upload_mode` | `text` | | `auto` or `manual`. Included so heartbeat history is interpretable without joining the watcher config. |
| `files_uploaded_since_last` | `int` | DEFAULT `0` | |
| `runs_reported_since_last` | `int` | DEFAULT `0` | Manual mode only. |
| `runs_uploaded_since_last` | `int` | DEFAULT `0` | Manual mode only. |
| `errors_since_last` | `int` | DEFAULT `0` | |
| `uptime_seconds` | `int` | | |
| `created_at` | `timestamptz` | NOT NULL, DEFAULT `now()` | Server-side receive time. |

### `watcher_events`

Significant events reported by watchers. Provides centralized visibility into watcher activity without requiring RDP access to the lab PC. Events are a curated subset of watcher log entries — not every log line, only meaningful state changes and outcomes.

Rows should be pruned periodically (e.g., retain 90 days) to prevent unbounded growth.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `bigint` | PK, generated | |
| `watcher_id` | `uuid` | FK → `watchers.id`, NOT NULL | |
| `event_type` | `text` | NOT NULL | One of `watcher_started`, `watcher_stopped`, `file_uploaded`, `upload_failed`, `run_reported`, `run_uploaded`, `config_synced`, `error`. |
| `message` | `text` | NOT NULL | Human-readable summary (e.g., "Uploaded 2026-03-26_experiment.xls to S3"). |
| `details` | `jsonb` | | Structured event data. Shape varies by `event_type` — see [watcher/API_CLIENT.md](./watcher/API_CLIENT.md), section on event reporting. |
| `timestamp` | `timestamptz` | NOT NULL | Client-reported event time. |
| `created_at` | `timestamptz` | NOT NULL, DEFAULT `now()` | Server-side receive time. |

### `instrument_runs`

One record per instrument run, replacing the Notion report page as the primary record. A run is a logical grouping of files — it is created either by the watcher (which detects a run on the instrument PC) or by the Lambda function (which auto-creates a run when a file arrives in S3 without watcher involvement). The run itself has no processing status; processing status is tracked per file in the `files` table.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `uuid` | PK, DEFAULT `gen_random_uuid()` | Surrogate primary key. The natural key is `(instrument_id, run_id)`. |
| `instrument_id` | `text` | FK → `instruments.id`, NOT NULL | |
| `run_id` | `text` | NOT NULL | The run identifier — derived by the Lambda function for auto-mode runs (e.g., filename without extension), or by the watcher's run detection logic for manual-mode runs (e.g., shared prefix, directory name). |
| `source` | `text` | NOT NULL, DEFAULT `'lambda'` | How the run was created. One of `lambda` (auto-created by the Lambda function when a file arrives in S3 without a pre-existing run) or `watcher` (reported by the watcher). |
| `watcher_id` | `uuid` | FK → `watchers.id` | Set when the run was reported by a watcher. `NULL` for Lambda-created runs. |
| `metadata` | `jsonb` | NOT NULL, DEFAULT `'{}'` | Run-level metadata, written via `PATCH /api/v1/instruments/:instrumentId/runs/:runId`. Typically set by the Lambda function after processing all files in a run (aggregated from per-file metadata) or by a run-level analysis pipeline. Stored as a flat object; multi-valued properties use JSON arrays (e.g., `{"dye_channel": ["FAM", "SYBR"]}`). |
| `upload_requested_at` | `timestamptz` | | Manual mode only. Set when a user requests upload via the web UI. The watcher polls for runs where this is non-`NULL` to determine what to upload. `NULL` for auto-mode runs and runs not yet queued for upload. |
| `created_at` | `timestamptz` | NOT NULL, DEFAULT `now()` | When the run was first created (reported by watcher or auto-created by Lambda). |
| `updated_at` | `timestamptz` | NOT NULL, DEFAULT `now()` | |
| `deleted_at` | `timestamptz` | | Soft-delete marker. `NULL` means active; non-`NULL` means deleted. Queries should filter on this column to exclude deleted runs. S3 objects are retained until `files_purged_at` is set by the lifecycle job. |
| `files_purged_at` | `timestamptz` | | Set by the S3 lifecycle cleanup job when S3 objects for this run have been permanently deleted. `NULL` means S3 objects are still available (either the run is active, or it's within the soft-delete retention window). A run with `deleted_at` set but `files_purged_at` NULL can still be restored with full data. |

Unique constraint on `(instrument_id, run_id)`.

### `reported_files`

Files detected by the watcher for runs in manual mode, before they have been uploaded to S3. These records allow the web UI to display file details (names, sizes) for reported runs that haven't been uploaded yet. Once a run is uploaded and the files are recorded in the `files` table (with S3 keys), the corresponding `reported_files` rows are no longer the primary source of truth but are retained for audit purposes.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `bigint` | PK, generated | |
| `instrument_run_id` | `uuid` | FK → `instrument_runs.id`, NOT NULL | |
| `relative_path` | `text` | NOT NULL | Path relative to the watcher's watch directory (e.g., `20260325_data_file_1.csv` or `20260325_testing/data_file_1.csv`). |
| `filename` | `text` | NOT NULL | The filename component (last segment of the path). |
| `size_bytes` | `bigint` | | File size at detection time. |
| `detected_at` | `timestamptz` | NOT NULL, DEFAULT `now()` | When the watcher first detected this file. |

Unique constraint on `(instrument_run_id, relative_path)`.

### `files`

Every file uploaded to S3 for an instrument run. Each file has its own processing status — the Lambda function processes files individually as they arrive in S3, extracting metadata and (for instruments that require it) parsing structured data.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `bigint` | PK, generated | |
| `instrument_run_id` | `uuid` | FK → `instrument_runs.id`, NOT NULL | |
| `s3_bucket` | `text` | NOT NULL | |
| `s3_key` | `text` | NOT NULL, UNIQUE | |
| `filename` | `text` | NOT NULL | Original filename. |
| `content_type` | `text` | | MIME type. |
| `size_bytes` | `bigint` | | |
| `category` | `text` | NOT NULL, DEFAULT `'raw'` | One of `raw`, `processed`. Distinguishes raw uploads from Lambda-generated artifacts. |
| `status` | `text` | NOT NULL, DEFAULT `'uploaded'` | One of `uploaded`, `processing`, `completed`, `failed`. See file status lifecycle below. |
| `metadata` | `jsonb` | NOT NULL, DEFAULT `'{}'` | Instrument-specific key-value metadata extracted by the Lambda function from this file (e.g., `{"measurement_mode": "Fluorescence", "wavelength": "450"}`). Stored as a flat object; multi-valued properties use JSON arrays. |
| `error_message` | `text` | | Human-readable error description if `status = 'failed'`. `NULL` otherwise. |
| `processed_at` | `timestamptz` | | When the Lambda function finished processing this file (regardless of success or failure). |
| `created_at` | `timestamptz` | NOT NULL, DEFAULT `now()` | |

**File status lifecycle:**

```
uploaded → processing → completed
                     ↘ failed
```

- `uploaded` — the file has been uploaded to S3 (by the watcher or via direct upload) but has not yet been processed by the Lambda function.
- `processing` — the Lambda function has been triggered by the S3 event and is processing this file.
- `completed` — the Lambda function successfully extracted metadata and (if applicable) parsed structured data from this file.
- `failed` — the Lambda function encountered an error processing this file. See `error_message` for details.

**Known metadata keys by instrument** (derived from current Ganymede tags and Notion properties):

| Instrument | Metadata keys | Value type |
|---|---|---|
| Agilent 4150 TapeStation | `tape_type` | string |
| Akta FPLC | `column_type` | string |
| Azure 600 Gel Doc | `imaging_mode`, `capture_type`, `wavelength`, `wavelength_color` | string, string, string[], string[] |
| Azure Cielo qPCR | `dye_channel` | string[] |
| SpectraMax iD3 Plate Reader | `measurement_mode`, `measurement_type`, `wavelength` | string, string, string |
| SpectraMax iD5 Plate Reader | `measurement_mode`, `measurement_type`, `wavelength` | string, string, string |

Multi-valued properties (marked `string[]`) are stored as JSON arrays within the `metadata` object rather than as separate scalar values.

### `run_report_data`

Structured tabular data extracted by the Lambda function from individual files, or produced by run-level analyses. Replaces the Ganymede BigQuery tables (e.g., `Spectramax_Raw_Well_Data`) and the parsed data displayed in Notion page blocks.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `bigint` | PK, generated | |
| `instrument_run_id` | `uuid` | FK → `instrument_runs.id`, NOT NULL | |
| `file_id` | `bigint` | FK → `files.id` | The source file this data was extracted from. `NULL` for data produced by run-level analyses (which may aggregate across multiple files). |
| `data_type` | `text` | NOT NULL | Identifies the dataset (e.g., `raw_well_data`, `plate_map`, `kinetic_data`, `spectrum_data`, `sample_table`). |
| `data` | `jsonb` | NOT NULL | The structured data as a JSON array of row objects. |
| `created_at` | `timestamptz` | NOT NULL, DEFAULT `now()` | |

This is intentionally schemaless within `data` — each instrument workflow defines the shape of its JSON payload, and the web UI renders it using the `data_type` discriminator.

## Indexes

- `users(email)` — lookup by email (unique index).
- `accounts(user_id)` — accounts for a user.
- `sessions(user_id)` — sessions for a user.
- `personal_access_tokens(user_id)` — tokens for a user.
- `personal_access_tokens(token_hash)` — token lookup on API auth (unique index).
- `instrument_runs(instrument_id, created_at DESC)` — dashboard queries sorted by recency.
- `instrument_runs(instrument_id, created_at DESC) WHERE deleted_at IS NULL` — partial index for active (non-deleted) runs queries, covering the default dashboard and instrument-page views.
- `instrument_runs` GIN index on `metadata` — supports `@>` containment queries for run-level metadata filtering.
- `files(instrument_run_id)` — file list for a run.
- `files(status, instrument_run_id)` — per-file processing queries (e.g., finding all `uploaded` files for a run, or all `failed` files across runs).
- `files` GIN index on `metadata` — supports `@>` containment queries for per-file metadata filtering (e.g., `WHERE metadata @> '{"measurement_mode": "Fluorescence"}'`).
- `run_report_data(instrument_run_id)` — report data for a run.
- `run_report_data(file_id)` — report data for a specific file.
- `reported_files(instrument_run_id)` — reported files for a run.
- `watchers(instrument_id) WHERE deleted_at IS NULL` — partial index for active (non-deleted) watchers per instrument.
- `watcher_heartbeats(watcher_id, timestamp DESC)` — recent heartbeats.
- `watcher_events(watcher_id, timestamp DESC)` — recent events for a watcher.
- `watcher_events(watcher_id, event_type)` — filtering events by type.

## Acceptance Criteria

1. The database schema can be created from Drizzle migrations and seeded with the six existing instruments.
