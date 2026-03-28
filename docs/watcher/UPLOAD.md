# Watcher: File Upload

Prerequisite reading: [ARCHITECTURE.md](../ARCHITECTURE.md), [CONFIG_AND_VALIDATION.md](./CONFIG_AND_VALIDATION.md).

Maps to `uploader.py` in the watcher module structure.

## Upload Path

The S3 object key for any uploaded file is:

```
{instrument.id}/{filename}
```

The target bucket is `arcadia-raw-data-hub-{environment}`, derived from the `environment` field in the config.

## Upload Process

1. Confirm the instrument is registered and not pending (same check as `watch` startup). Refuse to upload if the instrument is still pending.
2. Construct the S3 URI: `s3://arcadia-raw-data-hub-{environment}/{instrument.id}/{filename}`
3. Use the existing `s3_utils.upload_file` function, which handles MIME type detection and `Content-Disposition` for images.
4. On success: log the upload and write to the deduplication ledger.
5. On failure: log the error and retry up to 3 times with exponential backoff (1s, 2s, 4s). After 3 failures, log the file as failed and move on. Failed files are retried on the next watcher restart (they won't be in the ledger).

## Logging

All watcher activity is logged to three channels:

**1. Local log file** (`~/.data-hub/watcher.log`) — rotating, full-fidelity record of all activity:

- File detected
- Stability wait started / completed
- Upload started / completed / failed
- Heartbeat sent / failed
- Config sync events
- Run detected / reported / updated (manual mode)
- Upload queue polled / run queued for upload (manual mode)
- Run upload started / completed / failed (manual mode)
- Service start / stop (Windows Service mode)

**2. stdout** — same content as the log file. When running as a Windows Service, stdout is not visible; the log file and event reporting (below) are the primary observability channels.

**3. Data Hub API** (event reporting) — a curated subset of significant events sent to `POST /watchers/{watcher_id}/events` for centralized visibility in the web UI. See [API_CLIENT.md](./API_CLIENT.md) for event types and payload schema. This enables remote troubleshooting without RDP access to the lab PC.

## Dependencies

| Dependency | Purpose | Status |
|---|---|---|
| `boto3` | S3 uploads | Via `data-hub-shared` |

## Acceptance Criteria

1. `data-hub watcher upload --file <path>` uploads a single file to the correct S3 path.
2. `data-hub watcher upload` refuses to upload if the instrument is still pending.
