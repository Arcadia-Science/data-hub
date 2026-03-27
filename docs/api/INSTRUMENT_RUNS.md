# API: Instrument Runs

Prerequisite reading: [ARCHITECTURE.md](../ARCHITECTURE.md), [DATABASE_SCHEMA.md](../DATABASE_SCHEMA.md) (`instrument_runs`, `instrument_run_metadata`, `files`, `reported_files`, `run_report_data` tables), [AUTHENTICATION.md](./AUTHENTICATION.md).

These endpoints are called by the Lambda function after processing an S3 event, and by the watcher in manual mode to report and upload instrument runs.

## `POST /api/instrument-runs`

Creates or updates an instrument run record. Idempotent on `(instrument_id, run_id)` — if the run already exists, it is updated rather than duplicated. This handles the case where the Lambda is re-invoked for the same run (e.g., via GitHub Actions), or the watcher re-reports a run after restart.

This endpoint serves two callers with different payloads:

**1. Lambda function (auto-mode runs) — full payload with files and report data:**

```json
{
  "instrument_id": "spectramax-id3-plate-reader",
  "run_id": "2026-03-26_experiment",
  "status": "completed",
  "source": "lambda",
  "report_version": "0.1.7",
  "metadata": {
    "measurement_mode": "Fluorescence",
    "measurement_type": "Endpoint",
    "wavelength": "450"
  },
  "files": [
    {
      "s3_bucket": "arcadia-raw-data-hub-production",
      "s3_key": "spectramax-id3-plate-reader/2026-03-26_experiment.xls",
      "filename": "2026-03-26_experiment.xls",
      "content_type": "application/vnd.ms-excel",
      "size_bytes": 45056,
      "category": "raw"
    }
  ],
  "report_data": [
    {
      "data_type": "raw_well_data",
      "data": [
        {"well": "A1", "value": 0.123, "time": 0},
        {"well": "A2", "value": 0.456, "time": 0}
      ]
    },
    {
      "data_type": "plate_map",
      "data": [
        {"row": "A", "1": 0.123, "2": 0.456}
      ]
    }
  ]
}
```

**2. Watcher (manual-mode runs) — lightweight payload with detected files:**

```json
{
  "instrument_id": "mass-spec-instrument",
  "run_id": "20260325",
  "status": "reported",
  "source": "watcher",
  "watcher_id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
  "detected_files": [
    {
      "relative_path": "20260325_data_file_1.csv",
      "filename": "20260325_data_file_1.csv",
      "size_bytes": 1048576
    },
    {
      "relative_path": "20260325_data_file_2.csv",
      "filename": "20260325_data_file_2.csv",
      "size_bytes": 2097152
    }
  ]
}
```

**Response:** `201 Created` (or `200 OK` if updated)

```json
{
  "id": "mass-spec-instrument/20260325",
  "instrument_id": "mass-spec-instrument",
  "run_id": "20260325",
  "status": "reported"
}
```

**Behavior:**
- Upserts the `instrument_runs` row (sets `source` and `watcher_id` for watcher-reported runs).
- For Lambda-created runs: upserts `instrument_run_metadata`, inserts `files` rows (skip duplicates by `s3_key`), replaces `run_report_data` rows.
- For watcher-reported runs: upserts `reported_files` rows from the `detected_files` array (skip duplicates by `relative_path`). No `files`, `metadata`, or `report_data` processing at this stage.

## `GET /api/instrument-runs`

Lists instrument runs with filtering and pagination. Used by the web UI dashboard.

**Query parameters:**

| Parameter | Type | Description |
|---|---|---|
| `instrument_id` | `string` | Filter by instrument. |
| `status` | `string` | Filter by status. Accepts comma-separated values (e.g., `reported,queued_for_upload`). |
| `source` | `string` | Filter by source: `lambda` or `watcher`. |
| `search` | `string` | Search by run ID (partial match). |
| `sort` | `string` | Sort field. Default: `created_at`. |
| `order` | `asc` \| `desc` | Sort direction. Default: `desc`. |
| `page` | `int` | Page number (1-indexed). Default: `1`. |
| `per_page` | `int` | Results per page. Default: `25`. Max: `100`. |
| `include_deleted` | `bool` | If `true`, include soft-deleted runs. Default: `false`. |

**Response:**

```json
{
  "data": [
    {
      "id": "spectramax-id3-plate-reader/2026-03-26_experiment",
      "instrument_id": "spectramax-id3-plate-reader",
      "instrument_display_name": "SpectraMax iD3 Plate Reader",
      "run_id": "2026-03-26_experiment",
      "status": "completed",
      "source": "lambda",
      "report_version": "0.1.7",
      "metadata": {
        "measurement_mode": "Fluorescence",
        "measurement_type": "Endpoint",
        "wavelength": "450"
      },
      "file_count": 3,
      "created_at": "2026-03-26T20:15:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "per_page": 25,
    "total": 142,
    "total_pages": 6
  }
}
```

