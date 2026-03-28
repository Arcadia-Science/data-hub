# API: Instruments

Prerequisite reading: [ARCHITECTURE.md](../ARCHITECTURE.md), [DATABASE_SCHEMA.md](../DATABASE_SCHEMA.md) (`instruments` table), [AUTHENTICATION.md](./AUTHENTICATION.md).

## `GET /api/instruments`

Returns all registered instruments.

**Response:**

```json
[
  {
    "id": "spectramax-id3-plate-reader",
    "display_name": "SpectraMax iD3 Plate Reader",
    "status": "active",
    "file_patterns": ["*.xls"],
    "s3_trigger_suffix": ".xls"
  }
]
```

## `GET /api/instruments/:instrumentId`

Returns the detail for a single instrument, including summary counts. Used by the instrument detail page header.

**Response:**

```json
{
  "id": "spectramax-id3-plate-reader",
  "display_name": "SpectraMax iD3 Plate Reader",
  "status": "active",
  "file_patterns": ["*.xls"],
  "s3_trigger_suffix": ".xls",
  "run_count": 142,
  "watcher_count": 1,
  "created_at": "2026-01-15T10:00:00Z",
  "updated_at": "2026-03-26T20:15:00Z"
}
```

Returns `404` if the instrument does not exist.

Instrument runs are nested under this resource — see [INSTRUMENT_RUNS.md](./INSTRUMENT_RUNS.md) for `GET /api/instruments/:instrumentId/runs` and related endpoints.

## `POST /api/instruments`

Registers a new instrument in `pending` status. Called by the watcher CLI when a user enters an instrument ID not in the list.

**Request body:**

```json
{
  "id": "new-instrument-id",
  "display_name": "New Instrument Name"
}
```

**Response:** `201 Created` with the created instrument object.

**Validation:**
- `id` must be valid kebab-case and not already exist.
- `display_name` is optional; defaults to a title-cased version of the ID.

## `PATCH /api/instruments/:instrumentId`

Updates an instrument's status or metadata. Used by admins via the web UI to confirm pending instruments or update file patterns.

**Request body (partial):**

```json
{
  "status": "active",
  "file_patterns": ["*.xls"],
  "display_name": "Updated Name"
}
```

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

Standard HTTP status codes: `400` for validation errors, `401` for missing/invalid auth, `404` for not found, `409` for conflicts (e.g., duplicate instrument ID), `500` for internal errors.

## Acceptance Criteria

1. `POST /api/instruments` creates a new instrument in `pending` status; `PATCH /api/instruments/:instrumentId` can set it to `active`.
2. `GET /api/instruments` returns all instruments with their metadata, matching the response shape expected by the file upload service.
3. `GET /api/instruments/:instrumentId` returns the instrument detail with summary counts (run count, watcher count).
