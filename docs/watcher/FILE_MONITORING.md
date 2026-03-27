# Watcher: File Monitoring

Prerequisite reading: [ARCHITECTURE.md](../ARCHITECTURE.md), [CONFIG_AND_VALIDATION.md](./CONFIG_AND_VALIDATION.md), [UPLOAD.md](./UPLOAD.md).

Maps to `monitor.py`, `run_detector.py` in the watcher module structure.

## Library

Use [`watchdog`](https://github.com/gorakhargosh/watchdog) for cross-platform filesystem event monitoring.

## Initial Scan

On startup, the watcher performs a full scan of `instrument.watch_directory` for files matching `instrument.file_patterns`. Any files not already in the upload ledger (see deduplication section below) are queued for upload.

## Event Handling

After the initial scan, the watcher listens for `FileCreatedEvent` and `FileModifiedEvent` events in the watch directory. Only files whose names match at least one glob pattern in `instrument.file_patterns` are processed. All other events are ignored.

**Auto mode:** The watcher does **not** recurse into subdirectories — only top-level files in the watch directory are monitored.

**Manual mode with `directory` run detection:** The watcher monitors top-level subdirectories and their contents. When a new subdirectory appears, the watcher begins tracking files within it as part of a single instrument run. Files directly in the watch directory (not in a subdirectory) are ignored in this mode.

**Manual mode with `prefix` run detection:** Same as auto mode — only top-level files are monitored. Files are grouped into runs by applying the `prefix_pattern` regex to each filename.

## Stability Detection

Instrument software may write files incrementally (e.g., large TIFF images). The watcher must not upload a file while it is still being written.

1. When a matching file event is detected, record the file's size and modification time.
2. Wait a configurable **stability period** (default: 5 seconds, defined in `watcher/constants.py`).
3. Re-check the file's size and modification time. If unchanged, the file is considered stable and is queued for upload.
4. If changed, reset the stability timer.
5. Cap the maximum wait at a configurable timeout (default: 5 minutes) after which the file is logged as an error and skipped.

## Deduplication

To avoid re-uploading files on watcher restart, the watcher maintains a local upload ledger.

- **Location:** `~/.data-hub/upload_ledger.json`
- **Schema:** Maps `filename -> { sha256, uploaded_at, s3_key }`
- **Initial scan:** Skip files whose name and SHA-256 hash match a ledger entry.
- **After upload:** Write the entry to the ledger.
- **Append-only:** The ledger is never automatically pruned (manual cleanup or future garbage collection).

## Run Detection (manual mode only)

When `upload_mode` is `manual`, stable files (see stability detection above) are not uploaded immediately. Instead, they are grouped into instrument runs and reported to the API.

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

1. **New run:** When a stable file is assigned to a run ID that has not yet been reported, send `POST /api/instrument-runs` with:
  - `instrument_id` from config
  - `run_id` — the detected run ID
  - `status`: `"reported"`
  - `watcher_id` from config
  - `detected_files`: list of `{ relative_path, filename, size_bytes }`
2. On success, write the run to the run ledger (see below).
3. On API failure, retry on the next heartbeat interval. The run stays in the in-memory tracker until successfully reported.
4. **Existing run:** When a stable file is assigned to a run ID that has already been reported (and is still in `reported` status), send `PATCH /api/instrument-runs/{id}` with the updated file list. Runs that have already been queued for upload or uploaded are not modified.

## Run Ledger (manual mode only)

In addition to the upload ledger, manual mode maintains a run ledger to track reported and uploaded runs.

- **Location:** `~/.data-hub/run_ledger.json`
- **Schema:** Maps `run_id -> { status, reported_at, uploaded_at, files: [{ relative_path, filename, size_bytes }] }`
- **Status values:** `reported`, `queued_for_upload`, `uploading`, `uploaded`
- **Initial scan:** On startup, skip runs already present in the run ledger with status `reported` or `uploaded`. Runs with status `queued_for_upload` are checked against the upload queue.
- **After reporting:** Write the run entry with status `reported`.
- **After upload:** Update the run entry with status `uploaded` and `uploaded_at`.

## Upload Queue Polling (manual mode only)

On each heartbeat interval, if `upload_mode` is `manual`, the watcher also polls the API for runs that have been queued for upload:

1. Call `GET /api/watchers/{watcher_id}/upload-queue`.
2. For each returned run:
   a. Verify that all files listed in the run are still present on the local filesystem. If any are missing, report an error to the API and skip the run.
   b. Update the run ledger status to `uploading`.
   c. Upload each file to S3 using the same upload logic as auto mode (see [UPLOAD.md](./UPLOAD.md)), with S3 key `{instrument.id}/{relative_path}`.
   d. On success, call `PATCH /api/instrument-runs/{id}` with status `uploaded` and the S3 file records.
   e. Update the run ledger status to `uploaded`.
   f. Write each file to the upload ledger for deduplication.

## Dependencies

| Dependency | Purpose | Status |
|---|---|---|
| `watchdog` | Filesystem event monitoring | **New** |

## Acceptance Criteria

1. `data-hub watcher watch` detects new files in the watch directory and uploads them to the correct S3 path (`{instrument.id}/{filename}`).
2. `data-hub watcher watch` waits for file stability before uploading.
3. `data-hub watcher watch` does not re-upload files already present in the upload ledger on restart.
4. `data-hub watcher watch` in manual mode with `prefix` detection groups files by the configured prefix pattern and reports runs to the API as files become stable.
5. `data-hub watcher watch` in manual mode with `directory` detection monitors subdirectories and reports runs to the API as files become stable.
6. `data-hub watcher watch` in manual mode polls the upload queue and uploads files for runs that have been queued via the web UI.
7. `data-hub watcher watch` in manual mode correctly handles the case where local files have been deleted before upload is requested (reports error to API).
8. The run ledger (`~/.data-hub/run_ledger.json`) prevents duplicate run reports on watcher restart.
