# API: Instrument Runs

Prerequisite reading: [ARCHITECTURE.md](../ARCHITECTURE.md), [DATABASE_SCHEMA.md](../DATABASE_SCHEMA.md) (`instrument_runs`, `instrument_run_metadata`, `files`, `reported_files`, `run_report_data` tables), [AUTHENTICATION.md](./AUTHENTICATION.md).

Instrument run endpoints are nested under `/api/v1/instruments/:instrumentId/runs`. The `:instrumentId` and `:runId` parameters are the natural keys (e.g., `spectramax-id3-plate-reader` and `2026-03-26_experiment`), not database UUIDs. The database still uses a `uuid` surrogate PK internally — see [DATABASE_SCHEMA.md](../DATABASE_SCHEMA.md).

A cross-instrument list endpoint (`GET /api/v1/instrument-runs`) is also provided for the dashboard.

## `POST /api/v1/instruments/:instrumentId/runs`

Creates or updates an instrument run record. Idempotent on `(instrument_id, run_id)` — if the run already exists, it is updated rather than duplicated. This handles the case where the Lambda is re-invoked for the same run (e.g., via GitHub Actions), or the watcher re-reports a run after restart.

The `:instrumentId` path parameter must reference an existing instrument. Returns `404` if not found.

This endpoint serves two callers with different payloads:

**1. Lambda function (auto-mode runs) — full payload with files and report data:**

