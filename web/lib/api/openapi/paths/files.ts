import { z } from "zod";
import {
  bearerSecurity,
  errorResponses,
  fileIdParam,
  instrumentIdParam,
  jsonResponse,
  registry,
  runIdParam,
} from "../registry";
import { createFileBody, fileDetail, patchFileBody } from "../schemas/files";

const fileParams = z.object({ fileId: fileIdParam });
const runParams = z.object({
  instrumentId: instrumentIdParam,
  runId: runIdParam,
});
const body = (schema: z.ZodType) => ({
  content: { "application/json": { schema } },
});
const responses = (description: string, schema: z.ZodType = z.unknown()) => ({
  200: jsonResponse(description, schema),
  ...errorResponses(),
});

registry.registerPath({
  method: "post",
  path: "/instruments/{instrumentId}/runs/{runId}/files",
  operationId: "createRunFile",
  summary: "Create a run file record",
  description: "Requires scope `files:create`.",
  tags: ["Files"],
  security: bearerSecurity,
  request: { params: runParams, body: body(createFileBody) },
  responses: {
    200: jsonResponse("Existing file.", fileDetail),
    201: jsonResponse("Created file.", fileDetail),
    ...errorResponses(),
  },
});
registry.registerPath({
  method: "patch",
  path: "/files/{fileId}",
  operationId: "updateFile",
  summary: "Update a file",
  description: "Requires scope `files:update`.",
  tags: ["Files"],
  security: bearerSecurity,
  request: { params: fileParams, body: body(patchFileBody) },
  responses: responses("Updated file.", fileDetail),
});
registry.registerPath({
  method: "delete",
  path: "/files/{fileId}",
  operationId: "dismissFile",
  summary: "Dismiss a file",
  description: "Requires scope `files:delete`.",
  tags: ["Files"],
  security: bearerSecurity,
  request: { params: fileParams },
  responses: responses("Dismissal result."),
});
registry.registerPath({
  method: "get",
  path: "/files/{fileId}/download",
  operationId: "downloadFile",
  summary: "Redirect to file download",
  description: "Requires scope `files:read`.",
  tags: ["Files"],
  security: bearerSecurity,
  request: { params: fileParams },
  responses: {
    302: { description: "Redirect to a presigned download URL." },
    ...errorResponses(),
  },
});
registry.registerPath({
  method: "post",
  path: "/files/{fileId}/reprocess",
  operationId: "reprocessFile",
  summary: "Reprocess a file",
  description: "Requires scope `files:reprocess`.",
  tags: ["Files"],
  security: bearerSecurity,
  request: { params: fileParams },
  responses: responses("Reprocessing result."),
});
registry.registerPath({
  method: "get",
  path: "/instruments/{instrumentId}/runs/{runId}/download-archive",
  operationId: "downloadRunArchive",
  summary: "Download a run archive",
  description: "Requires scope `runs:read`.",
  tags: ["Files"],
  security: bearerSecurity,
  request: { params: runParams },
  responses: {
    302: { description: "Redirect to a presigned archive URL." },
    ...errorResponses(),
  },
});
