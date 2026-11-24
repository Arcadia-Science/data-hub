import { FEEDBACK_APP } from "@/lib/feedback-app";

/**
 * Sent to every client at initialize. Claude Code keeps only the first 2 KB, so
 * a unit test caps the length and the most important points come first. Holds
 * only what tool descriptions can't: what the server is for, cross-tool rules,
 * errors to hand back to the user, routing, and volume limits. Definitions live
 * in the docs (`search_docs`).
 */
export const MCP_SERVER_INSTRUCTIONS = `
Data Hub collects, processes, and groups lab instrument files into runs, and
tracks who ran what. A watcher is the program on each instrument PC that
uploads files.

How-to questions about Data Hub (setup, watchers, tokens, permissions):
search_docs, then read_doc on the best match; link the page. What changed, or
when: search_changelog; link the entries. Leave out its query to list changes
by date.

Writes act as the signed-in user and need the write scope; on "Token is missing
required scope: write", ask the user to re-authorize instead of retrying.
Confirm before delete_files, restore_files, deleting a run, comment or lab
notebook, dismissing, unclaiming, reprocessing, cancelling queued files, or
changing a watcher's config.

"Structured content does not match the tool's output schema" means your tool
list is out of date: ask the user to reconnect Data Hub in their client (or
start a new session), then retry. Send feedback only if it still fails.

dateFrom/dateTo are inclusive UTC days, matched on a run's acquired time
(created time if missing). Dashboard counts use the viewer's timezone, so they
can differ.

Stalled runs: reprocess_run. Not-uploaded runs: request_run_upload_all (needs
an online or restarting watcher). Upload-failed files: read errorMessage
(list_run_files), fix it on the instrument PC (often a renamed folder), then
request again.

Tool routing:
- global_search for filenames, instrument names, users, or comments.
- Lab notebook name or link: list_lab_notebooks, then search_runs labNotebookId.
- search_runs for date, status, or metadata filters (values:
  get_instrument_filter_options); ranBy="me" for my runs.
- get_run_report for results; get_run is metadata only.
- Watchers: list_watchers → get_watcher_heartbeats → list_watcher_events.
- Large runs: filter list_run_files by status; use get_run_report's sample, not
  full CSVs.

send_feedback is for bugs and requests about ${FEEDBACK_APP.appName}; show the
user the draft first. ${FEEDBACK_APP.mcpGuidance}
`.trim();
