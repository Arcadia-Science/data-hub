# Watcher: File Monitoring

Prerequisite reading: [ARCHITECTURE.md](../ARCHITECTURE.md), [CONFIG_AND_VALIDATION.md](./CONFIG_AND_VALIDATION.md), [UPLOAD.md](./UPLOAD.md).

Maps to `monitor.py`, `run_detector.py` in the watcher module structure.

## Library

Use [watchdog](https://github.com/gorakhargosh/watchdog) for cross-platform filesystem event monitoring.

## Initial Scan

On startup, the watcher performs a full scan of `instrument.watch_directory` for files matching `instrument.file_patterns`. Any files not already in the local state database (see deduplication section below) are queued for upload.

## Event Handling

After the initial scan, the watcher listens for `FileCreatedEvent` and `FileModifiedEvent` events in the watch directory. Only files whose names match at least one glob pattern in `instrument.file_patterns` are processed. All other events are ignored.

**Auto mode:** The watcher does **not** recurse into subdirectories — only top-level files in the watch directory are monitored.

**Manual mode with `directory` run detection:** The watcher monitors top-level subdirectories and their contents. When a new subdirectory appears, the watcher begins tracking files within it as part of a single instrument run. Files directly in the watch directory (not in a subdirectory) are ignored in this mode.

**Manual mode with `prefix` run detection:** Same as auto mode — only top-level files are monitored. Files are grouped into runs by applying the `prefix_pattern` regex to each filename.

## Stability Detection

Instrument software may write files incrementally (e.g., large TIFF images). The watcher must not upload a file while it is still being written.

1. When a matching file event is detected, record the file's size and modification time.
2. Wait for `instrument.stability_period_seconds` (default: 5 seconds). This value is configured per instrument in the config file — see [CONFIG_AND_VALIDATION.md](./CONFIG_AND_VALIDATION.md). Instruments that write large files incrementally (e.g., multi-GB imaging data) should use a longer period.
3. Re-check the file's size and modification time. If unchanged, the file is considered stable and is queued for upload.
4. If changed, reset the stability timer.
5. Cap the maximum wait at a configurable timeout (default: 5 minutes, defined in `watcher/constants.py`) after which the file is logged as an error and skipped.

## Deduplication

To avoid re-uploading files on watcher restart, the watcher maintains a local state database.

- **Location:** `~/.data-hub/watcher.db` (SQLite). See "Local state database" section below for schema and rationale.
- **`uploaded_files` table columns:** `filename TEXT`, `sha256 TEXT`, `uploaded_at TEXT`, `s3_key TEXT`. Primary key on `(filename, sha256)`.
- **Initial scan:** Skip files whose name and SHA-256 hash match an `uploaded_files` row.
- **After upload:** Insert a row inside the same transaction that marks the upload complete.
- **Pruning:** Rows older than 90 days (by `uploaded_at`) are deleted automatically on watcher startup. This is configurable via a constant in `watcher/constants.py`.

## Run Detection

Stable files (see stability detection above) are grouped into instrument runs using the `run_detection` config. **The run must be reported to the API before any file in that run is uploaded to S3.** In `auto` mode, the watcher reports the run and then uploads its files immediately. In `manual` mode, the watcher reports the run and waits — files are not uploaded until a user queues the run via the web UI.

**Grouping by prefix (`method: prefix`):**

1. When a file becomes stable, apply the `prefix_pattern` regex to the filename.
2. The first capture group is the run ID. If the regex does not match, log a warning and skip the file.
3. Add the file to the in-memory run tracker for that run ID.
4. Report the run to the API immediately (see "Run reporting" below).

Example with `prefix_pattern: ^([^_]+)` and files `20260325_data_file_1.csv`, `20260325_data_file_2.csv`:

- Both match with run ID `20260325`.
- The run is first reported when the first file becomes stable. When the second file becomes stable, the run is updated with the new file list.

**Grouping by directory (`method: directory`):**

1. When a file becomes stable inside a top-level subdirectory, the subdirectory name is the run ID.
2. Add the file to the in-memory run tracker for that run ID.
3. Report the run to the API immediately (see "Run reporting" below).

Example with directory `20260325_testing/` containing `data_file_1.csv`, `data_file_2.csv`:

- Both are assigned run ID `20260325_testing`.
- The run is reported as soon as the first file becomes stable, then updated when additional files arrive.

**Run reporting:**

Runs are reported to the API as soon as the first file in the run becomes stable. Subsequent files trigger updates to the existing run. The watcher does not attempt to determine when a run is "complete."

1. **New run:** When a stable file is assigned to a run ID that has not yet been reported, send `POST /api/v1/instruments/{instrument_id}/runs` with:

- `run_id` — the detected run ID
- `source`: `"watcher"`
- `watcher_id` from config
- `detected_files`: list of `{ relative_path, filename, size_bytes }`

2. On success, write the run to the local state database (see "Local state database" section below).
3. On API failure, retry on the next heartbeat interval. The run stays in the in-memory tracker until successfully reported.
4. **Existing run:** When a stable file is assigned to a run ID that has already been reported (and has not yet been uploaded), send `PATCH /api/v1/instruments/{instrument_id}/runs/{run_id}` with the updated `detected_files` list. Runs whose files have already been uploaded to S3 are not modified.

## Auto-Mode Upload After Reporting

In auto mode, the watcher uploads files immediately after reporting the run.

1. After the run is successfully reported, upload each file to S3 using the same upload logic as manual mode (see [UPLOAD.md](./UPLOAD.md)), with S3 key `{instrument.id}/{run_id}/{filename}`.
2. On success, call `PATCH /api/v1/instruments/{instrument_id}/runs/{run_id}` with the S3 file records.
3. The Lambda function is triggered by the S3 upload and processes each file individually (extracting metadata, parsing data) via `PATCH /api/v1/files/{file_id}`.

## Crash Recovery

The watcher can crash (or be killed) at any point during the report-then-upload sequence. The local SQLite state and the API's upsert semantics together guarantee that every restart converges to the correct state without duplicating side-effects. Three scenarios cover the full window:

**Crash before the run is reported.** The local `runs` table has no entry for this run, and `uploaded_files` has no entries for its files. On restart, the initial scan re-detects the files, re-derives the run ID via the normal grouping logic, and reports it via `POST /runs`. The API upsert (keyed on `instrument_id` + `run_id`) makes this idempotent — if the POST actually reached the server before the crash but the watcher never recorded the response, the API returns the existing run and no duplicate is created.

**Crash after the run is reported but before any files are uploaded.** The local `runs` table has a row with `uploaded_at = NULL`, and `uploaded_files` has no entries for the run's files. On restart, the initial scan finds the files are absent from `uploaded_files`, so they are queued for upload. The watcher checks the `runs` table first: because the run is already reported (`reported_at` is set) but not uploaded (`uploaded_at` is NULL), it skips re-reporting and proceeds directly to upload. After upload completes, it calls `PATCH /runs/{run_id}` with the file records (upserted by `s3_key`, so duplicates are safe) and sets `uploaded_at` in the local `runs` row.

**Crash after some files are uploaded but not all.** The `uploaded_files` table has entries for the successfully uploaded files. On restart, the initial scan skips those files (name + SHA-256 match) and queues only the remaining ones. After uploading the remaining files, the watcher calls `PATCH /runs/{run_id}` with the full file list. The API upserts file records by `s3_key`, so previously recorded files are updated in place rather than duplicated.

## Local State Database

The watcher stores all local state — upload deduplication records and run tracking — in a single SQLite database at `~/.data-hub/watcher.db`. This replaces the earlier design of separate JSON files (`upload_ledger.json`, `run_ledger.json`) and addresses several problems with JSON-file-based state:

- **Atomicity:** SQLite transactions ensure that a crash mid-write cannot corrupt state. JSON files read entirely into memory, modified, and written back can be truncated by a crash, losing all deduplication state.
- **Concurrent access:** SQLite with WAL mode supports concurrent readers and serialized writers. JSON files have no locking and would become a race condition under threads or async workers.
- **Bounded growth:** SQLite rows can be pruned with indexed queries. The `uploaded_files` table is pruned on startup (default: retain 90 days). JSON files required manual cleanup.
- **Reduced duplication:** The run tracking table stores only the minimal state needed to avoid duplicate API calls on restart (`run_id` and timestamps). Detailed run metadata (file lists, timestamps) is the API's responsibility — the watcher does not duplicate it locally.

**Configuration:** Open the database with `journal_mode=WAL` and `synchronous=NORMAL` for crash safety with good write performance.

### `uploaded_files` table

Tracks which files have been uploaded to S3, for deduplication on restart.

| Column        | Type            | Description                                 |
| ------------- | --------------- | ------------------------------------------- |
| `filename`    | `TEXT NOT NULL` | Original filename.                          |
| `sha256`      | `TEXT NOT NULL` | SHA-256 hash of the file at upload time.    |
| `uploaded_at` | `TEXT NOT NULL` | ISO 8601 timestamp.                         |
| `s3_key`      | `TEXT NOT NULL` | The S3 object key the file was uploaded to. |

Primary key on `(filename, sha256)`.

### `runs` table

Tracks which runs have been reported to the API, so the watcher can avoid duplicate reports on restart. The API is the source of truth for run details — this table stores only the minimum needed for local decision-making.

| Column        | Type            | Description                                                         |
| ------------- | --------------- | ------------------------------------------------------------------- |
| `run_id`      | `TEXT NOT NULL` | Primary key. The detected run ID.                                   |
| `reported_at` | `TEXT NOT NULL` | ISO 8601 timestamp of when the run was first reported.              |
| `uploaded_at` | `TEXT`          | ISO 8601 timestamp of when upload completed. `NULL` until uploaded. |

- **Initial scan:** On startup, skip runs already present in the `runs` table.
- **After reporting:** Insert a row with `reported_at` set.
- **After upload:** Set `uploaded_at`.

## Upload Queue Polling (manual mode only)

On each heartbeat interval, if `upload_mode` is `manual`, the watcher also polls the API for runs that have been queued for upload:

1. Call `GET /api/v1/watchers/{watcher_id}/upload-queue`. This returns runs where `upload_requested_at` is set.
2. For each returned run:
   a. Verify that all files listed in the run are still present on the local filesystem. If any are missing, report an error to the API and skip the run.
   b. Upload each file to S3 using the same upload logic as auto mode (see [UPLOAD.md](./UPLOAD.md)), with S3 key `{instrument.id}/{run_id}/{filename}`.
   c. On success, call `PATCH /api/v1/instruments/{instrument_id}/runs/{run_id}` with the S3 file records.
   d. Update the local `runs` row to set `uploaded_at`.
   e. Insert each file into the `uploaded_files` table for deduplication.

## Dependencies

| Dependency | Purpose                                            | Status                      |
| ---------- | -------------------------------------------------- | --------------------------- |
| `watchdog` | Filesystem event monitoring                        | In `watcher/pyproject.toml` |
| `sqlite3`  | Local state database (deduplication, run tracking) | Python standard library     |

## Acceptance Criteria

1. `data-hub-watcher watch` detects new files in the watch directory and uploads them to the correct S3 path (`{instrument.id}/{run_id}/{filename}`).
2. `data-hub-watcher watch` waits for file stability before uploading.
3. `data-hub-watcher watch` does not re-upload files already present in the `uploaded_files` table on restart.
4. `data-hub-watcher watch` in manual mode with `prefix` detection groups files by the configured prefix pattern and reports runs to the API as files become stable.
5. `data-hub-watcher watch` in manual mode with `directory` detection monitors subdirectories and reports runs to the API as files become stable.
6. `data-hub-watcher watch` in manual mode polls the upload queue and uploads files for runs that have been queued via the web UI.
7. `data-hub-watcher watch` in manual mode correctly handles the case where local files have been deleted before upload is requested (reports error to API).
8. `data-hub-watcher watch` in auto mode reports runs to the API, then immediately uploads files and records them via `PATCH`.
9. The local state database (`~/.data-hub/watcher.db`) prevents duplicate run reports on watcher restart.
10. The `uploaded_files` table is pruned of rows older than 90 days on watcher startup.
11. A crash mid-write does not corrupt the local state database.
