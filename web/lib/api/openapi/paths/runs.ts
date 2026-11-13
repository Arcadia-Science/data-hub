import { z } from "zod";
import {
  bearerSecurity,
  commentIdParam,
  errorResponses,
  instrumentIdParam,
  jsonResponse,
  registry,
  runIdParam,
} from "../registry";
import {
  commentBody,
  commentDeleted,
  commentsListResponse,
  createRunBody,
  patchRunBody,
  reportItemsQuery,
  reportItemsResponse,
  requestUploadBody,
  requestUploadUrlBody,
  runComment,
  runCreated,
  runDeleted,
  runDetail,
  runListQuery,
  runListResponse,
  runQueuedCancelled,
  runReprocessed,
  runRestored,
  runUpdated,
  uploadAllQueued,
  uploadQueued,
  uploadUrlResponse,
} from "../schemas/runs";
import { searchQuery, searchResponse } from "../schemas/search";

const runParams = z.object({
  instrumentId: instrumentIdParam,
  runId: runIdParam,
});
const commentParams = runParams.extend({ commentId: commentIdParam });
const tag = ["Runs"];
const scoped = (scope: string) => `Requires scope \`${scope}\`.`;
const scopedPat = (scope: string) =>
  `Requires scope \`${scope}\`. PAT only; browser sessions are rejected.`;
const body = (schema: z.ZodType) => ({
  content: { "application/json": { schema } },
});
const ok = (description: string, schema: z.ZodType) => ({
  200: jsonResponse(description, schema),
  ...errorResponses(),
});

