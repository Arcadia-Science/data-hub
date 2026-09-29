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
import {
  createFileBody,
  fileDetail,
  fileDismissed,
  fileReprocessed,
  multipartAbortBody,
  multipartAbortResponse,
  multipartCompleteBody,
  multipartCompleteResponse,
  multipartPartUrlsBody,
  multipartPartUrlsResponse,
  patchFileBody,
} from "../schemas/files";

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
  description:
    "Requires scope `files:create`. PAT only; browser sessions are rejected.",
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
  description:
    "Requires scope `files:update`. PAT only; browser sessions are rejected.",
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
  responses: responses("Dismissal result.", fileDismissed),
});
registry.registerPath({
  method: "get",
  path: "/files/{fileId}/download",
  operationId: "downloadFile",
  summary: "Redirect to file download",
  description:
    "Requires scope `files:read`. Pass `disposition=inline` to override a stored `binary/octet-stream` type so browsers can render PDFs in an iframe.",
  tags: ["Files"],
  security: bearerSecurity,
  request: {
    params: fileParams,
    query: z.object({
      disposition: z.enum(["inline"]).optional(),
    }),
  },
  responses: {
    302: { description: "Redirect to a presigned download URL." },
    ...errorResponses(),
  },
});
registry.registerPath({
  method: "post",
  path: "/files/{fileId}/multipart-upload/part-urls",
  operationId: "signMultipartPartUrls",
  summary: "Sign URLs for multipart upload parts",
  description:
    "Requires scope `runs:upload`. PAT only. Returns a few presigned UploadPart URLs. Fetch the next batch when these expire.",
  tags: ["Files"],
  security: bearerSecurity,
  request: { params: fileParams, body: body(multipartPartUrlsBody) },
  responses: responses("Part URLs.", multipartPartUrlsResponse),
});
registry.registerPath({
  method: "post",
  path: "/files/{fileId}/multipart-upload/complete",
  operationId: "completeMultipartUpload",
  summary: "Finish a multipart upload",
  description:
    "Requires scope `runs:upload`. PAT only. Sends the part list and the whole-file CRC64NVME checksum to S3, then marks the file uploaded.",
  tags: ["Files"],
  security: bearerSecurity,
  request: { params: fileParams, body: body(multipartCompleteBody) },
  responses: responses("Upload finished.", multipartCompleteResponse),
});
registry.registerPath({
  method: "delete",
  path: "/files/{fileId}/multipart-upload",
  operationId: "abortMultipartUpload",
  summary: "Cancel a multipart upload",
  description:
    "Requires scope `runs:upload`. PAT only. Cancels the in-progress S3 upload and clears it from the file.",
  tags: ["Files"],
  security: bearerSecurity,
  request: { params: fileParams, body: body(multipartAbortBody) },
  responses: responses("Upload cancelled.", multipartAbortResponse),
});
registry.registerPath({
  method: "post",
  path: "/files/{fileId}/reprocess",
  operationId: "reprocessFile",
  summary: "Reprocess a file",
  description:
    "Requires scope `files:reprocess`. Raw files only. Eligible statuses: `uploaded`, `failed`, `completed`, or stalled `processing` (file must have an S3 location). The file's instrument must have a Lambda processor.",
  tags: ["Files"],
  security: bearerSecurity,
  request: { params: fileParams },
  responses: responses("Reprocessing result.", fileReprocessed),
});
registry.registerPath({
  method: "get",
  path: "/instruments/{instrumentId}/runs/{runId}/download-archive",
  operationId: "downloadRunArchive",
  summary: "Download a run archive",
  description: "Requires scope `files:read`.",
  tags: ["Files"],
  security: bearerSecurity,
  request: { params: runParams },
  responses: {
    302: { description: "Redirect to a presigned archive URL." },
    ...errorResponses(),
  },
});
