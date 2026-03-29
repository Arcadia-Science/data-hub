# Lambda Function Migration

Prerequisite reading: [ARCHITECTURE.md](../ARCHITECTURE.md), [DATABASE_SCHEMA.md](../DATABASE_SCHEMA.md) (`files`, `run_report_data` tables), [api/INSTRUMENT_RUNS.md](../api/INSTRUMENT_RUNS.md).

The Lambda function (`lambda_function.py`) is triggered by S3 events and processes each uploaded file individually. Its job is to record the file in the database, extract metadata, and — for instruments that require it — parse structured data from the file. The refactoring from Notion to the Data Hub API can be done incrementally, one instrument at a time.

## Per-file Processing

The Lambda is invoked once per file landing in S3. For each file, the Lambda:

1. **Ensures the instrument run exists.** The Lambda derives a `run_id` from the filename (e.g., filename without extension) and calls `POST /api/v1/instruments/:instrumentId/runs` with upsert semantics. If a watcher already created the run, this is a no-op. If no run exists (the "no watcher" path — e.g., a direct S3 upload or re-processing trigger), the run is auto-created.
2. **Marks the file as processing.** Calls `PATCH /api/v1/files/:fileId` with `status: "processing"`.
3. **Extracts metadata.** Reads instrument-specific key-value metadata from the file (e.g., `measurement_mode`, `wavelength`) and writes it to the file's `metadata` column via the API.
4. **Parses structured data (instrument-specific).** For instruments like the plate reader, the Lambda parses the file to extract tabular data (e.g., `raw_well_data`, `plate_map`) and writes it to `run_report_data` linked to the specific file.
5. **Uploads processed artifacts (if any).** Some workflows produce processed files (e.g., images, PDFs). These are uploaded to the processed S3 bucket and recorded as additional `files` rows with `category: "processed"`.
6. **Marks the file as completed (or failed).** Updates the file status to `completed` or `failed` via `PATCH /api/v1/files/:fileId`.

Not every file requires parsing. For instruments like the Gel Doc or TapeStation, the Lambda may only extract metadata and mark the file as completed — no `run_report_data` rows are created. The two tiers of processing:

| Tier | What the Lambda does | Example instruments |
|---|---|---|
| Metadata extraction only | Reads the file to extract key-value metadata; no tabular data parsing. | Azure 600 Gel Doc, Agilent 4150 TapeStation, Akta FPLC |
| Metadata + data parsing | Extracts metadata and parses structured tabular data into `run_report_data`. | SpectraMax iD3/iD5 Plate Reader, Azure Cielo qPCR |

## Run-level Processing

Full run-level processing — which may aggregate data across multiple files, run analyses, or produce derived datasets — is **not** triggered automatically by the Lambda's S3 event. Instead, it is manually triggered from the web UI via `POST /api/v1/instruments/:instrumentId/runs/:runId/analyses`.

When a user triggers run-level processing, the API invokes the Lambda function (or a dedicated processor) with the run context rather than a single-file S3 event. This covers use cases like Michaelis-Menten kinetics on SpectraMax runs, where the analysis operates on data aggregated from the run's files.

## What Changes

| Current behavior | New behavior |
|---|---|
| `ganymede.api.get_files(tag=...)` to get file metadata and tags | Tags are no longer needed. The Lambda receives the filename from the S3 event and extracts metadata from the raw file directly. |
| `ganymede.api.post_query(sql)` to query BigQuery tables (SpectraMax) | The Lambda parses raw data from the downloaded file and writes it to `run_report_data` via the API. |
| `notion.api.create_page_in_database(...)` with properties and blocks | Per-file: `PATCH /api/v1/files/:fileId` with metadata and status. Run creation: `POST /api/v1/instruments/:instrumentId/runs` (upsert). |
| `notion.utils.get_instrument_run_page_id(...)` for idempotency | The runs endpoint is idempotent on `(instrument_id, run_id)` — upsert semantics. The files endpoint is idempotent on `s3_key`. |
| `notion.api.upload_file(...)` for embedding files in pages | Files are already in S3. The Lambda records their S3 keys via the API. |
| `notion.api.update_page_properties(...)` for analysis status | `POST /api/v1/instruments/:instrumentId/runs/:runId/analyses` for run-level processing. |
| Return Notion page URL for Slack messages | Return the web app URL: `https://data-hub.arcadiascience.com/instruments/{instrument_id}/runs/{run_id}`. |

## What Stays the Same

- S3 event parsing (`parse_s3_event`) — unchanged.
- S3 file download (`s3_utils.download_file`) — unchanged.
- S3 processed upload (`s3_utils.upload_file` / `upload_folder`) — unchanged.
- Instrument-specific file parsing and data extraction logic — unchanged (but scoped per-file, and output target changes from Notion blocks to API payload).
- Slack notifications — unchanged (URL changes from Notion to web app).
- GitHub Actions manual invocation — unchanged.

## Migration Path

1. Add a Data Hub API client module to the Lambda codebase (similar to the watcher's `api_client.py`).
2. Refactor one workflow at a time: modify `generate_report` to operate as a per-file processor — extract metadata, optionally parse structured data, and write results via the file-level API endpoints.
3. During the transition, a workflow can optionally dual-write to both Notion and the database for validation.
4. Once all six workflows are migrated, remove the `ganymede/` and `notion/` modules and their dependencies.

## Acceptance Criteria

1. At least one instrument workflow is refactored to process a single file via the API (extract metadata, update file status) instead of writing to Notion, demonstrating the per-file processing path.
