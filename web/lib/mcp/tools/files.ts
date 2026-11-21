import type { McpServer } from "@modelcontextprotocol/server";
import { deleteRunFiles, restoreRunFiles } from "@/lib/api/file-batch";
import { loadTokenRefs, tokenRefFor } from "@/lib/api/file-deleters";
import { deleteFiles } from "@/lib/api/file-deletion";
import { reprocessFile } from "@/lib/api/file-reprocessing";
import { fileFailureToWire } from "@/lib/api/file-wire";
import { getFileById, lookupFileForDownload } from "@/lib/api/files";
import { prepareRunArchive } from "@/lib/api/run-archive";
import { getRunClaimStatus } from "@/lib/api/run-attributions";
import { trackArchiveDownload, trackFileDownload } from "@/lib/mcp/analytics";
import { toolRegistrationConfig } from "@/lib/mcp/catalog/register";
import {
  errorResult,
  getMcpUserId,
  requireMcpWrite,
  structuredResult,
} from "@/lib/mcp/tools/helpers";
import { isStalledProcessing } from "@/lib/runs/stalled-processing";
import {
  getPresignedDownloadUrl,
  PRESIGNED_DOWNLOAD_URL_EXPIRY_SECONDS,
} from "@/lib/s3";
import { contentTypeForDownload } from "@/lib/s3-local-mirror";
import {
  deleteFilesTool,
  dismissFileTool,
  getFileDownloadUrlTool,
  getFileTool,
  getRunArchiveTool,
  reprocessFileTool,
  restoreFilesTool,
} from "./files.defs";

// The signed-in user is the actor, taken from the session and never from the
// arguments. The in-memory test transport has none, so no actor is recorded.
function actorOf(userId: string | undefined) {
  return userId ? ({ kind: "user", userId } as const) : null;
}

