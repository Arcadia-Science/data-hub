# Watcher: File Upload

Prerequisite reading: [ARCHITECTURE.md](../ARCHITECTURE.md), [CONFIG_AND_VALIDATION.md](./CONFIG_AND_VALIDATION.md).

Maps to `uploader.py` in the watcher module structure.

## Upload Path

The S3 object key for any uploaded file is:

```
{instrument.id}/{run_id}/{filename}
```

The `run_id` is the instrument run identifier determined by the watcher's run detection logic (prefix extraction or directory name — see [FILE_MONITORING.md](./FILE_MONITORING.md)). Including the `run_id` in the key prevents collisions when different runs contain files with the same name (e.g., `data_file_1.csv` in two different directory-mode runs).

The target bucket is `arcadia-raw-data-hub-{environment}`, derived from the `environment` field in the config.

## Upload Process

1. Confirm the instrument is registered and not pending (same check as `watch` startup). Refuse to upload if the instrument is still pending.
2. Confirm the file belongs to an instrument run that has already been reported to the API. The run must exist before upload — see [FILE_MONITORING.md](./FILE_MONITORING.md) (run detection / run reporting).
3. Construct the S3 URI: `s3://arcadia-raw-data-hub-{environment}/{instrument.id}/{run_id}/{filename}`
4. Use the existing `s3_utils.upload_file` function, which handles MIME type detection and `Content-Disposition` for images.
5. On success: log the upload and insert a row into the `uploaded_files` table in the local state database (see [FILE_MONITORING.md](./FILE_MONITORING.md)).
6. On failure: log the error and retry up to 3 times with exponential backoff (1s, 2s, 4s). After 3 failures, log the file as failed and move on. Failed files are retried on the next watcher restart (they won't be in the database).

## Logging

All watcher activity is logged to three channels:

**1. Local log file** (`~/.data-hub/watcher.log`) — rotating, full-fidelity record of all activity:

- File detected
- Stability wait started / completed
- Upload started / completed / failed
- Heartbeat sent / failed
- Config sync events
- Run detected / reported / updated (manual mode)
- Upload queue polled / file queued for upload (manual mode)
- File upload started / completed / failed (manual mode)
- Service start / stop (Windows Service mode)

**2. stdout** — same content as the log file. When running as a Windows Service, stdout is not visible; the log file and event reporting (below) are the primary observability channels.

**3. Data Hub API** (event reporting) — a curated subset of significant events sent to `POST /watchers/{watcher_id}/events` for centralized visibility in the web UI. See [API_CLIENT.md](./API_CLIENT.md) for event types and payload schema. This enables remote troubleshooting without RDP access to the lab PC.

## Dependencies

| Dependency | Purpose | Status |
|---|---|---|
| `boto3` | S3 uploads | Via `data-hub-shared` |

## Acceptance Criteria

1. `data-hub-watcher upload --file <path>` uploads a single file to the correct S3 path.
2. `data-hub-watcher upload` refuses to upload if the instrument is still pending.
