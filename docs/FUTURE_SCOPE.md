# Future Scope

These features are not required initially but the design should not preclude them.

## Web Application & API

- **Real-time updates:** WebSocket or SSE for live run status updates on the dashboard (e.g., a run transitions from `processing` to `completed`).
- **Charts and visualizations:** interactive plots for kinetic and spectrum data on run detail pages.
- **Role-based permissions:** admin vs. viewer roles (e.g., only admins can confirm pending instruments or manage watchers).
- **Audit log:** track who triggered analyses, confirmed instruments, etc.
- **Notifications:** in-app notification feed in addition to Slack.
- **Historical data migration:** one-time import of existing Notion database pages and Ganymede table data into the new database.
- **Bulk operations:** re-run reports for multiple runs, bulk export data.
- **Instrument-specific detail pages:** custom visualizations per instrument type (e.g., gel image viewer for Azure 600, plate map editor for SpectraMax).
- **Restore deleted runs:** allow admins to restore soft-deleted runs (would require re-uploading files from the instrument PC or a backup).
- **Upload progress tracking:** real-time progress updates during file upload (percentage, bytes transferred) via WebSocket or SSE.
- **Selective file upload:** allow users to select individual files within a reported run for upload rather than all files.
- **Auto-dismiss stale reported runs:** automatically soft-delete reported runs that have not been uploaded within a configurable period.

## File Upload Service (Watcher)

- **TUI mode:** A Textual-based full-screen interface for monitoring uploads and watcher status.
- **Multi-environment configs:** Supporting both staging and production in a single config file.
- **Ledger pruning:** Automatic garbage collection of old upload and run ledger entries.
- **Deep subdirectory recursion:** The `directory` run detection method monitors one level of subdirectories. Future versions could support deeper nesting.
- **Parallel uploads:** Uploading multiple files concurrently.
- **Progress bars:** Upload progress for large files.
- **Run dismissal from CLI:** Allow the watcher CLI to dismiss reported runs locally without the web UI.
- **Selective file upload:** Allow users to select individual files within a reported run for upload, rather than uploading all files.