export function registerFileTools(server: McpServer) {
  server.registerTool(
    getFileTool.name,
    toolRegistrationConfig(getFileTool),
    async ({ fileId }) => {
      const file = await getFileById(fileId);
      if (!file) {
        return errorResult(`File '${fileId}' not found.`);
      }
      // A deleted file is returned too, with the token that deleted it named
      // the way list_run_files names it.
      const tokens = await loadTokenRefs([file.deletedByToken]);
      return structuredResult({
        ...file,
        deletedByToken: tokenRefFor(tokens, file.deletedByToken),
        stalled: isStalledProcessing(file),
      });
    }
  );

  server.registerTool(
    getFileDownloadUrlTool.name,
    toolRegistrationConfig(getFileDownloadUrlTool),
    async ({ fileId }, ctx) => {
      const lookup = await lookupFileForDownload(fileId);
      if (!lookup.ok) {
        if (lookup.reason === "not_uploaded") {
          return errorResult(
            `File '${fileId}' has not been uploaded to S3 yet.`
          );
        }
        return errorResult(`File '${fileId}' not found.`);
      }

      const [downloadUrl, run] = await Promise.all([
        getPresignedDownloadUrl(lookup.s3Bucket, lookup.s3Key, {
          contentType: contentTypeForDownload(
            lookup.contentType,
            lookup.filename
          ),
          expiresIn: PRESIGNED_DOWNLOAD_URL_EXPIRY_SECONDS,
        }),
        getRunClaimStatus(lookup.runUuid),
      ]);
      // The run was deleted between the two lookups.
      if (!run) {
        return errorResult(`File '${fileId}' not found.`);
      }

      trackFileDownload(ctx, lookup.category);
      return structuredResult({
        fileId,
        filename: lookup.filename,
        downloadUrl,
        expiresInSeconds: PRESIGNED_DOWNLOAD_URL_EXPIRY_SECONDS,
        instrumentId: run.instrumentId,
        runId: run.runId,
        unclaimed: run.unclaimed,
      });
    }
  );

  server.registerTool(
    getRunArchiveTool.name,
    toolRegistrationConfig(getRunArchiveTool),
    async ({ instrumentId, runId }, ctx) => {
      const userId = getMcpUserId(ctx.http?.authInfo);
      const result = await prepareRunArchive({
        instrumentId,
        runId,
        actor: userId ? { kind: "user", userId } : null,
      });

      if (!result.ok) {
        return errorResult(result.message);
      }

      if (result.status === "ready") {
        trackArchiveDownload(ctx);
        return structuredResult({
          status: "ready",
          instrumentId,
          runId: result.runId,
          downloadUrl: result.downloadUrl,
          filename: result.filename,
          sizeBytes: result.sizeBytes,
          expiresInSeconds: result.expiresInSeconds,
          contentType: "application/zip",
          unclaimed: result.unclaimed,
        });
      }

      return structuredResult({
        status: "building",
        instrumentId,
        runId: result.runId,
        jobId: result.jobId,
        retryAfterSeconds: result.retryAfterSeconds,
        hint: "Call get_run_archive again after the suggested wait to retrieve the download URL.",
        unclaimed: result.unclaimed,
      });
    }
  );

  server.registerTool(
    reprocessFileTool.name,
    toolRegistrationConfig(reprocessFileTool),
    async ({ fileId }, ctx) => {
      const writeError = requireMcpWrite(ctx.http?.authInfo);
      if (writeError) {
        return writeError;
      }
      const result = await reprocessFile(fileId);
      if (!result.ok) {
        return errorResult(`[${result.code}] ${result.message}`);
      }
      return structuredResult({
        status: result.fileStatus,
        fileId: result.fileId,
      });
    }
  );

  server.registerTool(
    deleteFilesTool.name,
    toolRegistrationConfig(deleteFilesTool),
    async ({ instrumentId, runId, fileIds, includeLinked }, ctx) => {
      const authInfo = ctx.http?.authInfo;
      const writeError = requireMcpWrite(authInfo);
      if (writeError) {
        return writeError;
      }
      const result = await deleteRunFiles({
        instrumentId,
        runId,
        fileIds,
        includeLinked: includeLinked ?? false,
        actor: actorOf(getMcpUserId(authInfo)),
      });
      if (!result.ok) {
        return errorResult(`${result.message}.`);
      }
      return structuredResult({
        instrumentId: result.instrumentId,
        runId: result.runId,
        results: result.results.map((file) =>
          file.ok
            ? {
                ok: true,
                id: file.id,
                filename: file.filename,
                deletedAt: file.deletedAt,
                deletedBy: file.deletedBy,
                deletedByToken: file.deletedByToken,
                alreadyApplied: file.alreadyApplied,
              }
            : fileFailureToWire(file)
        ),
        linked: result.linked.map((file) => ({
          id: file.id,
          filename: file.filename,
          relation: file.relation,
          deletedAt: file.deletedAt,
        })),
        counts: result.counts,
      });
    }
  );

  server.registerTool(
    restoreFilesTool.name,
    toolRegistrationConfig(restoreFilesTool),
    async ({ instrumentId, runId, fileIds, includeLinked }, ctx) => {
      const authInfo = ctx.http?.authInfo;
      const writeError = requireMcpWrite(authInfo);
      if (writeError) {
        return writeError;
      }
      const result = await restoreRunFiles({
        instrumentId,
        runId,
        fileIds,
        includeLinked: includeLinked ?? false,
        actor: actorOf(getMcpUserId(authInfo)),
      });
      if (!result.ok) {
        return errorResult(`${result.message}.`);
      }
      const restoredToMcp = (file: (typeof result.results)[number]) =>
        file.ok
          ? {
              ok: true,
              id: file.id,
              filename: file.filename,
              alreadyApplied: file.alreadyApplied,
            }
          : fileFailureToWire(file);
      return structuredResult({
        instrumentId: result.instrumentId,
        runId: result.runId,
        results: result.results.map(restoredToMcp),
        linked: result.linked.map((file) => ({
          ...restoredToMcp(file),
          relation: file.relation,
        })),
        counts: result.counts,
      });
    }
  );

  // Deprecated: the same delete as `delete_files`, for one file by its ID and
  // with no linked files, which is all this tool ever did. Kept until
  // assistants have moved to `delete_files`.
  server.registerTool(
    dismissFileTool.name,
    toolRegistrationConfig(dismissFileTool),
    async ({ fileId }, ctx) => {
      const authInfo = ctx.http?.authInfo;
      const writeError = requireMcpWrite(authInfo);
      if (writeError) {
        return writeError;
      }
      const { results } = await deleteFiles(
        [fileId],
        actorOf(getMcpUserId(authInfo)),
        { includeLinked: false }
      );
      const result = results[0];
      if (!result?.ok) {
        return errorResult(result?.message ?? `File '${fileId}' not found.`);
      }
      return structuredResult({
        id: result.id,
        filename: result.filename,
        deletedAt: result.deletedAt,
        alreadyApplied: result.alreadyApplied,
      });
    }
  );
}
