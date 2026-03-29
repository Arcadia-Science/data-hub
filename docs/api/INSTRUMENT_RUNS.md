# API: Instrument Runs

Prerequisite reading: [ARCHITECTURE.md](../ARCHITECTURE.md), [DATABASE_SCHEMA.md](../DATABASE_SCHEMA.md) (`instrument_runs`, `files`, `reported_files`, `run_report_data` tables), [AUTHENTICATION.md](./AUTHENTICATION.md).

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
- For watcher-reported runs: upserts `reported_files` rows from the `detected_files` array (skip duplicates by `relative_path`).
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
      "has_reported_files": false,
      "upload_requested_at": null,
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

The `files_completed` and `files_failed` counts are computed from the `files.status` column. `has_reported_files` indicates whether the run has `reported_files` rows (i.e., local files on the instrument PC not yet uploaded to S3). `upload_requested_at` is non-`NULL` when a user has requested upload via the web UI.

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
  "upload_requested_at": null,
  "files": [
    {
      "id": 1,
      "filename": "2026-03-26_experiment.xls",
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
      "processed_at": "2026-03-26T20:16:30Z",
      "download_url": "https://...",
      "created_at": "2026-03-26T20:15:00Z"
    }
  ],
  "reported_files": [],
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

The `download_url` for each file is a pre-signed S3 URL generated at response time (short-lived, e.g., 15-minute expiry).

For watcher-reported runs where files have not yet been uploaded, the `files` array is empty and `reported_files` contains the detected file list:

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
  "upload_requested_at": null,
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
- The run must exist and have `reported_files` rows. Returns `404` if the run is not found.
- The run must not already have `upload_requested_at` set. Returns `409 Conflict` if upload has already been requested.
- Soft-deleted runs cannot be queued — returns `409 Conflict`.

**Request body:** None required.

**Response:** `200 OK`

```json
{
  "instrument_id": "mass-spec-instrument",
  "run_id": "20260325",
  "upload_requested_at": "2026-03-26T10:00:00Z"
}
```

**Side effects:**
- Sets `instrument_runs.upload_requested_at` to now.
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
- All referenced runs must exist and have `reported_files`. Runs that don't meet the criteria (already queued, no reported files, soft-deleted) are skipped with a warning in the response.

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

