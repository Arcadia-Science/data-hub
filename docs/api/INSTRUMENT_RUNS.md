# API: Instrument Runs

Prerequisite reading: [ARCHITECTURE.md](../ARCHITECTURE.md), [DATABASE_SCHEMA.md](../DATABASE_SCHEMA.md) (`instrument_runs`, `files`, `run_report_data` tables), [AUTHENTICATION.md](./AUTHENTICATION.md).

Instrument run endpoints are nested under `/api/v1/instruments/:instrumentId/runs`. The `:instrumentId` and `:runId` parameters are the natural keys (e.g., `spectramax-id3-plate-reader` and `2026-03-26_experiment`), not database UUIDs. The database still uses a `uuid` surrogate PK internally — see [DATABASE_SCHEMA.md](../DATABASE_SCHEMA.md).

A cross-instrument list endpoint (`GET /api/v1/instrument-runs`) is also provided for the dashboard.

Instrument runs have no status column. Processing status is tracked per file — see the `files` table in [DATABASE_SCHEMA.md](../DATABASE_SCHEMA.md) and the `PATCH /api/v1/files/:fileId` endpoint below.

## `POST /api/v1/instruments/:instrumentId/runs`

Creates or updates an instrument run record. Idempotent on `(instrument_id, run_id)` — if the run already exists, it is a no-op (returns the existing record). This handles the case where the Lambda auto-creates a run for a file that already belongs to a watcher-reported run, or when the watcher re-reports a run after restart.

The `:instrumentId` path parameter must reference an existing instrument. Returns `404` if not found.

This endpoint serves two callers with different payloads:

**1. Lambda function — ensure a run exists (auto-create if needed):**

```json
{
  "run_id": "2026-03-26_experiment",
  "source": "lambda"
}
```

The Lambda calls this before processing a file to ensure the parent run record exists. If the run was already created by a watcher, the existing record is returned unchanged. If not, a new run is created with `source: "lambda"`.

**2. Watcher (auto and manual mode) — report a run with detected files:**

