import { z } from "zod";
import type { McpToolDef } from "@/lib/mcp/catalog/types";

export const getFileTool = {
  name: "get_file",
  title: "Get File",
  description:
    "Get detailed metadata for a single file by its numeric ID, including status, S3 location, size, extracted metadata, and any error message.",
  group: "files",
  scope: "files:read",
  inputSchema: { fileId: z.number().int().describe("Numeric file ID") },
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const getFileDownloadUrlTool = {
  name: "get_file_download_url",
  title: "Get File Download URL",
  description:
    "Get a short-lived pre-signed S3 URL to download the raw file contents. URL expires after 15 minutes.",
  group: "files",
  scope: "files:read",
  inputSchema: { fileId: z.number().int().describe("Numeric file ID") },
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const getRunArchiveTool = {
  name: "get_run_archive",
  title: "Get Run Archive",
  description:
    "Get a downloadable ZIP archive of every active, uploaded file in a run. If the archive is already cached, returns a short-lived (15 min) pre-signed S3 URL the caller can fetch directly without auth — paste it into a browser or share it as a download link. If the archive isn't cached, kicks off an async build and returns `{ status: 'building', jobId, retryAfterSeconds }`; call this tool again after the suggested wait to poll for completion. Most archives finish in a few seconds; large runs may take a minute or two. Mirrors the REST `download-archive` route, including its dedup-by-fingerprint cache, so concurrent callers share a single Lambda invocation.",
  group: "files",
  scope: "files:read",
  inputSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    runId: z.string().describe("Run identifier within the instrument"),
  },
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const reprocessFileTool = {
  name: "reprocess_file",
  title: "Reprocess File",
  description:
    "Re-run the Lambda processing workflow for a failed or completed file. Transitions the file back to 'processing'. Use this to retry after a parser fix or transient Lambda failure.",
  group: "files",
  scope: "files:reprocess",
  inputSchema: { fileId: z.number().int().describe("Numeric file ID") },
  // destructiveHint is true because the tool resets status/errorMessage/
  // processedAt. The Lambda re-processes the file, but the mutation is
  // irreversible from the tool's perspective and clients should confirm.
  annotations: { readOnlyHint: false, destructiveHint: true },
} as const satisfies McpToolDef;

export const dismissFileTool = {
  name: "dismiss_file",
  title: "Dismiss File",
  description:
    "Soft-delete a detected or upload_requested file (UI 'dismiss'). Uploaded files cannot be dismissed — delete the run instead. Idempotent: dismissing an already-dismissed file succeeds as a no-op.",
  group: "files",
  scope: "files:delete",
  inputSchema: { fileId: z.number().int().describe("Numeric file ID") },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
} as const satisfies McpToolDef;

export const FILE_TOOL_DEFS = [
  getFileTool,
  getFileDownloadUrlTool,
  getRunArchiveTool,
  reprocessFileTool,
  dismissFileTool,
] as const;
