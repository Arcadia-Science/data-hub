# Lambda Function Migration

Prerequisite reading: [ARCHITECTURE.md](../ARCHITECTURE.md), [api/INSTRUMENT_RUNS.md](../api/INSTRUMENT_RUNS.md).

The Lambda function (`lambda_function.py`) and per-instrument `generate_report` workflows must be refactored to write to the Data Hub API instead of Notion. The refactoring can be done incrementally, one instrument at a time.

## What Changes

| Current behavior | New behavior |
|---|---|
| `ganymede.api.get_files(tag=...)` to get file metadata and tags | Tags are no longer needed. The Lambda receives the filename from the S3 event and extracts metadata from the raw file directly. |
| `ganymede.api.post_query(sql)` to query BigQuery tables (SpectraMax) | The Lambda parses raw data from the downloaded file and includes it in the API payload as `report_data`. |
| `notion.api.create_page_in_database(...)` with properties and blocks | `POST /api/v1/instruments/:instrumentId/runs` with structured JSON. |
| `notion.utils.get_instrument_run_page_id(...)` for idempotency | The API endpoint is idempotent on `(instrument_id, run_id)` — upsert semantics. |
| `notion.api.upload_file(...)` for embedding files in pages | Files are already in S3. The Lambda records their S3 keys in the `files` array of the API payload. |
| `notion.api.update_page_properties(...)` for analysis status | `PATCH /api/v1/instruments/:instrumentId/runs/:runId` or the analyses sub-resource. |
| Return Notion page URL for Slack messages | Return the web app URL: `https://data-hub.arcadiascience.com/instruments/{instrument_id}/runs/{run_id}`. |

## What Stays the Same

- S3 event parsing (`parse_s3_event`) — unchanged.
- S3 file download (`s3_utils.download_file`) — unchanged.
- S3 processed upload (`s3_utils.upload_file` / `upload_folder`) — unchanged.
- Instrument-specific file parsing and data extraction logic — unchanged (but output target changes from Notion blocks to API payload).
- Slack notifications — unchanged (URL changes from Notion to web app).
- GitHub Actions manual invocation — unchanged.

## Migration Path

1. Add a Data Hub API client module to the Lambda codebase (similar to the watcher's `api_client.py`).
2. Refactor one workflow at a time: modify `generate_report` to construct an API payload and call `POST /api/v1/instruments/:instrumentId/runs` instead of the Notion API.
3. During the transition, a workflow can optionally dual-write to both Notion and the database for validation.
4. Once all six workflows are migrated, remove the `ganymede/` and `notion/` modules and their dependencies.

## Acceptance Criteria

1. At least one instrument workflow (`generate_report`) is refactored to write to the API instead of Notion, demonstrating the migration path.
