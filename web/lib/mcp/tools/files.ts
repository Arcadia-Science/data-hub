import type { McpServer } from "@modelcontextprotocol/server";
import { reprocessFile } from "@/lib/api/file-reprocessing";
import {
  dismissFile,
  getActiveFileById,
  lookupFileForDownload,
} from "@/lib/api/files";
import { prepareRunArchive } from "@/lib/api/run-archive";
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
  dismissFileTool,
  getFileDownloadUrlTool,
  getFileTool,
  getRunArchiveTool,
  reprocessFileTool,
} from "./files.defs";

export function registerFileTools(server: McpServer) {
  server.registerTool(
    getFileTool.name,
    toolRegistrationConfig(getFileTool),
    async ({ fileId }) => {
      const file = await getActiveFileById(fileId);
      if (!file) {
        return errorResult(`File '${fileId}' not found.`);
      }
      return structuredResult({
        ...file,
        stalled: isStalledProcessing(file),
      });
    }
  );

  server.registerTool(
    getFileDownloadUrlTool.name,
    toolRegistrationConfig(getFileDownloadUrlTool),
    async ({ fileId }) => {
      const lookup = await lookupFileForDownload(fileId);
      if (!lookup.ok) {
        if (lookup.reason === "not_uploaded") {
          return errorResult(
            `File '${fileId}' has not been uploaded to S3 yet.`
          );
        }
        return errorResult(`File '${fileId}' not found.`);
      }

      const downloadUrl = await getPresignedDownloadUrl(
        lookup.s3Bucket,
        lookup.s3Key,
        {
          contentType: contentTypeForDownload(
            lookup.contentType,
            lookup.filename
          ),
          expiresIn: PRESIGNED_DOWNLOAD_URL_EXPIRY_SECONDS,
        }
      );

      return structuredResult({
        fileId,
        filename: lookup.filename,
        downloadUrl,
        expiresInSeconds: PRESIGNED_DOWNLOAD_URL_EXPIRY_SECONDS,
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
        return structuredResult({
          status: "ready",
          instrumentId,
          runId,
          downloadUrl: result.downloadUrl,
          filename: result.filename,
          sizeBytes: result.sizeBytes,
          expiresInSeconds: result.expiresInSeconds,
          contentType: "application/zip",
        });
      }

      return structuredResult({
        status: "building",
        instrumentId,
        runId,
        jobId: result.jobId,
        retryAfterSeconds: result.retryAfterSeconds,
        hint: "Call get_run_archive again after the suggested wait to retrieve the download URL.",
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
      return structuredResult({ status: "processing", fileId: result.fileId });
    }
  );

  server.registerTool(
    dismissFileTool.name,
    toolRegistrationConfig(dismissFileTool),
    async ({ fileId }, ctx) => {
      const writeError = requireMcpWrite(ctx.http?.authInfo);
      if (writeError) {
        return writeError;
      }
      const result = await dismissFile(fileId);
      if (!result.ok) {
        return errorResult(result.message);
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
