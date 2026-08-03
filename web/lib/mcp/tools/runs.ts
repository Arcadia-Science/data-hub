import type { McpServer } from "@modelcontextprotocol/server";
import { and, eq } from "drizzle-orm";
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
import { pickMetadataFilterArgs } from "@/lib/api/run-metadata-filters";
import { buildRunReport, getRunFailureSummary } from "@/lib/api/run-reports";
import { requestAllRunUploads, requestRunUploads } from "@/lib/api/run-uploads";
import { db } from "@/lib/db";
import { runAttributions } from "@/lib/db/schema";
import { toolRegistrationConfig } from "@/lib/mcp/catalog/register";
import {
  errorResult,
  getMcpUserId,
  requireMcpWrite,
  resolveAttributionTarget,
  textResult,
  toMcpFile,
} from "@/lib/mcp/tools/helpers";
import { validateSearchRunsMetadataFilters } from "@/lib/mcp/validate-run-filters";
import {
  addRunCommentTool,
  claimRunTool,
  deleteRunCommentTool,
  deleteRunTool,
  editRunCommentTool,
  getRunReportTool,
  getRunTool,
  listRunAttributorsTool,
  listRunCommentsTool,
  listRunFilesTool,
  reprocessRunTool,
  requestRunUploadAllTool,
  requestRunUploadTool,
  restoreRunTool,
  searchRunsTool,
  unclaimRunTool,
} from "./runs.defs";

// Sentinel for `search_runs.ranBy`: resolve to the authenticated user.
const RAN_BY_ME_SENTINEL = "me";

export function registerRunTools(server: McpServer) {
  server.registerTool(
    searchRunsTool.name,
    toolRegistrationConfig(searchRunsTool),
    async (args, ctx) => {
      const authInfo = ctx.http?.authInfo;

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
    getRunTool.name,
    toolRegistrationConfig(getRunTool),
    async ({ instrumentId, runId, include }) => {
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
    getRunReportTool.name,
    toolRegistrationConfig(getRunReportTool),
    async ({ instrumentId, runId }) => {
      const result = await buildRunReport(instrumentId, runId);
      if (!result.ok) {
        return errorResult(result.message);
      }
      return textResult(result);
    }
  );

  server.registerTool(
    listRunFilesTool.name,
    toolRegistrationConfig(listRunFilesTool),
    async ({ instrumentId, runId, page, perPage }) => {
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
    claimRunTool.name,
    toolRegistrationConfig(claimRunTool),
    async ({ instrumentId, runId }, ctx) => {
      const authInfo = ctx.http?.authInfo;
      const writeError = requireMcpWrite(authInfo);
      if (writeError) {
        return writeError;
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
    unclaimRunTool.name,
    toolRegistrationConfig(unclaimRunTool),
    async ({ instrumentId, runId }, ctx) => {
      const authInfo = ctx.http?.authInfo;
      const writeError = requireMcpWrite(authInfo);
      if (writeError) {
        return writeError;
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
    listRunAttributorsTool.name,
    toolRegistrationConfig(listRunAttributorsTool),
    async ({ instrumentId }) => {
      const attributors = await getRanByFilterOptions(instrumentId);
      return textResult(attributors);
    }
  );

  server.registerTool(
    listRunCommentsTool.name,
    toolRegistrationConfig(listRunCommentsTool),
    async ({ instrumentId, runId }) => {
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
    addRunCommentTool.name,
    toolRegistrationConfig(addRunCommentTool),
    async ({ instrumentId, runId, body }, ctx) => {
      const authInfo = ctx.http?.authInfo;
      const writeError = requireMcpWrite(authInfo);
      if (writeError) {
        return writeError;
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
    editRunCommentTool.name,
    toolRegistrationConfig(editRunCommentTool),
    async ({ commentId, body }, ctx) => {
      const authInfo = ctx.http?.authInfo;
      const writeError = requireMcpWrite(authInfo);
      if (writeError) {
        return writeError;
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
    deleteRunCommentTool.name,
    toolRegistrationConfig(deleteRunCommentTool),
    async ({ commentId }, ctx) => {
      const authInfo = ctx.http?.authInfo;
      const writeError = requireMcpWrite(authInfo);
      if (writeError) {
        return writeError;
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
    reprocessRunTool.name,
    toolRegistrationConfig(reprocessRunTool),
    async ({ instrumentId, runId }, ctx) => {
      const writeError = requireMcpWrite(ctx.http?.authInfo);
      if (writeError) {
        return writeError;
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
    deleteRunTool.name,
    toolRegistrationConfig(deleteRunTool),
    async ({ instrumentId, runId }, ctx) => {
      const authInfo = ctx.http?.authInfo;
      const writeError = requireMcpWrite(authInfo);
      if (writeError) {
        return writeError;
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
    restoreRunTool.name,
    toolRegistrationConfig(restoreRunTool),
    async ({ instrumentId, runId }, ctx) => {
      const writeError = requireMcpWrite(ctx.http?.authInfo);
      if (writeError) {
        return writeError;
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
    requestRunUploadTool.name,
    toolRegistrationConfig(requestRunUploadTool),
    async ({ instrumentId, runId, fileIds }, ctx) => {
      const writeError = requireMcpWrite(ctx.http?.authInfo);
      if (writeError) {
        return writeError;
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
    requestRunUploadAllTool.name,
    toolRegistrationConfig(requestRunUploadAllTool),
    async ({ instrumentId, runId }, ctx) => {
      const writeError = requireMcpWrite(ctx.http?.authInfo);
      if (writeError) {
        return writeError;
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
