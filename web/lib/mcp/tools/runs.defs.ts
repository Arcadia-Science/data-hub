import { z } from "zod";
import { mcpMetadataFilterInputSchema } from "@/lib/api/run-metadata-filters";
import { fileStatusEnum } from "@/lib/db/schema";
import type { McpToolDef } from "@/lib/mcp/catalog/types";
import { runReportToolUiMeta } from "@/lib/mcp/ui-apps";
import { RUN_STATUS_VALUES } from "@/lib/runs/run-status";
import {
  addRunCommentOutputSchema,
  claimRunOutputSchema,
  claimRunsOutputSchema,
  deleteRunCommentOutputSchema,
  deleteRunOutputSchema,
  editRunCommentOutputSchema,
  getRunOutputSchema,
  getRunReportOutputSchema,
  listRunAttributorsOutputSchema,
  listRunCommentsOutputSchema,
  listRunFilesOutputSchema,
  reprocessRunOutputSchema,
  requestRunUploadAllOutputSchema,
  requestRunUploadOutputSchema,
  restoreRunOutputSchema,
  searchRunsOutputSchema,
  unclaimRunOutputSchema,
} from "./runs.output";

export const searchRunsTool = {
  name: "search_runs",
  group: "runs",
  scope: "runs:read",
  title: "Search Runs",
  description:
    "Search instrument runs with filtering, pagination, and sorting. Supports run status filters and instrument-metadata filters (plate reader, gel-doc, qPCR, Hina microscope, Epson scanner, Aunty). Prefer global_search when the query may match filenames, instrument names, or attributor names rather than run IDs. Discover valid metadata filter values via get_instrument_filter_options or datahub://instruments/{id}/filter-options.",
  outputSchema: searchRunsOutputSchema,
  inputSchema: {
    instrumentId: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe("Filter to one or more instrument IDs"),
    source: z
      .enum(["lambda", "watcher"])
      .optional()
      .describe("Filter by run source"),
    search: z
      .string()
      .optional()
      .describe("Search text matched against run ID only"),
    dateFrom: z
      .string()
      .optional()
      .describe(
        "Start date (inclusive, YYYY-MM-DD). Day boundary is UTC, not the viewer's timezone."
      ),
    dateTo: z
      .string()
      .optional()
      .describe(
        "End date (inclusive, YYYY-MM-DD). Day boundary is UTC, not the viewer's timezone."
      ),
    sort: z
      .enum(["acquired_at", "created_at", "updated_at"])
      .optional()
      .describe(
        "Sort field (default: acquired_at — when the run actually happened on the instrument PC, falling back to created_at)"
      ),
    order: z
      .enum(["asc", "desc"])
      .optional()
      .describe("Sort order (default: desc)"),
    page: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Page number (default: 1)"),
    perPage: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Results per page (default: 20, max: 100)"),
    includeDeleted: z
      .boolean()
      .optional()
      .describe("Include soft-deleted runs (default: false)"),
    ...mcpMetadataFilterInputSchema,
    ranBy: z
      .string()
      .optional()
      .describe(
        'Filter by attributor. Pass a user id, the literal "me" for the authenticated token owner, or "unattributed" for runs with no attributions. Use get_me for your user id, or list_run_attributors to discover colleagues.'
      ),
    status: z
      .array(z.enum(RUN_STATUS_VALUES))
      .optional()
      .describe(
        "Filter by derived run status (OR'd together). Status is derived from a run's raw file states, priority-exclusive: failed (any file failed), stalled (a file has been in processing past the stall window and can be reprocessed), pending (files awaiting upload), uploaded, processing (in flight), completed (all done), empty (no files)."
      ),
  },
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const getRunTool = {
  name: "get_run",
  group: "runs",
  scope: "runs:read",
  title: "Get Run",
  description:
    "Get details for a specific instrument run by its natural key (instrument ID + run ID). Returns metadata, timestamps, instrument info, and attributions by default. Pass include to attach the first page of files, comments, and/or a failure_summary without extra tool calls. To show the interactive report (plate maps, spectra, images) or a bounded processed-CSV sample, call get_run_report for the same run.",
  outputSchema: getRunOutputSchema,
  inputSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    runId: z.string().describe("Run identifier within the instrument"),
    include: z
      .array(z.enum(["files", "comments", "attributions", "failure_summary"]))
      .optional()
      .describe(
        'Optional extras. "attributions" is accepted but redundant — attributions are always included. "files" returns the first page (50) via list_run_files shape.'
      ),
  },
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const getRunReportTool = {
  name: "get_run_report",
  group: "runs",
  scope: "files:read",
  title: "Get Run Report",
  description:
    "Return an analysis-ready summary for a run: file counts, failure summary, image/report file refs, and a bounded processed-CSV sample (columns + first rows). Prefer this over downloading full CSVs when comparing or summarizing experimental results. Hosts that support MCP Apps render the interactive report View when this tool is called.",
  outputSchema: getRunReportOutputSchema,
  inputSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    runId: z.string().describe("Run identifier within the instrument"),
  },
  annotations: { readOnlyHint: true },
  _meta: runReportToolUiMeta(["model", "app"]),
} as const satisfies McpToolDef;

