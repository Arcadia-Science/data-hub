import { z } from "zod";
import type { McpToolDef } from "@/lib/mcp/catalog/types";
import { FILE_ACTION_IDS_MAX } from "@/lib/runs/file-action-limits";
import {
  deleteFilesOutputSchema,
  dismissFileOutputSchema,
  getFileDownloadUrlOutputSchema,
  getFileOutputSchema,
  getRunArchiveOutputSchema,
  reprocessFileOutputSchema,
  restoreFilesOutputSchema,
} from "./files.output";

export const getFileTool = {
  name: "get_file",
  title: "Get File",
  description:
    "Get detailed metadata for a single file by its numeric ID, including status, S3 location, size, extracted metadata, and any error message. A deleted file is returned too: deletedAt is set, and deletedBy (a user ID) or deletedByToken names who deleted it.",
  group: "files",
  scope: "files:read",
  inputSchema: { fileId: z.number().int().describe("Numeric file ID") },
  outputSchema: getFileOutputSchema,
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const getFileDownloadUrlTool = {
  name: "get_file_download_url",
  title: "Get File Download URL",
  description:
    "Get a short-lived pre-signed S3 URL to download the raw file contents. URL expires after 15 minutes. Also returns the file's run as `instrumentId` and `runId`. `unclaimed` is true when nobody has claimed the run yet. Then ask the user once whether they ran it, and call claim_run if they did.",
  group: "files",
  scope: "files:read",
  inputSchema: { fileId: z.number().int().describe("Numeric file ID") },
  outputSchema: getFileDownloadUrlOutputSchema,
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const getRunArchiveTool = {
  name: "get_run_archive",
  title: "Get Run Archive",
  description:
    "Get a downloadable ZIP archive of every active, uploaded file in a run. If the archive is already cached, returns a short-lived (15 min) pre-signed S3 URL the caller can fetch directly without auth — paste it into a browser or share it as a download link. If the archive isn't cached, kicks off an async build and returns `{ status: 'building', jobId, retryAfterSeconds }`; call this tool again after the suggested wait to poll for completion. Most archives finish in a few seconds; large runs may take a minute or two. Mirrors the REST `download-archive` route, including its dedup-by-fingerprint cache, so concurrent callers share a single Lambda invocation. `unclaimed` is true when nobody has claimed the run yet. Then ask the user once whether they ran it, and call claim_run if they did.",
  group: "files",
  scope: "files:read",
  inputSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    runId: z.string().describe("Run identifier within the instrument"),
  },
  outputSchema: getRunArchiveOutputSchema,
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const reprocessFileTool = {
  name: "reprocess_file",
  title: "Reprocess File",
  description:
    "Re-run the Lambda processing workflow for an uploaded, failed, completed, or stalled raw file on an instrument that has a Lambda processor. A file is stalled when it has been in 'processing' longer than the configured stall window (20 minutes by default, past the Lambda's 15-minute limit) or has no processing-started timestamp. Processed artifacts are rejected. The file is queued first and starts as soon as a processing slot is free. The result is status 'processing' when the file started right away and 'queued' when it did not, for example because 10 raw files are already processing (the default limit across Data Hub). A file that is already 'queued' is rejected. Use this to retry after a parser fix, transient Lambda failure, a stuck upload that never entered processing, or a file that never reported back from processing.",
  group: "files",
  scope: "files:reprocess",
  inputSchema: { fileId: z.number().int().describe("Numeric file ID") },
  outputSchema: reprocessFileOutputSchema,
  // destructiveHint is true because the tool resets status/errorMessage/
  // processedAt. The Lambda re-processes the file, but the mutation is
  // irreversible from the tool's perspective and clients should confirm.
  annotations: { readOnlyHint: false, destructiveHint: true },
} as const satisfies McpToolDef;

const fileIds = z
  .array(z.number().int())
  .min(1)
  .max(FILE_ACTION_IDS_MAX)
  .describe(
    `Numeric IDs of files in this run, from list_run_files (1–${FILE_ACTION_IDS_MAX}). An ID that isn't a file of this run gets a 404 result.`
  );

export const deleteFilesTool = {
  name: "delete_files",
  title: "Delete Files",
  description: `Delete up to ${FILE_ACTION_IDS_MAX} files of one run, whether or not they were uploaded, and report a result for each. A deleted file is left out of the run's file lists and downloads, but stays in storage, records who deleted it, and can still be read by its ID; restore_files brings it back. Only the files you name are deleted unless includeLinked is true. includeLinked also deletes the files linked to them: for a raw file, the processed files made from it (such as its preview video and image), and the run.json saved with its capture when every raw file in that folder is being deleted. \`linked\` lists them. Before you pass includeLinked: true, tell the user it also deletes those linked files and get their OK. A file that is queued or processing is refused until processing finishes (a stalled file can be deleted), and so is any file of a deleted run. A refused file doesn't stop the others. Deleting a file that is already deleted succeeds with alreadyApplied. Acts as the signed-in user. Ask the user to confirm first.`,
  group: "files",
  scope: "files:delete",
  inputSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    runId: z.string().describe("Run identifier within the instrument"),
    fileIds,
    includeLinked: z
      .boolean()
      .optional()
      .describe(
        "Also delete the files linked to these: the processed files made from a raw file, and its run.json. Default false. Confirm with the user before you pass true."
      ),
  },
  outputSchema: deleteFilesOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
} as const satisfies McpToolDef;

export const restoreFilesTool = {
  name: "restore_files",
  title: "Restore Files",
  description: `Bring back up to ${FILE_ACTION_IDS_MAX} deleted files of one run, and report a result for each. Find deleted files with list_run_files includeDeleted. Only the files you name come back unless includeLinked is true. includeLinked also restores their deleted linked files: the deleted processed files made from a raw file, the raw file a deleted processed file was made from, and the run.json of a restored raw file's folder. \`linked\` lists each with its own result. Before you pass includeLinked: true, tell the user it also restores those linked files and get their OK. A file is refused with a 409 (details.reason path_in_use, and details.held_by naming the file) when another file of the run now has its name or path, and so is any file of a deleted run. A refused file doesn't stop the others. Restoring a file that isn't deleted succeeds with alreadyApplied. Acts as the signed-in user. Ask the user to confirm first.`,
  group: "files",
  scope: "files:delete",
  inputSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    runId: z.string().describe("Run identifier within the instrument"),
    fileIds,
    includeLinked: z
      .boolean()
      .optional()
      .describe(
        "Also restore the deleted files linked to these. Default false. Confirm with the user before you pass true."
      ),
  },
  outputSchema: restoreFilesOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
} as const satisfies McpToolDef;

export const dismissFileTool = {
  name: "dismiss_file",
  title: "Dismiss File (Deprecated)",
  description:
    "Deprecated: use delete_files, which takes up to 100 files of a run, can delete their linked files too, and has restore_files to undo it. It still works, for one file by its ID, and will be removed. Soft-delete a file from a run, whether or not it has been uploaded. The file stays in storage and records who deleted it. It is refused while the file is queued or still processing (a stalled file can be deleted), and for a file of a deleted run. Idempotent: deleting an already-deleted file succeeds as a no-op. Deletes only that file, never its linked files.",
  group: "files",
  scope: "files:delete",
  inputSchema: { fileId: z.number().int().describe("Numeric file ID") },
  outputSchema: dismissFileOutputSchema,
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
  deleteFilesTool,
  restoreFilesTool,
  dismissFileTool,
] as const;