Documented in [WATCHERS.md](./WATCHERS.md#get-apiv1watcherswatcher_idupload-queue). Lives under the `/api/v1/watchers/` path namespace and should be implemented alongside the other watcher routes. Returns runs where `upload_requested_at` is non-`NULL` for the watcher's instrument.

## `PATCH /api/v1/instruments/:instrumentId/runs/:runId`

Updates a run record. Used by the watcher to add file records after upload completion or to update detected files for a reported run.

**Request body — adding file records after upload (watcher):**

```json
{
  "files": [
    {
      "s3_bucket": "arcadia-raw-data-hub-staging",
      "s3_key": "mass-spec-instrument/20260325/20260325_data_file_1.csv",
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
- Soft-deleted runs (`deleted_at` set) cannot be updated — returns `409 Conflict`.
- File records are upserted by `s3_key` (skip duplicates).

**Response:** `200 OK` with the updated run object.

## `DELETE /api/v1/instruments/:instrumentId/runs/:runId`

Soft-deletes an instrument run by setting `deleted_at`. Removes all associated files from S3.

**Validation:**
- The run must exist and not already be soft-deleted (`deleted_at` must be `NULL`). Returns `404` if not found, `409` if already deleted.

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
1. Sets `instrument_runs.deleted_at` to now.
2. Deletes all S3 objects referenced in the `files` table for this run (both raw and processed buckets).
3. Does **not** delete database rows for `files`, `reported_files`, or `run_report_data`, and does not clear the `metadata` columns — these are retained for audit purposes and potential future restore functionality.

## Endpoints — Files

### `POST /api/v1/instruments/:instrumentId/runs/:runId/files`

Creates a file record for an instrument run. Idempotent on `s3_key` — if a file with the same S3 key already exists, returns the existing record. This is the primary endpoint used by the Lambda function to register a file before processing it. It also supports the Lambda recording processed artifacts (with `category: "processed"`).

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
  "processed_at": null,
  "created_at": "2026-03-26T20:15:00Z"
}
```

**Behavior:**
- Looks up the run by `:instrumentId` + `:runId` (natural keys).
- Attempts to insert a `files` row. If a row with the same `s3_key` already exists (UNIQUE constraint), returns the existing row with `200 OK` instead of `201 Created`.
- New files are created with `status: "uploaded"`. The Lambda subsequently transitions the status via `PATCH /api/v1/files/:fileId`.

### `GET /api/v1/files/:id/download`

Redirects to a pre-signed S3 URL for the file. Allows the web UI to link directly to file downloads without exposing S3 URLs in the page HTML.

**Response:** `302 Redirect` with `Location` header set to the pre-signed URL.

### `PATCH /api/v1/files/:fileId`

Updates a file's processing status, metadata, and optionally writes parsed report data. This is the primary endpoint used by the Lambda function after processing a file.

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
- `status` must be one of `processing`, `completed`, `failed`. The valid transition is `uploaded` → `processing` → `completed`/`failed`. Returns `409 Conflict` for invalid transitions (e.g., updating a file already in `completed` status).
- The file's parent run must not be soft-deleted.

**Behavior:**
- Updates `files.status`, `files.metadata`, and `files.error_message`.
- Sets `files.processed_at` to now when `status` is `completed` or `failed`.
- If `report_data` is provided, inserts `run_report_data` rows linked to both the file (`file_id`) and the parent run (`instrument_run_id`).

**Response:** `200 OK` with the updated file object.

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
2. `GET /api/v1/instruments/:instrumentId/runs` returns paginated results with filtering by source and search, including per-file processing summaries (`files_completed`, `files_failed`).
3. `GET /api/v1/instrument-runs` returns paginated results across all instruments with filtering by instrument, source, and search.
4. `GET /api/v1/instruments/:instrumentId/runs/:runId` returns the full run detail including per-file status, per-file metadata, and pre-signed download URLs.
5. Pre-signed S3 URLs work for downloading raw and processed files from the web UI.
6. `POST /api/v1/instruments/:instrumentId/runs` accepts watcher-reported runs with `detected_files`, creating `instrument_runs` and `reported_files` rows.
7. `POST /api/v1/instruments/:instrumentId/runs/:runId/request-upload` sets `upload_requested_at` for runs with reported files. Returns `409` for runs already queued or soft-deleted.
8. `POST /api/v1/instrument-runs/batch-request-upload` queues multiple reported runs (identified by `instrument_id` + `run_id` pairs) and reports which were queued vs. skipped.
9. `GET /api/v1/watchers/:watcher_id/upload-queue` returns runs with `upload_requested_at` set for the watcher's instrument, including their `reported_files`.
10. `PATCH /api/v1/instruments/:instrumentId/runs/:runId` accepts file records on upload and updates detected files. Returns `409` for soft-deleted runs.
11. `POST /api/v1/instruments/:instrumentId/runs/:runId/files` creates a file record and returns the file ID. Calling it twice with the same `s3_key` returns the existing record rather than creating a duplicate.
12. `PATCH /api/v1/files/:fileId` updates per-file status, metadata, and report data. Enforces the `uploaded` → `processing` → `completed`/`failed` lifecycle.
13. `DELETE /api/v1/instruments/:instrumentId/runs/:runId` soft-deletes the run (sets `deleted_at`) and deletes all associated S3 objects.
14. `GET /api/v1/instruments/:instrumentId/runs` and `GET /api/v1/instrument-runs` exclude soft-deleted runs by default; include them when `include_deleted=true` is passed.
