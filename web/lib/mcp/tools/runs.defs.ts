import { z } from "zod";
import { mcpMetadataFilterInputSchema } from "@/lib/api/run-metadata-filters";
import type { McpToolDef } from "@/lib/mcp/catalog/types";
import { RUN_STATUS_VALUES } from "@/lib/runs/run-status";

export const searchRunsTool = {
  name: "search_runs",
  group: "runs",
  scope: "runs:read",
  title: "Search Runs",
  description:
    "Search instrument runs with filtering, pagination, and sorting. Supports run status filters and instrument-metadata filters (plate reader, gel-doc, qPCR, Hina microscope, Epson scanner). Prefer global_search when the query may match filenames, instrument names, or attributor names rather than run IDs. Discover valid metadata filter values via datahub://instruments/{id}/filter-options (or datahub://glossary for routing tips).",
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
      .describe("Start date (inclusive, YYYY-MM-DD)"),
    dateTo: z.string().optional().describe("End date (inclusive, YYYY-MM-DD)"),
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
        "Filter by derived run status (OR'd together). Status is derived from a run's raw file states, priority-exclusive: failed (any file failed), pending (files awaiting upload), uploaded, processing, completed (all done), empty (no files)."
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
    "Get details for a specific instrument run by its natural key (instrument ID + run ID). Returns metadata, timestamps, instrument info, and attributions by default. Pass include to attach the first page of files, comments, and/or a failure_summary without extra tool calls. For processed measurement samples prefer get_run_report.",
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
    "Return an analysis-ready summary for a run: file counts, failure summary, image/report file refs, and a bounded processed-CSV sample (columns + first rows). Prefer this over downloading full CSVs when comparing or summarizing experimental results.",
  inputSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    runId: z.string().describe("Run identifier within the instrument"),
  },
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const listRunFilesTool = {
  name: "list_run_files",
  group: "runs",
  scope: "runs:read",
  title: "List Run Files",
  description:
    "List files associated with a run (raw uploads and processed artifacts) with their status, category, and size. Paginated — runs can have thousands of files. Use the page/perPage arguments to walk the full list, and use get_file for full per-file detail including metadata and S3 location.",
  inputSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    runId: z.string().describe("Run identifier within the instrument"),
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
    "Mark a run as performed by the authenticated user. Idempotent — claiming a run you already claimed is a no-op. Only self-attribution is supported; you cannot claim a run on behalf of another user.",
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

export const unclaimRunTool = {
  name: "unclaim_run",
  group: "attribution",
  scope: "runs:attribute",
  title: "Unclaim Run",
  description:
    "Remove the authenticated user's attribution from a run. Idempotent — unclaiming a run you don't currently claim is a no-op. Only self-attribution is supported; you cannot remove another user's attribution.",
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
    "Re-run Lambda processing for every uploaded, completed, or failed file on a run. Prefer this over looping reprocess_file for bulk retries after a parser fix or to kick stuck uploads.",
  inputSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    runId: z.string().describe("Run identifier within the instrument"),
  },
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
