import { VALID_INSTRUMENT_TYPES } from "@/lib/db/schema";
import { RUN_STATUS_META, RUN_STATUS_VALUES } from "@/lib/runs/run-status";

// Static reference for MCP clients — attach via `datahub://glossary`.
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
    me: "Resolves to the authenticated user (same as get_me.id).",
    unattributed: "Runs with no claim attributions.",
    userId: "Concrete user UUID from list_run_attributors or get_me.",
  },
  dates:
    "dateFrom/dateTo are inclusive UTC calendar days matched against coalesce(acquired_at, created_at). The web dashboard computes “today” in the viewer's timezone, so daily counts can differ.",
  archivePolling:
    "get_run_archive may return { status: 'building', retryAfterSeconds }. Call again after the wait until status is 'ready'.",
} as const;
