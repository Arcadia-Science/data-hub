import { VALID_INSTRUMENT_TYPES } from "@/lib/db/schema";
import { RUN_STATUS_META, RUN_STATUS_VALUES } from "@/lib/runs/run-status";

// Static reference for MCP clients — attach via `datahub://glossary`.
export const DATAHUB_GLOSSARY = {
  runStatus: {
    derivation:
      "Derived from a run's raw file states, priority-exclusive: failed (any file failed processing) > stalled (a file has been in processing past the stall window, so it can be reprocessed) > upload_failed (the watcher gave up on a file; its errorMessage says why) > waiting_upload (a file was requested, or the watcher will upload it on its own) > uploaded > queued (reprocessing files waiting for a free processing slot) > processing (in flight, inside the stall window) > not_uploaded (a file is only on the instrument PC and nothing will upload it until someone requests it) > completed (all done) > empty (no files). The old `pending` still works as a filter and means waiting_upload or not_uploaded.",
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