```json
{
  "run_id": "20260325",
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

**Response:** `201 Created` (or `200 OK` if the run already exists)

```json
{
  "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "instrument_id": "mass-spec-instrument",
  "run_id": "20260325",
  "source": "watcher"
}
```

**Behavior:**
- Validates that `:instrumentId` matches an existing instrument. The `instrument_id` stored in the database row comes from the URL path parameter.
- Upserts the `instrument_runs` row (sets `source` and `watcher_id` for watcher-reported runs).
- For watcher-reported runs: upserts `files` rows from the `detected_files` array with `status: 'detected'`, `relative_path`, `filename`, `size_bytes`, and `detected_at` set to now. `s3_bucket` and `s3_key` are `NULL`. Duplicates are skipped by `(instrument_run_id, relative_path)`.
- For Lambda-created runs: creates the run record only. The Lambda then creates file records via `POST /api/v1/instruments/:instrumentId/runs/:runId/files` and writes metadata and report data via `PATCH /api/v1/files/:fileId`.

## `GET /api/v1/instruments/:instrumentId/runs`

Lists instrument runs for a specific instrument with filtering and pagination. Used by the instrument detail page.

**Query parameters:**

| Parameter | Type | Description |
|---|---|---|
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
      "source": "lambda",
      "metadata": {
        "measurement_mode": "Fluorescence",
        "measurement_type": "Endpoint",
        "wavelength": "450"
      },
      "file_count": 3,
      "files_completed": 3,
      "files_failed": 0,
      "files_pending_upload": 0,
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

The `files_completed` and `files_failed` counts are computed from the `files.status` column. `files_pending_upload` counts files with `status` of `detected` or `upload_requested` — i.e., files on the instrument PC not yet uploaded to S3. A non-zero `files_pending_upload` indicates the run has files that require manual upload action.

By default, soft-deleted runs (`deleted_at IS NOT NULL`) are excluded. Pass `include_deleted=true` to include them (used by the "Deleted Runs" UI view).

## `GET /api/v1/instrument-runs`

Cross-instrument list of runs with filtering and pagination. Used by the web UI dashboard to show recent activity across all instruments.

**Query parameters:**

| Parameter | Type | Description |
|---|---|---|
| `instrument_id` | `string` | Filter by instrument. |
| `source` | `string` | Filter by source: `lambda` or `watcher`. |
| `search` | `string` | Search by run ID (partial match). |
| `sort` | `string` | Sort field. Default: `created_at`. |
| `order` | `asc` \| `desc` | Sort direction. Default: `desc`. |
| `page` | `int` | Page number (1-indexed). Default: `1`. |
| `per_page` | `int` | Results per page. Default: `25`. Max: `100`. |
| `include_deleted` | `bool` | If `true`, include soft-deleted runs. Default: `false`. |

**Response:** Same shape as `GET /api/v1/instruments/:instrumentId/runs`.

## `GET /api/v1/instruments/:instrumentId/runs/:runId`

Returns the full detail for an instrument run, including all files (with per-file status and metadata), run-level metadata, and report data.

**Response:**

```json
{
  "id": "a8e3c2f1-7b4d-4e6a-9f1c-2d3b4a5e6f78",
  "instrument_id": "spectramax-id3-plate-reader",
  "instrument_display_name": "SpectraMax iD3 Plate Reader",
  "run_id": "2026-03-26_experiment",
  "source": "lambda",
  "watcher_id": null,
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
      "relative_path": null,
      "s3_key": "spectramax-id3-plate-reader/2026-03-26_experiment/2026-03-26_experiment.xls",
      "content_type": "application/vnd.ms-excel",
      "size_bytes": 45056,
      "category": "raw",
      "status": "completed",
      "metadata": {
        "measurement_mode": "Fluorescence",
        "measurement_type": "Endpoint",
        "wavelength": "450"
      },
      "error_message": null,
      "detected_at": null,
      "upload_requested_at": null,
      "uploaded_at": "2026-03-26T20:15:00Z",
      "processed_at": "2026-03-26T20:16:30Z",
      "download_url": "https://...",
      "created_at": "2026-03-26T20:15:00Z"
    }
  ],
  "report_data": [
    {
      "data_type": "raw_well_data",
      "file_id": 1,
      "data": [...]
    },
    {
      "data_type": "plate_map",
      "file_id": 1,
      "data": [...]
    }
  ]
}
```

The `download_url` for each file is a pre-signed S3 URL generated at response time (short-lived, e.g., 15-minute expiry). Only present when `s3_key` is non-`NULL` (i.e., the file has been uploaded to S3). For files in `detected` or `upload_requested` status, `download_url` is `NULL`.

For watcher-reported runs where files have not yet been uploaded, the `files` array contains the detected files with `status: 'detected'` and `NULL` S3 fields:

```json
{
  "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "instrument_id": "mass-spec-instrument",
  "instrument_display_name": "Mass Spectrometer",
  "run_id": "20260325",
  "source": "watcher",
  "watcher_id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
  "created_at": "2026-03-25T14:30:00Z",
  "updated_at": "2026-03-25T14:30:00Z",
  "deleted_at": null,
  "metadata": {},
  "files": [
    {
      "id": 1,
      "filename": "20260325_data_file_1.csv",
      "relative_path": "20260325_data_file_1.csv",
      "s3_key": null,
      "content_type": null,
      "size_bytes": 1048576,
      "category": "raw",
      "status": "detected",
      "metadata": {},
      "error_message": null,
      "detected_at": "2026-03-25T14:25:00Z",
      "upload_requested_at": null,
      "uploaded_at": null,
      "processed_at": null,
      "download_url": null,
      "created_at": "2026-03-25T14:30:00Z"
    },
    {
      "id": 2,
      "filename": "20260325_data_file_2.csv",
      "relative_path": "20260325_data_file_2.csv",
      "s3_key": null,
      "content_type": null,
      "size_bytes": 2097152,
      "category": "raw",
      "status": "detected",
      "metadata": {},
      "error_message": null,
      "detected_at": "2026-03-25T14:28:00Z",
      "upload_requested_at": null,
      "uploaded_at": null,
      "processed_at": null,
      "download_url": null,
      "created_at": "2026-03-25T14:30:00Z"
    }
  ],
  "report_data": []
}
```

## `POST /api/v1/instruments/:instrumentId/runs/:runId/request-upload`

Queues individual files within a run for upload. Called by the web UI when a user selects files (or an entire run) to upload. The request body contains the list of file IDs to queue.

**Request body:**

```json
{
  "file_ids": [1, 2, 3]
}
```

When the user selects an entire run for upload, the UI sends all file IDs for that run.

**Validation:**
- The run must exist. Returns `404` if the run is not found.
- All `file_ids` must belong to the specified run and have `status: 'detected'`. Returns `400` if any file ID is invalid, belongs to a different run, or is not in `detected` status.
- Files that are already in `upload_requested` status (or later) are skipped — this makes the endpoint safe to retry.
- Files with `deleted_at` set are rejected — returns `400`.
- The run must not be soft-deleted — returns `409 Conflict`.

**Response:** `200 OK`

```json
{
  "instrument_id": "mass-spec-instrument",
  "run_id": "20260325",
  "files_queued": 3,
  "files": [
    { "id": 1, "filename": "20260325_data_file_1.csv", "upload_requested_at": "2026-03-26T10:00:00Z" },
    { "id": 2, "filename": "20260325_data_file_2.csv", "upload_requested_at": "2026-03-26T10:00:00Z" },
    { "id": 3, "filename": "20260325_data_file_3.csv", "upload_requested_at": "2026-03-26T10:00:00Z" }
  ]
}
```

**Side effects:**
- Sets `files.upload_requested_at` to now and `files.status` to `upload_requested` for each specified file.
- Sets `instrument_runs.updated_at` to now.

## `GET /api/v1/watchers/:watcher_id/upload-queue`

Documented in [WATCHERS.md](./WATCHERS.md#get-apiv1watcherswatcher_idupload-queue). Lives under the `/api/v1/watchers/` path namespace and should be implemented alongside the other watcher routes. Returns a flat list of files where `upload_requested_at` is non-`NULL` and `uploaded_at` is `NULL` for the watcher's instrument.

## `PATCH /api/v1/instruments/:instrumentId/runs/:runId`

Updates a run record. Currently supports setting run-level metadata.

**Request body — setting run-level metadata (Lambda or analysis pipeline):**

After processing all files in a run, the Lambda function (or a run-level analysis) can write aggregated metadata to the run. The provided object **replaces** the existing metadata entirely (patch-by-key semantics would require the caller to read-then-merge, adding complexity for no clear benefit at current scale).

```json
{
  "metadata": {
    "measurement_mode": "Fluorescence",
    "measurement_type": "Endpoint",
    "wavelength": "450"
  }
}
```

**Request body — updating detected files for a reported run (watcher):**

When new files arrive for an already-reported run, the watcher sends the updated file list. The API upserts `files` rows with `status: 'detected'` (skip duplicates by `relative_path`).

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
- Soft-deleted runs (`deleted_at` set) cannot be updated — returns `409 Conflict`.
- `metadata`, if provided, must be a JSON object (not an array or scalar).

**Response:** `200 OK` with the updated run object.

## `DELETE /api/v1/instruments/:instrumentId/runs/:runId`

Soft-deletes an instrument run by setting `deleted_at`. S3 objects are **not** deleted immediately — they are retained so the run can be restored if needed. Permanent cleanup of S3 objects for soft-deleted runs is handled by a separate lifecycle process (see "S3 lifecycle for soft-deleted runs" below).

**Validation:**
- The run must exist and not already be soft-deleted (`deleted_at` must be `NULL`). Returns `404` if not found, `409` if already deleted.

**Request body:** None required.

**Response:** `200 OK`

```json
{
  "instrument_id": "mass-spec-instrument",
  "run_id": "20260325",
  "deleted_at": "2026-03-27T10:00:00Z"
}
```

**Side effects:**
1. Sets `instrument_runs.deleted_at` to now.
2. Does **not** delete S3 objects, database rows (`files`, `run_report_data`), or `metadata` columns — all are retained for audit purposes and to support restoring the run within the retention window.

### Restoring a soft-deleted run

A soft-deleted run can be restored by clearing `deleted_at` (setting it back to `NULL`) as long as the S3 objects have not yet been permanently removed by the lifecycle process. A dedicated restore endpoint is out of scope for v1 but the data model supports it.

### S3 lifecycle for soft-deleted runs

S3 objects for soft-deleted runs are cleaned up by a scheduled background job (e.g., a daily cron or Lambda) rather than inline during the DELETE request. The job:

1. Queries for runs where `deleted_at` is older than a configurable retention period (default: 30 days).
2. Deletes all S3 objects referenced in the `files` table for those runs (both raw and processed buckets).
3. Sets a `files_purged_at` timestamp on the `instrument_runs` row to record when S3 objects were permanently removed.

This separation ensures that soft-delete is fast (no inline S3 I/O), reversible within the retention window, and that permanent data destruction is an explicit, auditable step. The retention period should be documented for users so they understand the window for recovery.

## Endpoints — Files

### `POST /api/v1/instruments/:instrumentId/runs/:runId/files`

Creates a file record for an instrument run with S3 information. Idempotent on `s3_key` — if a file with the same S3 key already exists, returns the existing record. This is the primary endpoint used by the **Lambda function** to register a file before processing it. It also supports the Lambda recording processed artifacts (with `category: "processed"`).

**Request body:**

```json
{
  "s3_bucket": "arcadia-raw-data-hub-staging",
  "s3_key": "spectramax-id3-plate-reader/2026-03-26_experiment/2026-03-26_experiment.xls",
  "filename": "2026-03-26_experiment.xls",
  "content_type": "application/vnd.ms-excel",
  "size_bytes": 45056,
  "category": "raw"
}
```

**Required fields:** `s3_bucket`, `s3_key`, `filename`.

**Optional fields:** `content_type`, `size_bytes`, `category` (defaults to `raw`).

**Validation:**
- The run must exist and not be soft-deleted. Returns `404` if not found, `409 Conflict` if deleted.
- `s3_key` must be non-empty.

**Response:** `201 Created` (or `200 OK` if the file already exists)

```json
{
  "id": 1,
  "instrument_run_id": "a8e3c2f1-7b4d-4e6a-9f1c-2d3b4a5e6f78",
  "s3_bucket": "arcadia-raw-data-hub-staging",
  "s3_key": "spectramax-id3-plate-reader/2026-03-26_experiment/2026-03-26_experiment.xls",
  "filename": "2026-03-26_experiment.xls",
  "content_type": "application/vnd.ms-excel",
  "size_bytes": 45056,
  "category": "raw",
  "status": "uploaded",
  "metadata": {},
  "error_message": null,
  "uploaded_at": "2026-03-26T20:15:00Z",
  "processed_at": null,
  "created_at": "2026-03-26T20:15:00Z"
}
```

**Behavior:**
- Looks up the run by `:instrumentId` + `:runId` (natural keys).
- Attempts to insert a `files` row with `status: "uploaded"` and `uploaded_at` set to now. If a row with the same `s3_key` already exists (partial UNIQUE constraint), returns the existing row with `200 OK` instead of `201 Created`.
- The Lambda subsequently transitions the status via `PATCH /api/v1/files/:fileId`.

### `GET /api/v1/files/:id/download`

Redirects to a pre-signed S3 URL for the file. Allows the web UI to link directly to file downloads without exposing S3 URLs in the page HTML.

This endpoint requires authentication (session cookie or personal access token). Returns `401 Unauthorized` if not authenticated.

**Response:** `302 Redirect` with `Location` header set to the pre-signed URL.

### `PATCH /api/v1/files/:fileId`

Updates a file record. Serves two callers:

**1. Watcher — marking a detected file as uploaded to S3:**

After uploading a file, the watcher updates the existing `files` row (which was created with `status: 'detected'` when the run was reported) with S3 information. The watcher knows the file ID from the upload-queue response.

```json
{
  "s3_bucket": "arcadia-raw-data-hub-staging",
  "s3_key": "mass-spec-instrument/20260325/20260325_data_file_1.csv",
  "content_type": "text/csv",
  "status": "uploaded"
}
```

This sets `files.s3_bucket`, `files.s3_key`, `files.content_type`, `files.status` to `uploaded`, and `files.uploaded_at` to now.

**2. Lambda function — updating processing status, metadata, and report data:**

**Request body — metadata extraction only (most instruments):**

```json
{
  "status": "completed",
  "metadata": {
    "imaging_mode": "Fluorescence",
    "wavelength": ["488", "647"]
  }
}
```

**Request body — metadata + parsed data (e.g., plate reader):**

```json
{
  "status": "completed",
  "metadata": {
    "measurement_mode": "Fluorescence",
    "measurement_type": "Endpoint",
    "wavelength": "450"
  },
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

**Request body — processing failure:**

```json
{
  "status": "failed",
  "error_message": "Unsupported file format: expected .xls, got .xlsx"
}
```

**Validation:**
- The file must exist. Returns `404` if not found.
- `status` transitions are enforced. Valid transitions: `detected` → `uploaded` (auto-mode watcher path), `upload_requested` → `uploaded` (manual-mode watcher path), `uploaded` → `processing` → `completed`/`failed` (Lambda path). Returns `409 Conflict` for invalid transitions.
- When setting `s3_key`, the value must not conflict with existing keys (partial unique constraint).
- The file's parent run must not be soft-deleted.
- The file must not be soft-deleted (`deleted_at` must be `NULL`).

**Behavior:**
- Updates the specified fields on the `files` row.
- When `status` is set to `uploaded`: sets `files.uploaded_at` to now.
- When `status` is set to `completed` or `failed`: sets `files.processed_at` to now.
- If `report_data` is provided, inserts `run_report_data` rows linked to both the file (`file_id`) and the parent run (`instrument_run_id`).

**Response:** `200 OK` with the updated file object.

### `DELETE /api/v1/files/:fileId`

Soft-deletes a single file by setting `files.deleted_at`. Used by the web UI to dismiss individual detected files without uploading them.

**Validation:**
- The file must exist and not already be soft-deleted. Returns `404` if not found, `409 Conflict` if already deleted.
- Only files in `detected` or `upload_requested` status can be dismissed. Files that have been uploaded to S3 (status `uploaded` or later) cannot be dismissed via this endpoint — use the run-level `DELETE` endpoint instead. Returns `409 Conflict` for files in non-dismissible status.

**Response:** `200 OK`

```json
{
  "id": 1,
  "filename": "20260325_data_file_1.csv",
  "deleted_at": "2026-03-27T10:00:00Z"
}
```

**Side effects:**
- Sets `files.deleted_at` to now.
- Sets `instrument_runs.updated_at` to now on the parent run.

## Endpoints — Analysis

These endpoints support run-level processing — analyses that operate across multiple files in a run (e.g., Michaelis-Menten kinetics on SpectraMax iD3 runs). Run-level processing is manually triggered from the web UI, not automatically invoked by the Lambda's S3 event.

### `POST /api/v1/instruments/:instrumentId/runs/:runId/analyses`

Triggers a run-level analysis. The API invokes the Lambda function (or a dedicated processor) with the run context.

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

Returns analysis results for the run, including status and output data. Analysis results are stored in `run_report_data` with `file_id = NULL` (since they are derived from the run as a whole, not a single file).

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

Standard HTTP status codes: `400` for validation errors, `401` for missing/invalid auth, `404` for not found, `409` for conflicts (e.g., invalid file status transition, updating a soft-deleted run), `500` for internal errors.

## Acceptance Criteria

1. `POST /api/v1/instruments/:instrumentId/runs` creates an instrument run. Calling it twice with the same `instrument_id` and `run_id` returns the existing record rather than creating a duplicate.
2. `GET /api/v1/instruments/:instrumentId/runs` returns paginated results with filtering by source and search, including per-file processing summaries (`files_completed`, `files_failed`, `files_pending_upload`).
3. `GET /api/v1/instrument-runs` returns paginated results across all instruments with filtering by instrument, source, and search.
4. `GET /api/v1/instruments/:instrumentId/runs/:runId` returns the full run detail including all files (detected through completed) with per-file status, per-file metadata, and pre-signed download URLs (for uploaded files only).
5. Pre-signed S3 URLs work for downloading raw and processed files from the web UI.
6. `POST /api/v1/instruments/:instrumentId/runs` accepts watcher-reported runs with `detected_files`, creating `instrument_runs` and `files` rows with `status: 'detected'`.
7. `POST /api/v1/instruments/:instrumentId/runs/:runId/request-upload` sets `upload_requested_at` on individual files. Returns `400` for files not in `detected` status, `409` for soft-deleted runs.
8. `GET /api/v1/watchers/:watcher_id/upload-queue` returns a flat list of files where `upload_requested_at` is set and `uploaded_at` is `NULL` for the watcher's instrument, including run context.
9. `PATCH /api/v1/instruments/:instrumentId/runs/:runId` updates detected files and sets run-level metadata. Returns `409` for soft-deleted runs.
10. `POST /api/v1/instruments/:instrumentId/runs/:runId/files` creates a file record with S3 info (Lambda path) and returns the file ID. Calling it twice with the same `s3_key` returns the existing record rather than creating a duplicate.
11. `PATCH /api/v1/files/:fileId` supports the auto-mode watcher path (`detected` → `uploaded`), the manual-mode watcher path (`upload_requested` → `uploaded` with S3 info), and the Lambda processing path (`uploaded` → `processing` → `completed`/`failed` with metadata and report data).
12. `DELETE /api/v1/files/:fileId` soft-deletes individual files in `detected` or `upload_requested` status. Returns `409` for files already uploaded to S3.
13. `DELETE /api/v1/instruments/:instrumentId/runs/:runId` soft-deletes the run (sets `deleted_at`). S3 objects are retained and only permanently removed after the retention period by the lifecycle job.
14. `GET /api/v1/instruments/:instrumentId/runs` and `GET /api/v1/instrument-runs` exclude soft-deleted runs by default; include them when `include_deleted=true` is passed.