registry.registerPath({
  method: "get",
  path: "/instrument-runs",
  operationId: "listInstrumentRuns",
  summary: "List runs across instruments",
  description: scoped("runs:read"),
  tags: tag,
  security: bearerSecurity,
  request: { query: runListQuery },
  responses: ok("Paginated runs.", runListResponse),
});
registry.registerPath({
  method: "get",
  path: "/instruments/{instrumentId}/runs",
  operationId: "listInstrumentRunsForInstrument",
  summary: "List an instrument's runs",
  description: scoped("runs:read"),
  tags: tag,
  security: bearerSecurity,
  request: {
    params: z.object({ instrumentId: instrumentIdParam }),
    query: runListQuery,
  },
  responses: ok("Paginated runs.", runListResponse),
});
registry.registerPath({
  method: "post",
  path: "/instruments/{instrumentId}/runs",
  operationId: "createInstrumentRun",
  summary: "Create an instrument run",
  description: `${scopedPat("runs:create")} Returns 200 with the existing run when it already exists. Returns 409 (\`details.reason: run_deleted\`) when the run exists and was deleted and the body has \`source: "watcher"\`, an \`acquired_at\`, or a non-empty \`detected_files\`. The request then attaches no files and changes nothing. A body with only \`run_id\` and \`source: "lambda"\` still gets 200.`,
  tags: tag,
  security: bearerSecurity,
  request: {
    params: z.object({ instrumentId: instrumentIdParam }),
    body: body(createRunBody),
  },
  responses: {
    200: jsonResponse("Existing run.", runCreated),
    201: jsonResponse("Created run.", runCreated),
    ...errorResponses(),
  },
});
registry.registerPath({
  method: "get",
  path: "/instruments/{instrumentId}/runs/{runId}",
  operationId: "getInstrumentRun",
  summary: "Get a run",
  description: scoped("runs:read"),
  tags: tag,
  security: bearerSecurity,
  request: { params: runParams },
  responses: ok("Run detail.", runDetail),
});
registry.registerPath({
  method: "patch",
  path: "/instruments/{instrumentId}/runs/{runId}",
  operationId: "updateInstrumentRun",
  summary: "Update a run",
  description: `${scopedPat("runs:update")} Returns 409 (\`details.reason: run_deleted\`) when the run was deleted. Restore it first.`,
  tags: tag,
  security: bearerSecurity,
  request: { params: runParams, body: body(patchRunBody) },
  responses: ok("Updated run.", runUpdated),
});
registry.registerPath({
  method: "delete",
  path: "/instruments/{instrumentId}/runs/{runId}",
  operationId: "deleteInstrumentRun",
  summary: "Soft-delete a run",
  description: `${scoped("runs:delete")} Also cancels the uploads that were requested for the run's files: they go back to \`detected\` and leave the watcher's upload queue. Restoring the run doesn't bring the requests back.`,
  tags: tag,
  security: bearerSecurity,
  request: { params: runParams },
  responses: ok("Deletion result.", runDeleted),
});
registry.registerPath({
  method: "post",
  path: "/instruments/{instrumentId}/runs/{runId}/restore",
  operationId: "restoreInstrumentRun",
  summary: "Restore a run",
  description: `${scoped("runs:delete")} Doesn't bring back the upload requests that deleting the run cancelled. Request the uploads again.`,
  tags: tag,
  security: bearerSecurity,
  request: { params: runParams },
  responses: ok("Restored run.", runRestored),
});
registry.registerPath({
  method: "post",
  path: "/instruments/{instrumentId}/runs/{runId}/reprocess",
  operationId: "reprocessInstrumentRun",
  summary: "Reprocess a run",
  description: `${scoped("runs:reprocess")} Queues every \`uploaded\`, \`failed\`, \`completed\`, or stalled \`processing\` raw file on the run for reprocessing. Each file starts as soon as a processing slot is free (at most 10 raw files process at once by default), and a file that does not start right away waits as \`queued\`. \`files_queued\` counts every file accepted, whether it started or is waiting. Processed artifacts are skipped. The instrument must have a Lambda processor.`,
  tags: tag,
  security: bearerSecurity,
  request: { params: runParams },
  responses: ok("Reprocessing result.", runReprocessed),
});
registry.registerPath({
  method: "post",
  path: "/instruments/{instrumentId}/runs/{runId}/cancel-queued",
  operationId: "cancelQueuedInstrumentRunFiles",
  summary: "Cancel a run's queued files",
  description: `${scoped("runs:reprocess")} Takes every \`queued\` file of the run out of the reprocessing queue. Each one becomes \`failed\` with a message that says the reprocess was cancelled, and can be reprocessed again. Files that have already started are not affected. Works on a soft-deleted run too. \`files_cancelled\` is 0 when no file was queued.`,
  tags: tag,
  security: bearerSecurity,
  request: { params: runParams },
  responses: ok("Cancellation result.", runQueuedCancelled),
});
registry.registerPath({
  method: "get",
  path: "/instruments/{instrumentId}/runs/{runId}/report-items",
  operationId: "listRunReportItems",
  summary: "List a run's report items",
  description: `${scoped("files:read")} Returns \`{id, filename}\` for the run's renderable images, PDFs, spectra, or videos, ordered by filename. Paged with \`offset\`/\`limit\` so viewers can seek by item index.`,
  tags: tag,
  security: bearerSecurity,
  request: { params: runParams, query: reportItemsQuery },
  responses: ok("Report items.", reportItemsResponse),
});
registry.registerPath({
  method: "get",
  path: "/search",
  operationId: "search",
  summary: "Search Data Hub",
  description: scoped("runs:read"),
  tags: tag,
  security: bearerSecurity,
  request: { query: searchQuery },
  responses: ok("Search results.", searchResponse),
});
registry.registerPath({
  method: "post",
  path: "/instruments/{instrumentId}/runs/{runId}/request-upload",
  operationId: "requestRunUpload",
  summary: "Queue selected files for upload",
  description: scoped("runs:upload"),
  tags: tag,
  security: bearerSecurity,
  request: { params: runParams, body: body(requestUploadBody) },
  responses: ok("Queued files.", uploadQueued),
});
registry.registerPath({
  method: "post",
  path: "/instruments/{instrumentId}/runs/{runId}/request-upload-all",
  operationId: "requestRunUploadAll",
  summary: "Queue all files for upload",
  description: scoped("runs:upload"),
  tags: tag,
  security: bearerSecurity,
  request: { params: runParams },
  responses: ok("Queued files.", uploadAllQueued),
});
registry.registerPath({
  method: "post",
  path: "/instruments/{instrumentId}/runs/{runId}/request-upload-url",
  operationId: "requestRunUploadUrl",
  summary: "Request a presigned upload URL",
  description: `${scopedPat("runs:upload")} Watchers at 1.1.0 or newer send \`relative_path\` and \`X-Data-Hub-Watcher-Version\`. A file whose name is already used by a different folder is stored as \`<stem>~<folder hash>.<ext>\`, and the returned \`s3_key\` uses that stored name. Older watchers are looked up by filename only. Watchers at 1.2.0 or newer receive a multipart upload for files of 100 MB or more. Older watchers are refused when the file is over 5 GB. Returns 409 (\`details.reason: run_deleted\`) when the run was deleted.`,
  tags: tag,
  security: bearerSecurity,
  request: { params: runParams, body: body(requestUploadUrlBody) },
  responses: ok("Upload URL.", uploadUrlResponse),
});
registry.registerPath({
  method: "get",
  path: "/instruments/{instrumentId}/runs/{runId}/comments",
  operationId: "listRunComments",
  summary: "List run comments",
  description: scoped("runs:read"),
  tags: tag,
  security: bearerSecurity,
  request: { params: runParams },
  responses: ok("Comments.", commentsListResponse),
});
registry.registerPath({
  method: "post",
  path: "/instruments/{instrumentId}/runs/{runId}/comments",
  operationId: "createRunComment",
  summary: "Create a run comment",
  description: scoped("runs:comment"),
  tags: tag,
  security: bearerSecurity,
  request: { params: runParams, body: body(commentBody) },
  responses: {
    201: jsonResponse("Created comment.", runComment),
    ...errorResponses(),
  },
});
registry.registerPath({
  method: "patch",
  path: "/instruments/{instrumentId}/runs/{runId}/comments/{commentId}",
  operationId: "updateRunComment",
  summary: "Update a run comment",
  description: scoped("runs:comment"),
  tags: tag,
  security: bearerSecurity,
  request: { params: commentParams, body: body(commentBody) },
  responses: ok("Updated comment.", runComment),
});
registry.registerPath({
  method: "delete",
  path: "/instruments/{instrumentId}/runs/{runId}/comments/{commentId}",
  operationId: "deleteRunComment",
  summary: "Delete a run comment",
  description: scoped("runs:comment"),
  tags: tag,
  security: bearerSecurity,
  request: { params: commentParams },
  responses: ok("Deleted comment.", commentDeleted),
});
