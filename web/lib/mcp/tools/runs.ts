import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { reprocessRun } from "@/lib/api/file-reprocessing";
import {
  buildRunListQuery,
  getAttributionsByRunIds,
  getRanByFilterOptions,
  getRunFilesPage,
  lookupRunByNaturalKey,
} from "@/lib/api/instrument-runs";
import {
  createCommentAndNotify,
  getCommentForAuthorCheck,
  getCommentForDeleteAuthorCheck,
  listCommentsForRun,
  softDeleteComment,
  updateComment,
  validateCommentBody,
} from "@/lib/api/run-comments";
import { restoreRun, softDeleteRun } from "@/lib/api/run-lifecycle";
import {
  mcpMetadataFilterInputSchema,
  pickMetadataFilterArgs,
} from "@/lib/api/run-metadata-filters";
import { buildRunReport, getRunFailureSummary } from "@/lib/api/run-reports";
import { requestAllRunUploads, requestRunUploads } from "@/lib/api/run-uploads";
import { db } from "@/lib/db";
import { runAttributions } from "@/lib/db/schema";
import {
  errorResult,
  getMcpUserId,
  requireMcpScope,
  resolveAttributionTarget,
  textResult,
  toMcpFile,
} from "@/lib/mcp/tools/helpers";
import { validateSearchRunsMetadataFilters } from "@/lib/mcp/validate-run-filters";
import { RUN_STATUS_VALUES } from "@/lib/runs/run-status";

// Sentinel for `search_runs.ranBy`: resolve to the authenticated PAT owner.
const RAN_BY_ME_SENTINEL = "me";

