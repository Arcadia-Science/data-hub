# API: Watchers

Prerequisite reading: [ARCHITECTURE.md](../ARCHITECTURE.md), [DATABASE_SCHEMA.md](../DATABASE_SCHEMA.md) (`watchers`, `watcher_heartbeats`, `watcher_events` tables), [AUTHENTICATION.md](./AUTHENTICATION.md).

These endpoints fulfill the contract defined in [watcher/API_CLIENT.md](../watcher/API_CLIENT.md).

## `POST /api/watchers/register`

Registers a new watcher instance.

**Request body:**

```json
{
  "instrument_id": "spectramax-id3-plate-reader",
  "hostname": "LAB-PC-01",
  "os_info": "Windows 11 23H2",
  "config": {
    "environment": "staging",
    "instrument_id": "spectramax-id3-plate-reader",
    "watch_directory": "/data/spectramax-id3",
    "file_patterns": ["*.xls"],
    "enabled": true,
    "upload_mode": "auto",
    "stability_period_seconds": 5,
    "run_detection": {
      "method": "prefix",
      "prefix_pattern": "^([^_]+)"
    }
  }
}
```

**Response:** `201 Created`

```json
{
  "watcher_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

**Validation:**
- `instrument_id` must reference an existing instrument that is `active` or `pending`.

## `PUT /api/watchers/:watcher_id/config`

Pushes the watcher's config and its checksum. See [watcher/API_CLIENT.md](../watcher/API_CLIENT.md) for the full payload schema including `upload_mode` and `run_detection` fields.

**Request body:**

```json
{
  "config_checksum": "sha256:abc123...",
  "environment": "staging",
  "instrument_id": "spectramax-id3-plate-reader",
  "watch_directory": "/data/spectramax-id3",
  "file_patterns": ["*.xls"],
  "enabled": true,
  "upload_mode": "auto",
  "stability_period_seconds": 5,
  "run_detection": {
    "method": "prefix",
    "prefix_pattern": "^([^_]+)"
  }
}
```

**Response:** `200 OK`

## `GET /api/watchers/:watcher_id/config-checksum`

Returns the SHA-256 checksum of the last-pushed config.

**Response:**

```json
{
  "config_checksum": "sha256:abc123..."
}
```

Returns `404` if the watcher has never pushed a config.

## `POST /api/watchers/:watcher_id/heartbeat`

Records a heartbeat from the watcher.

**Request body:**

```json
{
  "timestamp": "2026-03-26T20:15:00Z",
  "status": "watching",
  "instrument_id": "spectramax-id3-plate-reader",
  "watch_directory": "/data/spectramax-id3",
  "files_uploaded_since_last_heartbeat": 2,
  "errors_since_last_heartbeat": 0,
  "uptime_seconds": 3600
}
```

**Response:** `200 OK`

**Side effects:**
- Inserts a row into `watcher_heartbeats`.
- Updates `watchers.last_heartbeat_at` and `watchers.status`.

## `GET /api/watchers/:watcher_id/heartbeats`

Returns recent heartbeat history for a watcher. Used by the watcher detail page.

**Query parameters:**

| Parameter | Type | Description |
|---|---|---|
| `limit` | `int` | Number of heartbeats to return. Default: `100`. Max: `1000`. |
| `since` | `timestamptz` | Only return heartbeats after this timestamp. |

**Response:**

```json
{
  "data": [
    {
      "id": 42,
      "timestamp": "2026-03-26T20:15:00Z",
      "status": "watching",
      "upload_mode": "auto",
      "files_uploaded_since_last": 2,
      "runs_reported_since_last": 0,
      "runs_uploaded_since_last": 0,
      "errors_since_last": 0,
      "uptime_seconds": 3600,
      "created_at": "2026-03-26T20:15:01Z"
    }
  ]
}
```

Results are ordered by `timestamp DESC`.

## `POST /api/watchers/:watcher_id/events`

Records significant watcher events. Called by the watcher to report state changes, uploads, and errors. Events are accepted in batches.

**Request body:**

```json
{
  "events": [
    {
      "event_type": "file_uploaded",
      "timestamp": "2026-03-26T20:15:30Z",
      "message": "Uploaded 2026-03-26_experiment.xls to S3",
      "details": {
        "filename": "2026-03-26_experiment.xls",
        "s3_key": "spectramax-id3-plate-reader/2026-03-26_experiment.xls",
        "size_bytes": 45056,
        "duration_ms": 1200
      }
    }
  ]
}
```

**Response:** `201 Created`

```json
{
  "received": 1
}
```

**Validation:**
- `event_type` must be one of the recognized types (see [watcher/API_CLIENT.md](../watcher/API_CLIENT.md), event reporting section).
- `timestamp` and `message` are required for each event.
- Maximum 100 events per request.

## `GET /api/watchers/:watcher_id/events`

Returns recent events for a watcher. Used by the watcher detail page.

**Query parameters:**

| Parameter | Type | Description |
|---|---|---|
| `limit` | `int` | Number of events to return. Default: `50`. Max: `500`. |
| `since` | `timestamptz` | Only return events after this timestamp. |
| `event_type` | `string` | Filter by event type. Accepts comma-separated values (e.g., `file_uploaded,upload_failed`). |

**Response:**

```json
{
  "data": [
    {
      "id": 1,
      "event_type": "file_uploaded",
      "message": "Uploaded 2026-03-26_experiment.xls to S3",
      "details": {
        "filename": "2026-03-26_experiment.xls",
        "s3_key": "spectramax-id3-plate-reader/2026-03-26_experiment.xls",
        "size_bytes": 45056,
        "duration_ms": 1200
      },
      "timestamp": "2026-03-26T20:15:30Z",
      "created_at": "2026-03-26T20:15:31Z"
    }
  ]
}
```

Results are ordered by `timestamp DESC`.

## Error Responses

All error responses follow a consistent shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "instrument_id is required",
    "details": {}
  }
}
```

Standard HTTP status codes: `400` for validation errors, `401` for missing/invalid auth, `404` for not found, `409` for conflicts, `500` for internal errors.

## Acceptance Criteria

1. `POST /api/watchers/register` returns a `watcher_id` and creates a watcher record linked to the instrument.
2. `PUT /api/watchers/:watcher_id/config` stores the config payload and checksum; `GET /api/watchers/:watcher_id/config-checksum` returns it.
3. `POST /api/watchers/:watcher_id/heartbeat` inserts a `watcher_heartbeats` row and updates `watchers.last_heartbeat_at`.
4. `POST /api/watchers/:watcher_id/events` accepts batches of watcher events and inserts them into `watcher_events`.
5. `GET /api/watchers/:watcher_id/events` returns events filtered by type and date range, ordered by timestamp descending.
6. `GET /api/watchers/:watcher_id/heartbeats` returns heartbeat history filtered by date range.
7. `watcher_heartbeats` includes manual-mode counters (`runs_reported_since_last`, `runs_uploaded_since_last`) alongside the existing upload counters.