```json
{
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

**2. Watcher (auto and manual mode) — lightweight payload with detected files:**

```json
{
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
  "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "instrument_id": "mass-spec-instrument",
  "run_id": "20260325",
  "status": "reported"
}
```

**Behavior:**
- Validates that `:instrumentId` matches an existing instrument. The `instrument_id` stored in the database row comes from the URL path parameter.
- Upserts the `instrument_runs` row (sets `source` and `watcher_id` for watcher-reported runs).
- For Lambda-created runs: upserts `instrument_run_metadata`, inserts `files` rows (skip duplicates by `s3_key`), replaces `run_report_data` rows.
- For watcher-reported runs: upserts `reported_files` rows from the `detected_files` array (skip duplicates by `relative_path`). No `files`, `metadata`, or `report_data` processing at this stage.

## `GET /api/v1/instruments/:instrumentId/runs`

Lists instrument runs for a specific instrument with filtering and pagination. Used by the instrument detail page.

**Query parameters:**

| Parameter | Type | Description |
|---|---|---|
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
      "id": "a8e3c2f1-7b4d-4e6a-9f1c-2d3b4a5e6f78",
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

By default, soft-deleted runs (`deleted_at IS NOT NULL`) are excluded. Pass `include_deleted=true` to include them (used by the "Deleted Runs" UI view).

## `GET /api/v1/instrument-runs`

Cross-instrument list of runs with filtering and pagination. Used by the web UI dashboard to show recent activity across all instruments.

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

**Response:** Same shape as `GET /api/v1/instruments/:instrumentId/runs`.

## `GET /api/v1/instruments/:instrumentId/runs/:runId`

Returns the full detail for an instrument run, including all files, metadata, and report data.

**Response:**

```json
{
  "id": "a8e3c2f1-7b4d-4e6a-9f1c-2d3b4a5e6f78",
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
  "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
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

## `POST /api/v1/instruments/:instrumentId/runs/:runId/request-upload`

Queues a reported run for upload. Called by the web UI when a user selects a run to upload.

**Validation:**
- The run must exist and have `status = 'reported'`. Returns `409 Conflict` if the run is in any other status.

**Request body:** None required.

**Response:** `200 OK`

```json
{
  "instrument_id": "mass-spec-instrument",
  "run_id": "20260325",
  "status": "queued_for_upload"
}
```

**Side effects:**
- Sets `instrument_runs.status` to `queued_for_upload`.
- Sets `instrument_runs.updated_at` to now.

## `POST /api/v1/instrument-runs/batch-request-upload`

Queues multiple reported runs for upload in a single request. Called by the web UI for bulk upload actions. This endpoint is not nested under a single instrument because the batch may span multiple instruments.

**Request body:**

```json
{
  "runs": [
    { "instrument_id": "mass-spec-instrument", "run_id": "20260325" },
    { "instrument_id": "mass-spec-instrument", "run_id": "20260326" }
  ]
}
```

**Validation:**
- All referenced runs must exist and have `status = 'reported'`. Runs in other statuses are skipped with a warning in the response.

**Response:** `200 OK`

```json
{
  "queued": [
    { "instrument_id": "mass-spec-instrument", "run_id": "20260325" },
    { "instrument_id": "mass-spec-instrument", "run_id": "20260326" }
  ],
  "skipped": []
}
```

## `GET /api/v1/watchers/:watcher_id/upload-queue`

Documented in [WATCHERS.md](./WATCHERS.md#get-apiv1watcherswatcher_idupload-queue). Lives under the `/api/v1/watchers/` path namespace and should be implemented alongside the other watcher routes.

## `PATCH /api/v1/instruments/:instrumentId/runs/:runId`

Updates a run's status and optionally adds file records or updates reported files. Used by the watcher to report upload progress/completion, update detected files for a reported run, and by the Lambda to update processing status.

**Request body — upload completion (watcher):**

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

**Request body — updating detected files for a reported run (watcher):**

When new files arrive for an already-reported run, the watcher sends the updated file list. The API upserts `reported_files` rows (skip duplicates by `relative_path`).

```json
{
  "detected_files": [
    {
      "relative_path": "20260325_data_file_1.csv",
      "filename": "20260325_data_file_1.csv",
      "size_bytes": 1048576
    },
    {
      "relative_path": "20260325_data_file_3.csv",
      "filename": "20260325_data_file_3.csv",
      "size_bytes": 512000
    }
  ]
}
```

**Validation:**
- Status transitions must follow the lifecycle. Valid paths: `reported` → `queued_for_upload` → `uploading` → `uploaded` → `processing` → `completed`/`failed` (manual mode), or `reported` → `uploading` → `uploaded` → `processing` → `completed`/`failed` (auto mode). Invalid transitions return `409 Conflict`.
- Soft-deleted runs (`deleted_at` set) cannot be updated — returns `409 Conflict`. Use `DELETE /api/v1/instruments/:instrumentId/runs/:runId` to soft-delete.
- `detected_files` can only be sent for runs with `status = 'reported'`. Returns `409 Conflict` if the run has already been queued or uploaded.

**Response:** `200 OK` with the updated run object.

## `DELETE /api/v1/instruments/:instrumentId/runs/:runId`

Soft-deletes an instrument run by setting `deleted_at`. Removes all associated files from S3.

**Validation:**
- The run must exist and not already be soft-deleted (`deleted_at` must be `NULL`). Returns `404` if not found, `409` if already deleted.
- Runs in `uploading` status cannot be deleted (the upload must complete or be cancelled first). Returns `409 Conflict`.

**Request body:** None required.

**Response:** `200 OK`

```json
{
  "instrument_id": "mass-spec-instrument",
  "run_id": "20260325",
  "deleted_at": "2026-03-27T10:00:00Z",
  "files_deleted": 2
}
```

**Side effects:**
1. Sets `instrument_runs.deleted_at` to now. The `status` column is left unchanged so the run's last workflow state is preserved for audit purposes.
2. Deletes all S3 objects referenced in the `files` table for this run (both raw and processed buckets).
3. Does **not** delete database rows for `files`, `reported_files`, `instrument_run_metadata`, or `run_report_data` — these are retained for audit purposes and potential future restore functionality.

## Endpoints — Files

### `GET /api/v1/files/:id/download`

Redirects to a pre-signed S3 URL for the file. Allows the web UI to link directly to file downloads without exposing S3 URLs in the page HTML.

**Response:** `302 Redirect` with `Location` header set to the pre-signed URL.

## Endpoints — Analysis (future)

These endpoints replace the Notion webhook → Lambda function URL path for follow-on analyses (e.g., Michaelis-Menten kinetics on SpectraMax iD3 runs).

### `POST /api/v1/instruments/:instrumentId/runs/:runId/analyses`

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

### `GET /api/v1/instruments/:instrumentId/runs/:runId/analyses`

Returns analysis results for the run, including status and output data.

## Error Responses

All error responses follow a consistent shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "run_id is required",
    "details": {}
  }
}
```

Standard HTTP status codes: `400` for validation errors, `401` for missing/invalid auth, `404` for not found, `409` for conflicts (e.g., invalid status transition), `500` for internal errors.

## Acceptance Criteria

1. `POST /api/v1/instruments/:instrumentId/runs` creates an instrument run with metadata, files, and report data. Calling it twice with the same `instrument_id` and `run_id` updates the existing record rather than creating a duplicate.
2. `GET /api/v1/instruments/:instrumentId/runs` returns paginated results with filtering by status and search.
3. `GET /api/v1/instrument-runs` returns paginated results across all instruments with filtering by instrument, status, and search.
4. `GET /api/v1/instruments/:instrumentId/runs/:runId` returns the full run detail including pre-signed download URLs for all files.
5. Pre-signed S3 URLs work for downloading raw and processed files from the web UI.
6. `POST /api/v1/instruments/:instrumentId/runs` accepts watcher-reported runs with `status: reported` and `detected_files`, creating `instrument_runs` and `reported_files` rows.
7. `POST /api/v1/instruments/:instrumentId/runs/:runId/request-upload` transitions a `reported` run to `queued_for_upload`. Returns `409` for runs in other statuses.
8. `POST /api/v1/instrument-runs/batch-request-upload` queues multiple reported runs (identified by `instrument_id` + `run_id` pairs) and reports which were queued vs. skipped.
9. `GET /api/v1/watchers/:watcher_id/upload-queue` returns runs with `status = 'queued_for_upload'` for the watcher's instrument, including their `reported_files`.
10. `PATCH /api/v1/instruments/:instrumentId/runs/:runId` correctly enforces status transition rules and accepts file records on upload completion.
11. `DELETE /api/v1/instruments/:instrumentId/runs/:runId` soft-deletes the run (sets `deleted_at`) and deletes all associated S3 objects. The `status` column is preserved. Returns `409` for runs in `uploading` status or already-deleted runs.
12. `GET /api/v1/instruments/:instrumentId/runs` and `GET /api/v1/instrument-runs` exclude soft-deleted runs by default; include them when `include_deleted=true` is passed.