export function registerRunTools(server: McpServer) {
  server.registerTool(
    "search_runs",
    {
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
        dateTo: z
          .string()
          .optional()
          .describe("End date (inclusive, YYYY-MM-DD)"),
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
    },
    async (args, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "runs:read");
      if (scopeError) {
        return scopeError;
      }

      let ranBy = args.ranBy;
      if (ranBy === RAN_BY_ME_SENTINEL) {
        const userId = getMcpUserId(authInfo);
        if (!userId) {
          return errorResult(
            'ranBy="me" requires an authenticated user on this session. Use get_me to confirm identity, or pass a concrete user id.'
          );
        }
        ranBy = userId;
      }

      const metadataFilters = pickMetadataFilterArgs(args);
      const singleInstrumentId =
        typeof args.instrumentId === "string" ? args.instrumentId : undefined;
      if (singleInstrumentId) {
        const filterError = await validateSearchRunsMetadataFilters(
          singleInstrumentId,
          metadataFilters
        );
        if (filterError) {
          return errorResult(filterError);
        }
      }

      const result = await buildRunListQuery({
        instrumentId: args.instrumentId,
        source: args.source,
        search: args.search,
        dateFrom: args.dateFrom,
        dateTo: args.dateTo,
        sort: args.sort,
        order: args.order,
        page: args.page ?? 1,
        perPage: args.perPage ?? 20,
        includeDeleted: args.includeDeleted ?? false,
        ...metadataFilters,
        ranBy,
        statuses: args.status,
      });
      return textResult(result);
    }
  );

  server.registerTool(
    "get_run",
    {
      title: "Get Run",
      description:
        "Get details for a specific instrument run by its natural key (instrument ID + run ID). Returns metadata, timestamps, instrument info, and attributions by default. Pass include to attach the first page of files, comments, and/or a failure_summary without extra tool calls. For processed measurement samples prefer get_run_report.",
      inputSchema: {
        instrumentId: z.string().describe("Instrument identifier"),
        runId: z.string().describe("Run identifier within the instrument"),
        include: z
          .array(
            z.enum(["files", "comments", "attributions", "failure_summary"])
          )
          .optional()
          .describe(
            'Optional extras. "attributions" is accepted but redundant — attributions are always included. "files" returns the first page (50) via list_run_files shape.'
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ instrumentId, runId, include }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "runs:read");
      if (scopeError) {
        return scopeError;
      }
      const run = await lookupRunByNaturalKey(instrumentId, runId);
      if (!run) {
        return errorResult(
          `Run '${runId}' not found for instrument '${instrumentId}'.`
        );
      }

      const extras = new Set(include ?? []);
      const payload: Record<string, unknown> = { ...run };

      const tasks: Promise<void>[] = [];
      if (extras.has("files")) {
        tasks.push(
          getRunFilesPage(run.id, { page: 1, perPage: 50 }).then(
            ({ data, pagination }) => {
              payload.files = data.map(toMcpFile);
              payload.filesPagination = pagination;
            }
          )
        );
      }
      if (extras.has("comments")) {
        tasks.push(
          listCommentsForRun(run.id).then((comments) => {
            payload.comments = comments;
          })
        );
      }
      if (extras.has("failure_summary")) {
        tasks.push(
          getRunFailureSummary(run.id).then((failureSummary) => {
            payload.failureSummary = failureSummary;
          })
        );
      }
      if (tasks.length > 0) {
        await Promise.all(tasks);
      }

      return textResult(payload);
    }
  );

  server.registerTool(
    "get_run_report",
    {
      title: "Get Run Report",
      description:
        "Return an analysis-ready summary for a run: file counts, failure summary, image/report file refs, and a bounded processed-CSV sample (columns + first rows). Prefer this over downloading full CSVs when comparing or summarizing experimental results.",
      inputSchema: {
        instrumentId: z.string().describe("Instrument identifier"),
        runId: z.string().describe("Run identifier within the instrument"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ instrumentId, runId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "files:read");
      if (scopeError) {
        return scopeError;
      }
      const result = await buildRunReport(instrumentId, runId);
      if (!result.ok) {
        return errorResult(result.message);
      }
      return textResult(result);
    }
  );

  server.registerTool(
    "list_run_files",
    {
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
    },
    async ({ instrumentId, runId, page, perPage }, { authInfo }) => {
      // The tool is keyed by run and the result is "what files belong to
      // this run", which lives under the runs domain in the REST API too
      // (`GET /instruments/:id/runs/:runId` returns files alongside the
      // run). One scope (`runs:read`) covers both.
      const scopeError = requireMcpScope(authInfo, "runs:read");
      if (scopeError) {
        return scopeError;
      }
      const run = await lookupRunByNaturalKey(instrumentId, runId);
      if (!run) {
        return errorResult(
          `Run '${runId}' not found for instrument '${instrumentId}'.`
        );
      }
      const { data, pagination } = await getRunFilesPage(run.id, {
        page: page ?? 1,
        perPage: perPage ?? 50,
      });
      return textResult({ data: data.map(toMcpFile), pagination });
    }
  );

  server.registerTool(
    "claim_run",
    {
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
    },
    async ({ instrumentId, runId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "runs:attribute");
      if (scopeError) {
        return scopeError;
      }
      const resolved = await resolveAttributionTarget(
        authInfo,
        instrumentId,
        runId
      );
      if (!resolved.ok) {
        return resolved.error;
      }

      await db
        .insert(runAttributions)
        .values({ runId: resolved.runUuid, userId: resolved.userId })
        .onConflictDoNothing();

      const byRun = await getAttributionsByRunIds([resolved.runUuid]);
      return textResult({
        instrumentId,
        runId,
        attributions: byRun.get(resolved.runUuid) ?? [],
      });
    }
  );

  server.registerTool(
    "unclaim_run",
    {
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
    },
    async ({ instrumentId, runId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "runs:attribute");
      if (scopeError) {
        return scopeError;
      }
      const resolved = await resolveAttributionTarget(
        authInfo,
        instrumentId,
        runId
      );
      if (!resolved.ok) {
        return resolved.error;
      }

      await db
        .delete(runAttributions)
        .where(
          and(
            eq(runAttributions.runId, resolved.runUuid),
            eq(runAttributions.userId, resolved.userId)
          )
        );

      const byRun = await getAttributionsByRunIds([resolved.runUuid]);
      return textResult({
        instrumentId,
        runId,
        attributions: byRun.get(resolved.runUuid) ?? [],
      });
    }
  );

  server.registerTool(
    "list_run_attributors",
    {
      title: "List Run Attributors",
      description:
        "List distinct users who have claimed at least one run on a given instrument. Use the returned userId with search_runs ranBy=<userId>.",
      inputSchema: {
        instrumentId: z.string().describe("Instrument identifier"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ instrumentId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "runs:read");
      if (scopeError) {
        return scopeError;
      }
      const attributors = await getRanByFilterOptions(instrumentId);
      return textResult(attributors);
    }
  );

  server.registerTool(
    "list_run_comments",
    {
      title: "List Run Comments",
      description:
        "List comments on a run (oldest first), including author display info.",
      inputSchema: {
        instrumentId: z.string().describe("Instrument identifier"),
        runId: z.string().describe("Run identifier within the instrument"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ instrumentId, runId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "runs:read");
      if (scopeError) {
        return scopeError;
      }
      const run = await lookupRunByNaturalKey(instrumentId, runId);
      if (!run) {
        return errorResult(
          `Run '${runId}' not found for instrument '${instrumentId}'.`
        );
      }
      const comments = await listCommentsForRun(run.id);
      return textResult({ comments });
    }
  );

  server.registerTool(
    "add_run_comment",
    {
      title: "Add Run Comment",
      description:
        "Add a comment on a run as the authenticated user. Author is taken from the token — you cannot comment as another user.",
      inputSchema: {
        instrumentId: z.string().describe("Instrument identifier"),
        runId: z.string().describe("Run identifier within the instrument"),
        body: z.string().describe("Markdown comment body"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ instrumentId, runId, body }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "runs:comment");
      if (scopeError) {
        return scopeError;
      }
      const userId = getMcpUserId(authInfo);
      if (!userId) {
        return errorResult("Authenticated user not available on this session.");
      }
      const validated = validateCommentBody(body);
      if (!validated.ok) {
        return errorResult(validated.message);
      }
      const run = await lookupRunByNaturalKey(instrumentId, runId);
      if (!run) {
        return errorResult(
          `Run '${runId}' not found for instrument '${instrumentId}'.`
        );
      }
      if (run.deletedAt) {
        return errorResult("Cannot comment on a soft-deleted run.");
      }

      // MCP has no request URL; use the canonical production host so Slack
      // deep links aren't pinned to a per-deployment VERCEL_URL hostname.
      const origin = process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
        : undefined;

      const comment = await createCommentAndNotify({
        runInternalId: run.id,
        userId,
        body: validated.body,
        instrumentId,
        instrumentDisplayName: run.instrumentDisplayName,
        runDisplayId: runId,
        origin,
      });

      return textResult(comment);
    }
  );

  server.registerTool(
    "edit_run_comment",
    {
      title: "Edit Run Comment",
      description:
        "Edit one of your own comments. Returns an error if the comment is missing or authored by someone else.",
      inputSchema: {
        commentId: z.string().describe("Comment UUID"),
        body: z.string().describe("Updated markdown body"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ commentId, body }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "runs:comment");
      if (scopeError) {
        return scopeError;
      }
      const userId = getMcpUserId(authInfo);
      if (!userId) {
        return errorResult("Authenticated user not available on this session.");
      }
      const validated = validateCommentBody(body);
      if (!validated.ok) {
        return errorResult(validated.message);
      }

      const existing = await getCommentForAuthorCheck(commentId);
      if (!existing) {
        return errorResult(`Comment '${commentId}' not found.`);
      }
      if (existing.userId !== userId) {
        return errorResult("You can only edit your own comments.");
      }

      const updated = await updateComment({
        commentId,
        userId,
        body: validated.body,
      });
      if (!updated) {
        return errorResult(`Comment '${commentId}' not found.`);
      }
      return textResult(updated);
    }
  );

  server.registerTool(
    "delete_run_comment",
    {
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
    },
    async ({ commentId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "runs:comment");
      if (scopeError) {
        return scopeError;
      }
      const userId = getMcpUserId(authInfo);
      if (!userId) {
        return errorResult("Authenticated user not available on this session.");
      }

      // Look up including soft-deleted rows so a repeat delete stays
      // idempotent: `softDeleteComment` no-ops when already deleted and we
      // still report success rather than a spurious "not found".
      const existing = await getCommentForDeleteAuthorCheck(commentId);
      if (!existing) {
        return errorResult(`Comment '${commentId}' not found.`);
      }
      if (existing.userId !== userId) {
        return errorResult("You can only delete your own comments.");
      }

      await softDeleteComment({ commentId, userId });
      return textResult({ id: commentId, deleted: true });
    }
  );

  server.registerTool(
    "reprocess_run",
    {
      title: "Reprocess Run",
      description:
        "Re-run Lambda processing for every completed or failed file on a run. Prefer this over looping reprocess_file for bulk retries after a parser fix.",
      inputSchema: {
        instrumentId: z.string().describe("Instrument identifier"),
        runId: z.string().describe("Run identifier within the instrument"),
      },
      // destructiveHint mirrors reprocess_file: this overwrites processed
      // artifacts and resets per-file status in bulk, so clients should
      // confirm even though no data is deleted.
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ instrumentId, runId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "runs:reprocess");
      if (scopeError) {
        return scopeError;
      }
      const result = await reprocessRun(instrumentId, runId);
      if (!result.ok) {
        return errorResult(result.message);
      }
      return textResult({
        instrumentId: result.instrumentId,
        runId: result.runId,
        filesQueued: result.filesQueued,
        filesFailed: result.filesFailed,
      });
    }
  );

  server.registerTool(
    "delete_run",
    {
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
    },
    async ({ instrumentId, runId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "runs:delete");
      if (scopeError) {
        return scopeError;
      }
      const userId = getMcpUserId(authInfo) ?? null;
      const result = await softDeleteRun({
        instrumentId,
        runId,
        deletedBy: userId,
      });
      if (!result.ok) {
        return errorResult(result.message);
      }
      return textResult({
        instrumentId: result.instrumentId,
        runId: result.runId,
        deletedAt: result.deletedAt,
        deletedBy: result.deletedBy,
        alreadyApplied: result.alreadyApplied,
      });
    }
  );

  server.registerTool(
    "restore_run",
    {
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
    },
    async ({ instrumentId, runId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "runs:delete");
      if (scopeError) {
        return scopeError;
      }
      const result = await restoreRun(instrumentId, runId);
      if (!result.ok) {
        return errorResult(result.message);
      }
      return textResult({
        instrumentId: result.instrumentId,
        runId: result.runId,
        deletedAt: result.deletedAt,
        alreadyApplied: result.alreadyApplied,
      });
    }
  );

  server.registerTool(
    "request_run_upload",
    {
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
    },
    async ({ instrumentId, runId, fileIds }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "runs:upload");
      if (scopeError) {
        return scopeError;
      }
      const result = await requestRunUploads({
        instrumentId,
        runId,
        fileIds,
      });
      if (!result.ok) {
        return errorResult(result.message);
      }
      return textResult({
        instrumentId: result.instrumentId,
        runId: result.runId,
        filesQueued: result.filesQueued,
        files: result.files,
      });
    }
  );

  server.registerTool(
    "request_run_upload_all",
    {
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
    },
    async ({ instrumentId, runId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "runs:upload");
      if (scopeError) {
        return scopeError;
      }
      const result = await requestAllRunUploads(instrumentId, runId);
      if (!result.ok) {
        return errorResult(result.message);
      }
      return textResult({
        instrumentId: result.instrumentId,
        runId: result.runId,
        filesQueued: result.filesQueued,
      });
    }
  );
}
