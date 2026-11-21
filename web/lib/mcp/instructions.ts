import { FEEDBACK_APP } from "@/lib/feedback-app";

/**
 * Sent to every client at initialize. Claude Code keeps only the first 2 KB, so
 * a unit test caps the length and the most important points come first. Holds
 * only what tool descriptions can't: what the server is for, cross-tool rules,
 * routing, and volume limits. Definitions live in the docs (`search_docs`).
 */
export const MCP_SERVER_INSTRUCTIONS = `
Data Hub collects files from lab instruments, processes them, and groups them
into runs. This server covers instruments, runs, files, watchers (the program
on each instrument PC that uploads files), who ran what, and Data Hub's docs.

How-to questions about Data Hub itself (setup, watchers, tokens, permissions):
call search_docs, then read_doc on the best match, and link the page in your
answer. Questions about what changed, or when: call search_changelog and link
the entries. Leave out its query to list changes by date.

Writes act as the signed-in user and need the write scope, or fail with
"Token is missing required scope: write"; ask the user to re-authorize
instead of retrying. Confirm before delete_files, restore_files, deleting a run,
comment or lab notebook, dismissing, unclaiming, reprocessing, cancelling
queued files, or changing a watcher's config.

Dates: dateFrom/dateTo are inclusive UTC days, matched on a run's acquired
time (its created time when missing). The dashboard uses the viewer's
timezone, so its daily counts can differ.

Stalled runs recover with reprocess_run. Not-uploaded runs need
request_run_upload_all and a watcher that is online or restarting.
Upload-failed files say why in errorMessage (list_run_files); fix that on
the instrument PC (often a renamed folder) before requesting them again.

Tool routing:
- global_search for filenames, instrument names, users, or comments.
- Lab notebooks: list_lab_notebooks by name or link, then search_runs
  labNotebookId.
- search_runs for date, status, or metadata filters; ranBy="me" for my runs.
- Metadata filter values: get_instrument_filter_options.
- get_run_report for results; get_run is metadata only.
- Watchers: list_watchers → get_watcher_heartbeats → list_watcher_events.
- Large runs: filter list_run_files by status, and prefer get_run_report's
  sample over full CSVs.

Feedback: send_feedback for bugs and requests about ${FEEDBACK_APP.appName}
(show the user the draft first). ${FEEDBACK_APP.mcpGuidance}
`.trim();
