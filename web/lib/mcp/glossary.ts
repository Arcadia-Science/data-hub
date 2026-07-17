import { VALID_INSTRUMENT_TYPES } from "@/lib/db/schema";
import { RUN_STATUS_META, RUN_STATUS_VALUES } from "@/lib/runs/run-status";

// Static reference for MCP clients — attach via `datahub://glossary` without a tool call.
export const DATAHUB_GLOSSARY = {
  runStatus: {
    derivation:
      "Derived from a run's raw file states, priority-exclusive: failed (any file failed) > pending (detected/upload_requested) > uploaded > processing > completed (all done) > empty (no files).",
    values: RUN_STATUS_VALUES.map((value) => ({
      value,
      label: RUN_STATUS_META[value].label,
      description: RUN_STATUS_META[value].description,
    })),
  },
  instrumentTypes: [...VALID_INSTRUMENT_TYPES],
  ranBy: {
    me: "Resolves to the authenticated PAT owner (same as get_me.id).",
    unattributed: "Runs with no claim attributions.",
    userId: "Concrete user UUID from list_run_attributors or get_me.",
  },
  archivePolling:
    "get_run_archive may return { status: 'building', retryAfterSeconds }. Call again after the wait until status is 'ready'.",
  toolRouting: {
    vagueDiscovery:
      "Prefer global_search when the query may match filenames, instrument names, user names/emails, or comment bodies (users scope is workspace-wide under runs:read). Prefer search_runs for structured filters (date, status, metadata).",
    myRuns: 'search_runs with ranBy="me", or get_me then ranBy=<id>.',
    experimentalResults:
      "Prefer get_run_report for bounded CSV samples and failure summaries over downloading full files.",
    filterEnums:
      "Read datahub://instruments/{instrumentId}/filter-options before setting metadata filters on search_runs.",
    watcherDiagnosis:
      "list_watchers → get_watcher_heartbeats → list_watcher_events for unhealthy agents.",
  },
} as const;