By default, runs with `status = 'deleted'` are excluded. Pass `include_deleted=true` to include them (used by the "Deleted Runs" UI view).

## `GET /api/instrument-runs/:id`

Returns the full detail for an instrument run, including all files, metadata, and report data.

**Response:**

```json
{
  "id": "spectramax-id3-plate-reader/2026-03-26_experiment",
  "instrument_id": "spectramax-id3-plate-reader",
  "instrument_display_name": "SpectraMax iD3 Plate Reader",
  "run_id": "2026-03-26_experiment",
  "status": "completed",
  "source": "lambda",
  "watcher_id": null,
  "report_version": "0.1.7",
  "created_at": "2026-03-26T20:15:00Z",
  "updated_at": "2026-03-26T20:16:30Z",
  "deleted_at": null,
  "metadata": {
    "measurement_mode": "Fluorescence",
    "measurement_type": "Endpoint",
    "wavelength": "450"
  },
  "files": [
    {
      "id": 1,
      "filename": "2026-03-26_experiment.xls",
      "s3_key": "spectramax-id3-plate-reader/2026-03-26_experiment.xls",
      "content_type": "application/vnd.ms-excel",
      "size_bytes": 45056,
      "category": "raw",
      "download_url": "https://...",
      "created_at": "2026-03-26T20:15:00Z"
    }
  ],
  "reported_files": [],
  "report_data": [
    {
      "data_type": "raw_well_data",
      "data": [...]
    },
    {
      "data_type": "plate_map",
      "data": [...]
    }
  ]
}
```

The `download_url` for each file is a pre-signed S3 URL generated at response time (short-lived, e.g., 15-minute expiry).

For runs with `status = 'reported'`, the `files` array is empty and `reported_files` contains the detected file list:

```json
{
  "id": "mass-spec-instrument/20260325",
  "instrument_id": "mass-spec-instrument",
  "instrument_display_name": "Mass Spectrometer",
  "run_id": "20260325",
  "status": "reported",
  "source": "watcher",
  "watcher_id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
  "report_version": null,
  "created_at": "2026-03-25T14:30:00Z",
  "updated_at": "2026-03-25T14:30:00Z",
  "deleted_at": null,
  "metadata": {},
  "files": [],
  "reported_files": [
    {
      "relative_path": "20260325_data_file_1.csv",
      "filename": "20260325_data_file_1.csv",
      "size_bytes": 1048576,
      "detected_at": "2026-03-25T14:25:00Z"
    },
    {
      "relative_path": "20260325_data_file_2.csv",
      "filename": "20260325_data_file_2.csv",
      "size_bytes": 2097152,
      "detected_at": "2026-03-25T14:28:00Z"
    }
  ],
  "report_data": []
}
```

## `POST /api/instrument-runs/:id/request-upload`

Queues a reported run for upload. Called by the web UI when a user selects a run to upload.

**Validation:**
- The run must exist and have `status = 'reported'`. Returns `409 Conflict` if the run is in any other status.

**Request body:** None required.

**Response:** `200 OK`

```json
{
  "id": "mass-spec-instrument/20260325",
  "status": "queued_for_upload"
}
```

**Side effects:**
- Sets `instrument_runs.status` to `queued_for_upload`.
- Sets `instrument_runs.updated_at` to now.

## `POST /api/instrument-runs/batch-request-upload`

Queues multiple reported runs for upload in a single request. Called by the web UI for bulk upload actions.

**Request body:**

```json
{
  "run_ids": [
    "mass-spec-instrument/20260325",
    "mass-spec-instrument/20260326"
  ]
}
```

**Validation:**
- All referenced runs must exist and have `status = 'reported'`. Runs in other statuses are skipped with a warning in the response.

**Response:** `200 OK`

```json
{
  "queued": ["mass-spec-instrument/20260325", "mass-spec-instrument/20260326"],
  "skipped": []
}
```

## `GET /api/watchers/:watcher_id/upload-queue`

Returns runs that have been queued for upload and belong to this watcher's instrument. Polled by the watcher on each heartbeat interval.

**Response:**

```json
{
  "runs": [
    {
      "id": "mass-spec-instrument/20260325",
      "run_id": "20260325",
      "instrument_id": "mass-spec-instrument",
      "reported_files": [
        {
          "relative_path": "20260325_data_file_1.csv",
          "filename": "20260325_data_file_1.csv",
          "size_bytes": 1048576
        },
        {
          "relative_path": "20260325_data_file_2.csv",
          "filename": "20260325_data_file_2.csv",
          "size_bytes": 2097152
        }
      ]
    }
  ]
}
```