export const listRunFilesTool = {
  name: "list_run_files",
  group: "runs",
  scope: "runs:read",
  title: "List Run Files",
  description:
    "List files associated with a run (raw uploads and processed artifacts) with their status, category, and size. Paginated — runs can have thousands of files. Filter by status to gather fileIds for request_run_upload (e.g. status=['detected']). Use get_file for full per-file detail including metadata and S3 location.",
  outputSchema: listRunFilesOutputSchema,
  inputSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    runId: z.string().describe("Run identifier within the instrument"),
    status: z
      .array(z.enum(fileStatusEnum.enumValues))
      .optional()
      .describe(
        "Filter to one or more file statuses (OR'd). Omit to return all statuses."
      ),
    page: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Page number (default: 1)"),
    perPage: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Results per page (default: 50, max: 100)"),
  },
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const claimRunTool = {
  name: "claim_run",
  group: "attribution",
  scope: "runs:attribute",
  title: "Claim Run",
  description:
    "Mark a run as performed by the authenticated user. Idempotent — claiming a run you already claimed is a no-op. Only self-attribution is supported; you cannot claim a run on behalf of another user. Prefer claim_runs when attributing multiple runs.",
  outputSchema: claimRunOutputSchema,
  inputSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    runId: z.string().describe("Run identifier within the instrument"),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
} as const satisfies McpToolDef;

export const claimRunsTool = {
  name: "claim_runs",
  group: "attribution",
  scope: "runs:attribute",
  title: "Claim Runs",
  description:
    "Mark multiple runs on one instrument as performed by the authenticated user (max 100). Idempotent per run. Returns claimed runs and any runIds that were not found; a missing ID does not fail the whole batch. Only self-attribution is supported.",
  outputSchema: claimRunsOutputSchema,
  inputSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    runIds: z
      .array(z.string())
      .min(1)
      .max(100)
      .describe("Run identifiers within the instrument (1–100)"),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
} as const satisfies McpToolDef;

export const unclaimRunTool = {
  name: "unclaim_run",
  group: "attribution",
  scope: "runs:attribute",
  title: "Unclaim Run",
  description:
    "Remove the authenticated user's attribution from a run. Idempotent — unclaiming a run you don't currently claim is a no-op. Only self-attribution is supported; you cannot remove another user's attribution.",
  outputSchema: unclaimRunOutputSchema,
  inputSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    runId: z.string().describe("Run identifier within the instrument"),
  },
  // destructiveHint because removing an attribution is user-visible across
  // dashboards and the runs table; clients should confirm before calling.
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
} as const satisfies McpToolDef;

export const listRunAttributorsTool = {
  name: "list_run_attributors",
  group: "attribution",
  scope: "runs:read",
  title: "List Run Attributors",
  description:
    "List distinct users who have claimed at least one run on a given instrument. Use the returned userId with search_runs ranBy=<userId>.",
  outputSchema: listRunAttributorsOutputSchema,
  inputSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
  },
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const listRunCommentsTool = {
  name: "list_run_comments",
  group: "comments",
  scope: "runs:read",
  title: "List Run Comments",
  description:
    "List comments on a run (oldest first), including author display info.",
  inputSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    runId: z.string().describe("Run identifier within the instrument"),
  },
  outputSchema: listRunCommentsOutputSchema,
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const addRunCommentTool = {
  name: "add_run_comment",
  group: "comments",
  scope: "runs:comment",
  title: "Add Run Comment",
  description:
    "Add a comment on a run as the authenticated user. Author is taken from the token — you cannot comment as another user.",
  inputSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    runId: z.string().describe("Run identifier within the instrument"),
    body: z.string().describe("Markdown comment body"),
  },
  outputSchema: addRunCommentOutputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false },
} as const satisfies McpToolDef;

