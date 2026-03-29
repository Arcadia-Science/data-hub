# Watcher: Data Hub API Integration

Prerequisite reading: [ARCHITECTURE.md](../ARCHITECTURE.md), [CONFIG_AND_VALIDATION.md](./CONFIG_AND_VALIDATION.md).

Maps to `api_client.py`, `heartbeat.py`, `events.py` in the watcher module structure.

## API URL Resolution

The API base URL is derived from the `environment` field via a hardcoded mapping:

| Environment | API URL |
|---|---|
| `staging` | `https://data-hub-staging.arcadiascience.com/api/v1` |
| `production` | `https://data-hub.arcadiascience.com/api/v1` |

This mapping is defined as a constant in `watcher/constants.py`.

## API Contract (watcher's perspective)

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/instruments` | List registered instruments with metadata (id, display name, suggested file patterns). |
| `POST` | `/instruments` | Register a new instrument (created in "pending" state until confirmed by an admin in the Data Hub web UI). |
| `POST` | `/watchers/register` | Register a new watcher instance. Accepts instrument ID, hostname, and OS info. Returns a `watcher_id` (UUID). Config is pushed separately via `PUT /watchers/{watcher_id}/config`. |
| `PUT` | `/watchers/{watcher_id}/config` | Push the raw config YAML and its checksum. |
| `GET` | `/watchers/{watcher_id}/config-checksum` | Returns the SHA-256 checksum of the config last pushed to the API. |
| `POST` | `/watchers/{watcher_id}/heartbeat` | Send a heartbeat with status payload. |
| `POST` | `/watchers/{watcher_id}/events` | Report significant watcher events (uploads, errors, state changes) for centralized visibility in the web UI. |
| `POST` | `/instruments/{instrument_id}/runs` | Report a detected instrument run (auto and manual mode). Sends run ID, detected files, source, and watcher ID. |
| `GET` | `/watchers/{watcher_id}/upload-queue` | Poll for runs that a user has queued for upload via the web UI. Returns runs where `upload_requested_at` is set for this watcher's instrument. |
| `PATCH` | `/instruments/{instrument_id}/runs/{run_id}` | Add file records after upload and update detected files. Both path parameters are natural keys known to the watcher from its config and run detection logic. |

## Authentication

API credentials (e.g., an API key or token) are stored in the `.env` file via the existing `Config` class, not in the watcher config YAML. The watcher reads credentials from the environment at runtime.

## Config Sync

The watcher config is dual-written: local YAML file and the Data Hub API.

**When the config is pushed to the API:**

| Trigger | Behavior |
|---|---|
| `data-hub-watcher init` | Push after writing to disk. Fails if API is unreachable (registration is a prerequisite). |
| `data-hub-watcher config edit` | Push after writing to disk. Warns if API is unreachable; local write still succeeds. |
| `data-hub-watcher config open` | Push after editor closes and validation passes. Same failure handling as `edit`. |
| `data-hub-watcher watch` (startup) | Compute SHA-256 of local config file. Compare against `GET /watchers/{watcher_id}/config-checksum`. If they differ, push. If API is unreachable, log a warning and proceed. |

**Config push payload:**

```json
{
  "config_checksum": "sha256:abc123...",
  "config_yaml": "version: 1\nenvironment: staging\nwatcher_id: a1b2c3d4-e5f6-...\ninstrument:\n  id: spectramax-id3-plate-reader\n  ..."
}
```

The watcher sends the raw YAML text of its config file. The API stores this string as-is — no YAML-to-JSON transformation is performed. This keeps a single canonical config format (the YAML file) and avoids an implicit mapping between the nested YAML structure (`instrument.id`, `instrument.watch_directory`) and a flat JSON representation.

## New Instrument Registration

When a user enters a new instrument ID during `init`:

1. The CLI validates the ID is kebab-case.
2. The CLI sends `POST /instruments` with the ID and an optional display name.
3. The API creates the instrument in a **pending** state.
4. The CLI prints: "Instrument registered as pending. An admin must confirm it in the Data Hub web app before the watcher can start."
5. The `watch` and `upload` commands check instrument status on startup and refuse to run if the instrument is still pending.

## Heartbeat

While `data-hub-watcher watch` is running, the watcher sends a `POST /watchers/{watcher_id}/heartbeat` at a fixed interval (default: 60 seconds, defined as a constant in `watcher/constants.py`).

**Auto mode payload:**

```json
{
  "timestamp": "2026-03-26T20:15:00Z",
  "status": "watching",
  "instrument_id": "spectramax-id3-plate-reader",
  "watch_directory": "/data/spectramax-id3",
  "upload_mode": "auto",
  "files_uploaded_since_last_heartbeat": 2,
  "errors_since_last_heartbeat": 0,
  "uptime_seconds": 3600
}
```

**Manual mode payload:**

```json
{
  "timestamp": "2026-03-26T20:15:00Z",
  "status": "watching",
  "instrument_id": "mass-spec-instrument",
  "watch_directory": "/data/mass-spec",
  "upload_mode": "manual",
  "runs_reported_since_last_heartbeat": 1,
  "runs_uploaded_since_last_heartbeat": 0,
  "files_uploaded_since_last_heartbeat": 0,
  "errors_since_last_heartbeat": 0,
  "uptime_seconds": 3600
}
```

If the API is unreachable, the watcher logs a warning and retries on the next interval. Heartbeat failures do not stop file monitoring or uploads.

## Failure Handling Summary

| Operation | API unreachable behavior |
|---|---|
| `init` | **Fail.** Registration is a prerequisite. |
| `config edit` / `config open` | **Warn.** Local write succeeds. Config synced on next `watch` startup. |
| `watch` startup (checksum sync) | **Warn.** Proceed with watching. |
| `watch` heartbeat | **Warn.** Retry on next interval. |
| `watch` event reporting | **Warn.** Discard the event. Events are best-effort. |

## Event Reporting

In addition to heartbeats (summary counters), the watcher reports significant events to the Data Hub API for centralized visibility. Events are the curated highlights; the local log file (`~/.data-hub/watcher.log`) remains the full-fidelity record.

Events are sent via `POST /watchers/{watcher_id}/events` as they occur. To avoid blocking the main loop, events are queued in memory and flushed asynchronously (batched with the next heartbeat or in a background thread). If the API is unreachable, events are discarded — they are best-effort and must never block file monitoring or uploads.

**Event types:**

| Event type | When emitted | Details payload |
|---|---|---|
| `watcher_started` | `watch` command starts successfully | `{ upload_mode, watch_directory }` |
| `watcher_stopped` | Clean shutdown (SIGINT/SIGTERM or service stop) | `{ uptime_seconds, reason }` (`reason`: `signal` or `service`) |
| `file_uploaded` | File successfully uploaded to S3 | `{ filename, s3_key, run_id, size_bytes, duration_ms }` |
| `upload_failed` | File upload failed after all retries | `{ filename, error, attempts }` |
| `run_reported` | Instrument run reported to API (manual mode) | `{ run_id, file_count }` |
| `run_uploaded` | All files for a run uploaded to S3 (manual mode) | `{ run_id, file_count, total_bytes }` |
| `config_synced` | Config pushed to API | `{ trigger }` (`trigger`: `init`, `edit`, `open`, or `startup`) |
| `error` | Unexpected errors not covered by other event types | `{ error, context }` |

**Payload schema:**

```json
{
  "events": [
    {
      "event_type": "file_uploaded",
      "timestamp": "2026-03-26T20:15:30Z",
      "message": "Uploaded 2026-03-26_experiment.xls to S3",
      "details": {
        "filename": "2026-03-26_experiment.xls",
        "s3_key": "spectramax-id3-plate-reader/2026-03-26_experiment/2026-03-26_experiment.xls",
        "size_bytes": 45056,
        "duration_ms": 1200
      }
    }
  ]
}
```

Events are sent in batches (one or more events per request) to reduce HTTP overhead.

## Dependencies

| Dependency | Purpose | Status |
|---|---|---|
| `requests` | HTTP client for Data Hub API | Via `data-hub-shared` |

## Acceptance Criteria

1. `data-hub-watcher watch` sends heartbeats at the configured interval and tolerates API downtime.
2. `data-hub-watcher watch` compares the local config checksum against the API on startup and pushes if they differ.
3. The watcher reports significant events (uploads, errors, state changes) to `POST /watchers/{watcher_id}/events`. Event reporting failures do not block file monitoring or uploads.
