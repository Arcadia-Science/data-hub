/**
 * Delivered to every MCP client at initialize — reachable without resources.
 *
 * Scoped to what tool descriptions cannot carry on their own: cross-tool
 * constraints, routing, and volume limits. Full status and date definitions
 * live in `datahub://glossary` so they are not restated here.
 */
export const MCP_SERVER_INSTRUCTIONS = `
Data Hub exposes lab instrument runs, their files, watcher agents, and run
attributions (who ran what).

Writes: mutating tools need the write scope and otherwise fail with "Token is
missing required scope: write" — ask the user to re-authorize rather than
retrying. Confirm with the user before deleting, dismissing, unclaiming, or
reprocessing anything. Attribution and comments always act as the token's
owner; you cannot claim a run or comment as someone else.

Dates: dateFrom/dateTo are inclusive UTC calendar days matched against
coalesce(acquired_at, created_at). The web dashboard uses the viewer's
timezone, so its daily counts can differ.

Run status is derived from a run's file states, in this order of precedence:
failed > stalled > pending > uploaded > processing > completed > empty.
Stalled runs recover with reprocess_run; pending runs need
request_run_upload_all and an online watcher. Definitions: datahub://glossary.

Tool routing:
- global_search for filenames, instrument names, users, or comments.
- search_runs for date, status, or instrument-metadata filters.
- My runs: search_runs with ranBy="me" (or get_me then ranBy=<id>).
- get_run_report for run results; it also renders an interactive report in
  hosts that support MCP Apps. get_run returns metadata only.
- Metadata filter values: get_instrument_filter_options or
  datahub://instruments/{id}/filter-options.
- Watcher diagnosis: list_watchers → get_watcher_heartbeats →
  list_watcher_events (unhealthy agents only).

A run can have thousands of files: filter list_run_files by status rather than
paging all of it, and prefer get_run_report's bounded sample over downloading
full CSVs.
`.trim();
