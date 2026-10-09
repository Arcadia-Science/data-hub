import { FEEDBACK_APP } from "@/lib/feedback-app";

/**
 * Delivered to every MCP client at initialize, so it works without resources
 * or prompts. Claude Code keeps only the first 2 KB, which is why a unit test
 * caps the length and the most important points come first.
 *
 * Scoped to what tool descriptions cannot carry on their own: what the server
 * is for, cross-tool constraints, routing, and volume limits. Run status and
 * date definitions are in the docs (`search_docs`) and `datahub://glossary`.
 */
export const MCP_SERVER_INSTRUCTIONS = `
Data Hub collects files from lab instruments, processes them, and groups them
into runs. This server covers instruments, runs, files, watchers (the program
on each instrument PC that uploads files), who ran what, and Data Hub's own
documentation.

How-to questions about Data Hub itself (setup, watchers, tokens, permissions,
recent changes): call search_docs, then read_doc on the best match, and link
the page in your answer.

Writes need the write scope and otherwise fail with "Token is missing required
scope: write"; ask the user to re-authorize instead of retrying. Confirm before
deleting, dismissing, unclaiming, or reprocessing. Claims and comments always
act as the signed-in user.

Dates: dateFrom/dateTo are inclusive UTC days, matched on a run's acquired
time, or its created time when that is missing. The dashboard uses the
viewer's timezone, so its daily counts can differ.

Stalled runs recover with reprocess_run. Pending runs need
request_run_upload_all and an online watcher.

Tool routing:
- global_search for filenames, instrument names, users, or comments.
- search_runs for date, status, or metadata filters; ranBy="me" for my runs.
- Metadata filter values: get_instrument_filter_options.
- get_run_report for results; get_run is metadata only.
- Watchers: list_watchers → get_watcher_heartbeats → list_watcher_events.
- Large runs: filter list_run_files by status, and prefer get_run_report's
  sample over full CSVs.

Feedback: send_feedback for bugs and requests about ${FEEDBACK_APP.appName}
(show the user the draft first). ${FEEDBACK_APP.mcpGuidance}
`.trim();