export const editRunCommentTool = {
  name: "edit_run_comment",
  group: "comments",
  scope: "runs:comment",
  title: "Edit Run Comment",
  description:
    "Edit one of your own comments. Returns an error if the comment is missing or authored by someone else.",
  inputSchema: {
    commentId: z.string().describe("Comment UUID"),
    body: z.string().describe("Updated markdown body"),
  },
  outputSchema: editRunCommentOutputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false },
} as const satisfies McpToolDef;

export const deleteRunCommentTool = {
  name: "delete_run_comment",
  group: "comments",
  scope: "runs:comment",
  title: "Delete Run Comment",
  description:
    "Soft-delete one of your own comments. Idempotent if already deleted.",
  inputSchema: {
    commentId: z.string().describe("Comment UUID"),
  },
  outputSchema: deleteRunCommentOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
} as const satisfies McpToolDef;

export const reprocessRunTool = {
  name: "reprocess_run",
  group: "runs",
  scope: "runs:reprocess",
  title: "Reprocess Run",
  description:
    "Re-run Lambda processing for every uploaded, completed, failed, or stalled raw file on a run. Processed artifacts are skipped. The instrument must have a Lambda processor. Prefer this over looping reprocess_file for bulk retries after a parser fix, to kick stuck uploads, or to recover files that never reported back from processing.",
  inputSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    runId: z.string().describe("Run identifier within the instrument"),
  },
  outputSchema: reprocessRunOutputSchema,
  // destructiveHint mirrors reprocess_file: this overwrites processed
  // artifacts and resets per-file status in bulk, so clients should
  // confirm even though no data is deleted.
  annotations: { readOnlyHint: false, destructiveHint: true },
} as const satisfies McpToolDef;

export const deleteRunTool = {
  name: "delete_run",
  group: "runs",
  scope: "runs:delete",
  title: "Delete Run",
  description:
    "Soft-delete a run (sets deleted_at). Does not remove files or S3 objects. Use restore_run to undo. Idempotent: deleting an already-deleted run succeeds as a no-op.",
  inputSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    runId: z.string().describe("Run identifier within the instrument"),
  },
  outputSchema: deleteRunOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
} as const satisfies McpToolDef;

export const restoreRunTool = {
  name: "restore_run",
  group: "runs",
  scope: "runs:delete",
  title: "Restore Run",
  description:
    "Restore a soft-deleted run by clearing deleted_at. Idempotent: restoring a run that is not deleted succeeds as a no-op.",
  inputSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    runId: z.string().describe("Run identifier within the instrument"),
  },
  outputSchema: restoreRunOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
} as const satisfies McpToolDef;

export const requestRunUploadTool = {
  name: "request_run_upload",
  group: "runs",
  scope: "runs:upload",
  title: "Request Run Upload",
  description:
    "Queue specific detected files for watcher upload (max 100). Requires an online watcher. Idempotent for files already in upload_requested.",
  inputSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    runId: z.string().describe("Run identifier within the instrument"),
    fileIds: z
      .array(z.number().int())
      .min(1)
      .max(100)
      .describe("Numeric file IDs to queue"),
  },
  outputSchema: requestRunUploadOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
} as const satisfies McpToolDef;

export const requestRunUploadAllTool = {
  name: "request_run_upload_all",
  group: "runs",
  scope: "runs:upload",
  title: "Request Run Upload All",
  description:
    "Queue every detected file on a run for watcher upload. Requires an online watcher.",
  inputSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    runId: z.string().describe("Run identifier within the instrument"),
  },
  outputSchema: requestRunUploadAllOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
} as const satisfies McpToolDef;

export const RUN_TOOL_DEFS = [
  searchRunsTool,
  getRunTool,
  getRunReportTool,
  listRunFilesTool,
  claimRunTool,
  claimRunsTool,
  unclaimRunTool,
  listRunAttributorsTool,
  listRunCommentsTool,
  addRunCommentTool,
  editRunCommentTool,
  deleteRunCommentTool,
  reprocessRunTool,
  deleteRunTool,
  restoreRunTool,
  requestRunUploadTool,
  requestRunUploadAllTool,
] as const;
