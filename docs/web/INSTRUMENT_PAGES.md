# Web: Instrument, Run, and Watcher Pages

Prerequisite reading: [ARCHITECTURE.md](../ARCHITECTURE.md), [api/INSTRUMENT_RUNS.md](../api/INSTRUMENT_RUNS.md), [api/INSTRUMENTS.md](../api/INSTRUMENTS.md), [api/WATCHERS.md](../api/WATCHERS.md), [web/DASHBOARD.md](./DASHBOARD.md) (shared UI patterns).

## Instrument Detail (`/instruments/:instrumentId`)

All runs for a single instrument.

**Content:**
- Instrument header: display name, status, watcher status(es), upload mode indicator (auto / manual).
- **Reported Runs section** (visible only for instruments with manual-mode watchers and at least one run with `reported_files` and no `upload_requested_at`): a highlighted section above the main runs table showing runs awaiting upload. Each row shows: run ID, file count, total size, detected timestamp, and action buttons:
  - **"Upload"** button — queues the run for upload (`POST /api/v1/instruments/:instrumentId/runs/:runId/request-upload`).
  - **"Dismiss"** button — soft-deletes the reported run without uploading (`DELETE /api/v1/instruments/:instrumentId/runs/:runId`). Requires confirmation.
  - **Bulk actions:** checkbox selection with "Upload selected" and "Dismiss selected" buttons at the top of the section.
- Runs table with the same columns as the dashboard table, filtered to this instrument. Sortable and paginated. Excludes soft-deleted runs (where `deleted_at` is set), which are shown via a separate toggle or tab.
- Metadata filters specific to this instrument (e.g., filter by measurement mode for SpectraMax, by tape type for TapeStation).
- **"Deleted Runs" tab or toggle** — shows soft-deleted runs (`deleted_at` set) for this instrument with muted styling. Each row shows: run ID, `deleted_at` timestamp, and whether the run is restorable (i.e., `files_purged_at` is still `NULL`).

## Run Detail (`/instruments/:instrumentId/runs/:runId`)

The replacement for a Notion report page. Displays all information about the run: per-file processing results, metadata, and report data.

**Content:**
- Header: instrument name, run ID, timestamps, source indicator (`lambda` or `watcher`).
  - **Action buttons in header:**
    - For runs with `reported_files` and no `upload_requested_at`: **"Upload"** button (queues for upload) and **"Dismiss"** button (soft-delete without uploading).
    - For runs with `upload_requested_at` set but no files uploaded yet: status indicator showing the run is waiting for the watcher to pick it up.
    - For runs with uploaded files: **"Delete"** button (soft-delete with confirmation dialog, see below).
    - For soft-deleted runs (`deleted_at` set): muted header with `deleted_at` timestamp. If the run is still within the retention window (`files_purged_at` is `NULL`), a **"Restore"** button is shown (clears `deleted_at`). After purge, no action buttons.
- **Delete confirmation dialog:** Warns the user that the run will be soft-deleted and can be restored within the retention period (default: 30 days), after which S3 files are permanently removed. Shows the count and total size of files associated with the run. Requires the user to type the run ID to confirm (for runs that have report data).
- Metadata section: two-level display:
  - **Run-level metadata:** key-value display of the run's `metadata` JSONB object. Array values are displayed as comma-separated lists. May be empty if no run-level metadata has been set.
  - **Per-file metadata:** shown inline with each file in the files section (see below).
- Files section: depends on what data is available for the run:
  - **Reported files** (when `reported_files` exist and files have not been uploaded): shows the `reported_files` list (filename, size, detected timestamp). Files are **not** downloadable since they haven't been uploaded to S3. A note explains that files are on the instrument PC.
  - **Uploaded files** (when `files` rows exist): list of raw and processed files with download links (pre-signed S3 URLs). Each file shows a **status badge** (`uploaded`, `processing`, `completed`, `failed`) and its per-file `metadata` as key-value pairs. Files with `status = 'failed'` display the `error_message`. Inline preview for supported types:
    - **Images** (PNG, TIFF, JPEG): rendered inline.
    - **PDFs**: embedded PDF viewer or download link.
    - **Spreadsheets** (XLS, XLSX, CSV): download link.
  - **Soft-deleted runs (within retention window, `files_purged_at` NULL):** shows the file list with download links still functional (S3 objects are retained). A banner explains that the run is deleted and will be permanently purged after the retention period, with the option to restore.
  - **Soft-deleted runs (after purge, `files_purged_at` set):** shows the file list from the database (filenames, sizes) but without download links. A note explains that S3 files have been permanently removed and the run can no longer be restored.