**Behavior:**
- Filters `instrument_runs` where `status = 'queued_for_upload'` and `instrument_id` matches the watcher's registered instrument.
- Includes the `reported_files` for each run so the watcher knows which files to upload.

## `PATCH /api/instrument-runs/:id`

Updates a run's status and optionally adds file records. Used by the watcher to report upload progress/completion, and by the Lambda to update processing status.

**Request body (partial):**

```json
{
  "status": "uploaded",
  "files": [
    {
      "s3_bucket": "arcadia-raw-data-hub-staging",
      "s3_key": "mass-spec-instrument/20260325_data_file_1.csv",
      "filename": "20260325_data_file_1.csv",
      "content_type": "text/csv",
      "size_bytes": 1048576,
      "category": "raw"
    }
  ]
}
```

**Validation:**
- Status transitions must follow the lifecycle: `reported` → `queued_for_upload` → `uploading` → `uploaded` → `processing` → `completed`/`failed`. Invalid transitions return `409 Conflict`.
- The `deleted` status cannot be set via this endpoint — use `DELETE /api/instrument-runs/:id` instead.

**Response:** `200 OK` with the updated run object.

## `DELETE /api/instrument-runs/:id`

Soft-deletes an instrument run. Removes all associated files from S3 and marks the run as deleted.

**Validation:**
- The run must exist and not already be deleted. Returns `404` if not found, `409` if already deleted.
- Runs in `uploading` status cannot be deleted (the upload must complete or be cancelled first). Returns `409 Conflict`.

**Request body:** None required.

**Response:** `200 OK`

```json
{
  "id": "mass-spec-instrument/20260325",
  "status": "deleted",
  "deleted_at": "2026-03-27T10:00:00Z",
  "files_deleted": 2
}
```

**Side effects:**
1. Sets `instrument_runs.status` to `deleted` and `instrument_runs.deleted_at` to now.
2. Deletes all S3 objects referenced in the `files` table for this run (both raw and processed buckets).
3. Does **not** delete database rows for `files`, `reported_files`, `instrument_run_metadata`, or `run_report_data` — these are retained for audit purposes and potential future restore functionality.

## Endpoints — Files

### `GET /api/files/:id/download`

Redirects to a pre-signed S3 URL for the file. Allows the web UI to link directly to file downloads without exposing S3 URLs in the page HTML.

**Response:** `302 Redirect` with `Location` header set to the pre-signed URL.

## Endpoints — Analysis (future)

These endpoints replace the Notion webhook → Lambda function URL path for follow-on analyses (e.g., Michaelis-Menten kinetics on SpectraMax iD3 runs).

### `POST /api/instrument-runs/:id/analyses`

Triggers a follow-on analysis for a completed instrument run. The API either invokes the Lambda function directly or enqueues the job.

**Request body:**

```json
{
  "analysis_type": "michaelis-menten-kinetics",
  "parameters": {
    "metadata_file_id": 42
  }
}
```

**Response:** `202 Accepted`

```json
{
  "analysis_id": "...",
  "status": "queued"
}
```

### `GET /api/instrument-runs/:id/analyses`

Returns analysis results for the run, including status and output data.

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

Standard HTTP status codes: `400` for validation errors, `401` for missing/invalid auth, `404` for not found, `409` for conflicts (e.g., duplicate instrument ID, invalid status transition), `500` for internal errors.

## Acceptance Criteria

1. `POST /api/instrument-runs` creates an instrument run with metadata, files, and report data. Calling it twice with the same `instrument_id` and `run_id` updates the existing record rather than creating a duplicate.
2. `GET /api/instrument-runs` returns paginated results with filtering by instrument, status, and search.
3. `GET /api/instrument-runs/:id` returns the full run detail including pre-signed download URLs for all files.
4. Pre-signed S3 URLs work for downloading raw and processed files from the web UI.
5. `POST /api/instrument-runs` accepts watcher-reported runs with `status: reported` and `detected_files`, creating `instrument_runs` and `reported_files` rows.
6. `POST /api/instrument-runs/:id/request-upload` transitions a `reported` run to `queued_for_upload`. Returns `409` for runs in other statuses.
7. `POST /api/instrument-runs/batch-request-upload` queues multiple reported runs and reports which were queued vs. skipped.
8. `GET /api/watchers/:watcher_id/upload-queue` returns runs with `status = 'queued_for_upload'` for the watcher's instrument, including their `reported_files`.
9. `PATCH /api/instrument-runs/:id` correctly enforces status transition rules and accepts file records on upload completion.
10. `DELETE /api/instrument-runs/:id` soft-deletes the run (sets `deleted_at`, status to `deleted`) and deletes all associated S3 objects. Returns `409` for runs in `uploading` status.
11. `GET /api/instrument-runs` excludes deleted runs by default; includes them when `include_deleted=true` is passed.
