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
  createRunBody,
  patchRunBody,
  requestUploadBody,
  requestUploadUrlBody,
  runDetail,
  runListQuery,
  runListResponse,
} from "../schemas/runs";
import { searchQuery, searchResponse } from "../schemas/search";

const runParams = z.object({
  instrumentId: instrumentIdParam,
  runId: runIdParam,
});
const commentParams = runParams.extend({ commentId: commentIdParam });
const tag = ["Runs"];
const scoped = (scope: string) => `Requires scope \`${scope}\`.`;
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
  description: scoped("runs:create"),
  tags: tag,
  security: bearerSecurity,
  request: {
    params: z.object({ instrumentId: instrumentIdParam }),
    body: body(createRunBody),
  },
  responses: {
    200: jsonResponse("Existing run.", z.unknown()),
    201: jsonResponse("Created run.", z.unknown()),
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
  description: scoped("runs:update"),
  tags: tag,
  security: bearerSecurity,
  request: { params: runParams, body: body(patchRunBody) },
  responses: ok("Updated run.", runDetail),
});
registry.registerPath({
  method: "delete",
  path: "/instruments/{instrumentId}/runs/{runId}",
  operationId: "deleteInstrumentRun",
  summary: "Soft-delete a run",
  description: scoped("runs:delete"),
  tags: tag,
  security: bearerSecurity,
  request: { params: runParams },
  responses: ok("Deletion result.", z.unknown()),
});
registry.registerPath({
  method: "post",
  path: "/instruments/{instrumentId}/runs/{runId}/restore",
  operationId: "restoreInstrumentRun",
  summary: "Restore a run",
  description: scoped("runs:delete"),
  tags: tag,
  security: bearerSecurity,
  request: { params: runParams },
  responses: ok("Restored run.", z.unknown()),
});
registry.registerPath({
  method: "post",
  path: "/instruments/{instrumentId}/runs/{runId}/reprocess",
  operationId: "reprocessInstrumentRun",
  summary: "Reprocess a run",
  description: scoped("runs:reprocess"),
  tags: tag,
  security: bearerSecurity,
  request: { params: runParams },
  responses: ok("Reprocessing result.", z.unknown()),
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
  responses: ok("Queued files.", z.unknown()),
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
  responses: ok("Queued files.", z.unknown()),
});
registry.registerPath({
  method: "post",
  path: "/instruments/{instrumentId}/runs/{runId}/request-upload-url",
  operationId: "requestRunUploadUrl",
  summary: "Request a presigned upload URL",
  description: scoped("runs:upload"),
  tags: tag,
  security: bearerSecurity,
  request: { params: runParams, body: body(requestUploadUrlBody) },
  responses: ok("Upload URL.", z.unknown()),
});
registry.registerPath({
  method: "put",
  path: "/instruments/{instrumentId}/runs/{runId}/attributions/me",
  operationId: "claimRun",
  summary: "Claim a run",
  description: scoped("runs:attribute"),
  tags: tag,
  security: bearerSecurity,
  request: { params: runParams },
  responses: ok("Attributions.", z.unknown()),
});
registry.registerPath({
  method: "delete",
  path: "/instruments/{instrumentId}/runs/{runId}/attributions/me",
  operationId: "unclaimRun",
  summary: "Remove your run claim",
  description: scoped("runs:attribute"),
  tags: tag,
  security: bearerSecurity,
  request: { params: runParams },
  responses: ok("Attributions.", z.unknown()),
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
  responses: ok("Comments.", z.unknown()),
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
    201: jsonResponse("Created comment.", z.unknown()),
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
  responses: ok("Updated comment.", z.unknown()),
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
  responses: ok("Deleted comment.", z.unknown()),
});
