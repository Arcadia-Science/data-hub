import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { reprocessFile } from "@/lib/api/file-reprocessing";
import {
  dismissFile,
  getActiveFileById,
  lookupFileForDownload,
} from "@/lib/api/files";
import { prepareRunArchive } from "@/lib/api/run-archive";
import {
  errorResult,
  requireMcpScope,
  textResult,
} from "@/lib/mcp/tools/helpers";
import {
  getPresignedDownloadUrl,
  PRESIGNED_DOWNLOAD_URL_EXPIRY_SECONDS,
} from "@/lib/s3";

export function registerFileTools(server: McpServer) {
  server.registerTool(
    "get_file",
    {
      title: "Get File",
      description:
        "Get detailed metadata for a single file by its numeric ID, including status, S3 location, size, extracted metadata, and any error message.",
      inputSchema: {
        fileId: z.number().int().describe("Numeric file ID"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ fileId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "files:read");
      if (scopeError) {
        return scopeError;
      }
      const file = await getActiveFileById(fileId);
      if (!file) {
        return errorResult(`File '${fileId}' not found.`);
      }
      return textResult(file);
    }
  );

  server.registerTool(
    "get_file_download_url",
    {
      title: "Get File Download URL",
      description:
        "Get a short-lived pre-signed S3 URL to download the raw file contents. URL expires after 15 minutes.",
      inputSchema: {
        fileId: z.number().int().describe("Numeric file ID"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ fileId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "files:read");
      if (scopeError) {
        return scopeError;
      }
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
        PRESIGNED_DOWNLOAD_URL_EXPIRY_SECONDS
      );

      return textResult({
        fileId,
        filename: lookup.filename,
        downloadUrl,
        expiresInSeconds: PRESIGNED_DOWNLOAD_URL_EXPIRY_SECONDS,
      });
    }
  );

  server.registerTool(
    "get_run_archive",
    {
      title: "Get Run Archive",
      description:
        "Get a downloadable ZIP archive of every active, uploaded file in a run. " +
        "If the archive is already cached, returns a short-lived (15 min) pre-signed S3 URL the caller can fetch directly without auth — paste it into a browser or share it as a download link. " +
        "If the archive isn't cached, kicks off an async build and returns `{ status: 'building', jobId, retryAfterSeconds }`; call this tool again after the suggested wait to poll for completion. " +
        "Most archives finish in a few seconds; large runs may take a minute or two. Mirrors the REST `download-archive` route, including its dedup-by-fingerprint cache, so concurrent callers share a single Lambda invocation.",
      inputSchema: {
        instrumentId: z.string().describe("Instrument identifier"),
        runId: z.string().describe("Run identifier within the instrument"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ instrumentId, runId }, { authInfo }) => {
      // Mirror the REST archive route which is gated on `files:read`.
      const scopeError = requireMcpScope(authInfo, "files:read");
      if (scopeError) {
        return scopeError;
      }

      // Token-authenticated callers (every MCP request) don't have a
      // session user to record against `archive_jobs.created_by`, even
      // though the underlying user id is on `authInfo.extra`. Keep the
      // audit column NULL for parity with the watcher/Lambda paths and
      // to avoid a foreign-key surprise if the linked user is later
      // deleted.
      const result = await prepareRunArchive({
        instrumentId,
        runId,
        createdBy: null,
      });

      if (!result.ok) {
        return errorResult(result.message);
      }

      if (result.status === "ready") {
        return textResult({
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

      return textResult({
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
    "reprocess_file",
    {
      title: "Reprocess File",
      description:
        "Re-run the Lambda processing workflow for a failed or completed file. Transitions the file back to 'processing'. Use this to retry after a parser fix or transient Lambda failure.",
      inputSchema: {
        fileId: z.number().int().describe("Numeric file ID"),
      },
      // destructiveHint is true because the tool resets status/errorMessage/
      // processedAt. The Lambda re-processes the file, but the mutation is
      // irreversible from the tool's perspective and clients should confirm.
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ fileId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "files:reprocess");
      if (scopeError) {
        return scopeError;
      }
      const result = await reprocessFile(fileId);
      if (!result.ok) {
        return errorResult(`[${result.code}] ${result.message}`);
      }
      return textResult({ status: "processing", fileId: result.fileId });
    }
  );

  server.registerTool(
    "dismiss_file",
    {
      title: "Dismiss File",
      description:
        "Soft-delete a detected or upload_requested file (UI 'dismiss'). Uploaded files cannot be dismissed — delete the run instead. Idempotent: dismissing an already-dismissed file succeeds as a no-op.",
      inputSchema: {
        fileId: z.number().int().describe("Numeric file ID"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ fileId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "files:delete");
      if (scopeError) {
        return scopeError;
      }
      const result = await dismissFile(fileId);
      if (!result.ok) {
        return errorResult(result.message);
      }
      return textResult({
        id: result.id,
        filename: result.filename,
        deletedAt: result.deletedAt,
        alreadyApplied: result.alreadyApplied,
      });
    }
  );
}