- Report data section: rendered from `run_report_data` entries, grouped by source file (`file_id`). Report data with `file_id = NULL` (from run-level analyses) is shown in a separate "Run Analysis" subsection. The rendering depends on `data_type`:
  - `plate_map` → plate-format grid (rows A–H/P, columns 1–12/24) with values in cells.
  - `raw_well_data` → scrollable data table.
  - `kinetic_data`, `spectrum_data` → data table (with optional chart visualization in future scope).
  - `sample_table` → data table.
- **Run Analysis section:** shows the status and results of run-level analyses triggered via `POST /api/v1/instruments/:instrumentId/runs/:runId/analyses`. Includes a **"Run Analysis"** button to trigger new analyses (only available when files have been processed).

## Watchers (`/watchers`)

Admin view of all registered file upload service instances.

**Content:**
- Table: watcher ID, instrument, hostname, effective status (watching / stopped / stale), last heartbeat, uptime. Each row has a **"Deregister"** action button (see below). The `stale` status is not stored in the database — it is computed at query time by the API when `last_heartbeat_at` exceeds the 5-minute threshold (see [DATABASE_SCHEMA.md](../DATABASE_SCHEMA.md)).
- Status indicators: green for active (heartbeat within 5 min), yellow for stale (computed), gray for stopped.
- Click into a watcher for detail view (`/watchers/:id`).
- **"Deregistered Watchers" tab or toggle** — shows soft-deleted watchers (`deleted_at` set) with muted styling. Each row shows: watcher ID, instrument, hostname, last status, `deleted_at` timestamp. No action buttons.
- **Deregister action:** calls `DELETE /api/v1/watchers/:watcher_id`. Requires a confirmation dialog warning that the watcher will no longer be able to send heartbeats or events. The confirmation dialog should advise the user to stop the watcher service on the instrument PC first.

## Watcher Detail (`/watchers/:id`)

Detailed view of a single watcher instance, providing remote troubleshooting without RDP access to the lab PC.

**Content:**
- **Header:** watcher ID, instrument name, hostname, OS info, status badge, last heartbeat timestamp. Includes a **"Deregister"** button (same behavior and confirmation dialog as the watchers list page).
- For soft-deleted watchers (`deleted_at` set): muted header with `deleted_at` timestamp. No action buttons. Heartbeat history and event log remain visible for historical diagnostics.
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

1. The run detail page renders per-file status badges, per-file metadata, file download links, and report data tables (including plate map grids for SpectraMax).
2. The watchers page shows all active watchers with heartbeat status indicators. Deregistered watchers are accessible via a "Deregistered Watchers" tab or toggle.
3. The instrument detail page shows a "Reported Runs" section with "Upload" and "Dismiss" actions for instruments with manual-mode watchers.
4. Bulk upload selection works: users can select multiple reported runs and queue them all for upload in one action.
5. The run detail page shows `reported_files` (not downloadable) for runs awaiting upload and S3-backed files (downloadable, with per-file processing status) for uploaded runs.
6. The delete confirmation dialog on the run detail page explains the retention period and requires run ID confirmation for runs with report data.
7. Deleted runs are visible in a "Deleted Runs" tab on the instrument detail page with muted styling, showing restore eligibility based on whether S3 files have been purged.
8. The watcher detail page (`/watchers/:id`) displays config, heartbeat history (chart or table), and a chronological event log with type filtering.
9. The watchers list and watcher detail pages include a "Deregister" action with a confirmation dialog. Deregistered watchers display with muted styling and no action buttons.
10. The run detail page includes a "Run Analysis" button and displays run-level analysis results in a dedicated section.
