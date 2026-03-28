# Web: Instrument, Run, and Watcher Pages

Prerequisite reading: [ARCHITECTURE.md](../ARCHITECTURE.md), [api/INSTRUMENT_RUNS.md](../api/INSTRUMENT_RUNS.md), [api/INSTRUMENTS.md](../api/INSTRUMENTS.md), [api/WATCHERS.md](../api/WATCHERS.md), [web/DASHBOARD.md](./DASHBOARD.md) (shared UI patterns).

## Instrument Detail (`/instruments/:instrumentId`)

All runs for a single instrument.

**Content:**
- Instrument header: display name, status, watcher status(es), upload mode indicator (auto / manual).
- **Reported Runs section** (visible only for instruments with manual-mode watchers and at least one reported run): a highlighted section above the main runs table showing runs with `status = 'reported'`. Each row shows: run ID, file count, total size, detected timestamp, and action buttons:
  - **"Upload"** button — queues the run for upload (`POST /api/v1/instruments/:instrumentId/runs/:runId/request-upload`).
  - **"Dismiss"** button — soft-deletes the reported run without uploading (`DELETE /api/v1/instruments/:instrumentId/runs/:runId`). Requires confirmation.
  - **Bulk actions:** checkbox selection with "Upload selected" and "Dismiss selected" buttons at the top of the section.
- Runs table with the same columns as the dashboard table, filtered to this instrument. Sortable and paginated. Excludes soft-deleted runs (where `deleted_at` is set), which are shown via a separate toggle or tab.
- Metadata filters specific to this instrument (e.g., filter by measurement mode for SpectraMax, by tape type for TapeStation).
- **"Deleted Runs" tab or toggle** — shows soft-deleted runs (`deleted_at` set) for this instrument with muted styling. Each row shows: run ID, last workflow status (preserved in the `status` column), `deleted_at` timestamp.

## Run Detail (`/instruments/:instrumentId/runs/:runId`)

The replacement for a Notion report page. Displays all information the Lambda wrote for this run.

**Content:**
- Header: instrument name, run ID, status badge, timestamps, report version, source indicator (`lambda` or `watcher`).
  - **Action buttons in header:**
    - For `reported` runs: **"Upload"** button (queues for upload) and **"Dismiss"** button (soft-delete without uploading).
    - For runs in `uploaded`, `processing`, `completed`, `failed` statuses: **"Delete"** button (soft-delete with confirmation dialog, see below).
    - For `queued_for_upload` runs: status indicator showing the run is waiting for the watcher to pick it up. No action buttons (the user has already requested upload).
    - For `uploading` runs: progress indicator. No action buttons.
    - For soft-deleted runs (`deleted_at` set): muted header with `deleted_at` timestamp. No action buttons.
- **Delete confirmation dialog:** Warns the user that deletion will remove all files from S3 and is not reversible. Shows the count and total size of files that will be deleted. Requires the user to type the run ID to confirm (for runs with `completed` status that have report data).
- Metadata section: key-value display of all `instrument_run_metadata` entries for this run (e.g., Measurement Mode: Fluorescence, Wavelength: 450). Empty for `reported` runs.
- Files section: depends on run status:
  - For `reported` or `queued_for_upload` runs: shows the `reported_files` list (filename, size, detected timestamp). Files are **not** downloadable since they haven't been uploaded to S3. A note explains that files are on the instrument PC and will be uploaded when the watcher processes the upload request.
  - For `uploaded`, `processing`, `completed` runs: list of raw and processed files with download links (pre-signed S3 URLs). Inline preview for supported types:
    - **Images** (PNG, TIFF, JPEG): rendered inline.
    - **PDFs**: embedded PDF viewer or download link.
    - **Spreadsheets** (XLS, XLSX, CSV): download link.
  - For soft-deleted runs: shows the file list from the database (filenames, sizes) but without download links. A note explains that files have been deleted from S3.
- Report data section: rendered from `run_report_data` entries. Empty for `reported` / `queued_for_upload` / `uploading` / `uploaded` runs. The rendering depends on `data_type`:
  - `plate_map` → plate-format grid (rows A–H/P, columns 1–12/24) with values in cells.
  - `raw_well_data` → scrollable data table.
  - `kinetic_data`, `spectrum_data` → data table (with optional chart visualization in future scope).
  - `sample_table` → data table.
- Analysis section (if analyses exist): status and results of follow-on analyses.

## Watchers (`/watchers`)

Admin view of all registered file upload service instances.

**Content:**
- Table: watcher ID, instrument, hostname, status (watching / stopped / stale), last heartbeat, uptime.
- Status indicators: green for active (heartbeat within 5 min), yellow for stale, gray for stopped.
- Click into a watcher for detail view (`/watchers/:id`).

## Watcher Detail (`/watchers/:id`)

Detailed view of a single watcher instance, providing remote troubleshooting without RDP access to the lab PC.

**Content:**
- **Header:** watcher ID, instrument name, hostname, OS info, status badge, last heartbeat timestamp.
- **Config section:** the last-pushed config YAML (from `watchers.config_yaml`), displayed as a formatted YAML block.
- **Heartbeat history:** a time-series chart or table of recent heartbeats (from `watcher_heartbeats`), showing status, upload/error counters, and uptime over time. Default view: last 24 hours. Filterable by date range.
- **Event log:** a chronological feed of significant events (from `watcher_events`), showing event type icon/badge, message, timestamp, and expandable details. Default view: last 7 days. Filterable by event type and date range. Event type color coding: green for `file_uploaded` / `run_uploaded` / `config_synced`, red for `upload_failed` / `error`, blue for `watcher_started` / `watcher_stopped` / `run_reported`.

## Instruments Admin (`/instruments`)

Admin view for managing the instrument registry.

**Content:**
- Table: instrument ID, display name, status, file patterns, watcher count, run count.
- Ability to confirm pending instruments (set status to `active`).
- Ability to edit display name and file patterns.

## Acceptance Criteria

1. The run detail page renders metadata, file links, and report data tables (including plate map grids for SpectraMax).
2. The watchers page shows all registered watchers with heartbeat status indicators.
3. The instrument detail page shows a "Reported Runs" section with "Upload" and "Dismiss" actions for instruments with manual-mode watchers.
4. Bulk upload selection works: users can select multiple reported runs and queue them all for upload in one action.
5. The run detail page shows `reported_files` (not downloadable) for runs in `reported` status and S3-backed files (downloadable) for uploaded/completed runs.
6. The delete confirmation dialog on the run detail page warns about S3 file deletion and requires run ID confirmation for completed runs.
7. Deleted runs are visible in a "Deleted Runs" tab on the instrument detail page with muted styling.
8. The watcher detail page (`/watchers/:id`) displays config, heartbeat history (chart or table), and a chronological event log with type filtering.
