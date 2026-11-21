import { z } from "zod";
import {
  bearerSecurity,
  errorResponses,
  fileIdParam,
  instrumentIdParam,
  jsonResponse,
  registry,
  runIdParam,
  WATCHER_TOKEN_OWN_INSTRUMENT,
} from "../registry";
import {
  createFileBody,
  fileActionBody,
  fileActionQuery,
  fileDeleted,
  fileDetail,
  fileReprocessed,
  fileRestored,
  multipartAbortBody,
  multipartAbortResponse,
  multipartCompleteBody,
  multipartCompleteResponse,
  multipartPartUrlsBody,
  multipartPartUrlsResponse,
  patchFileBody,
  runFilesDeleted,
  runFilesLinked,
  runFilesLinkedQuery,
  runFilesRestored,
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
  description: `Requires scope \`files:create\`. PAT only; browser sessions are rejected. ${WATCHER_TOKEN_OWN_INSTRUMENT} The location must be the file's own: \`s3_key\` must be \`<instrumentId>/<runId>/<filename>\`, using the run ID as stored, \`filename\` can't contain \`/\`, and \`s3_bucket\` must be Data Hub's raw bucket for a \`raw\` file or its processed bucket for a \`processed\` one. Any other location gets \`400\`. \`source_file_id\` is for a \`processed\` file and names the raw file of this run that it was made from; any other value gets \`400\`. An existing processed file that has no source yet is linked to it; one that has a source keeps it. A processed file made from a deleted raw file is saved deleted, and when the key belongs to a deleted processed file, that file is saved again as the new output. \`409\` means the run is deleted, or another file already uses that key or path.`,
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
  description: `Requires scope \`files:update\`. PAT only; browser sessions are rejected. Returns \`409\` (\`details.reason: file_deleted\`) when the file was deleted. ${WATCHER_TOKEN_OWN_INSTRUMENT}`,
  tags: ["Files"],
  security: bearerSecurity,
  request: { params: fileParams, body: body(patchFileBody) },
  responses: responses("Updated file.", fileDetail),
});
registry.registerPath({
  method: "delete",
  path: "/files/{fileId}",
  operationId: "deleteFile",
  summary: "Delete a file",
  description: `Requires scope \`files:delete\`. Deletes the file from its run, whether or not it was uploaded. The file stays in storage, its row records who deleted it, and \`POST /files/{fileId}/restore\` brings it back. Deleted files are left out of the run's file lists and downloads. Pass \`include_linked=true\` to delete the files linked to it too: for a raw file, the processed files made from it and the \`run.json\` saved with its capture when every raw file in that folder is being deleted. \`linked\` lists them. Returns \`409\` while the file is queued or processing, unless its processing has stalled (wait for processing to finish), and \`409\` (\`details.reason: run_deleted\`) when the run was deleted. Deleting a file that is already deleted succeeds with \`already_applied: true\`. ${WATCHER_TOKEN_OWN_INSTRUMENT}`,
  tags: ["Files"],
  security: bearerSecurity,
  request: { params: fileParams, query: fileActionQuery },
  responses: responses("Deletion result.", fileDeleted),
});
registry.registerPath({
  method: "post",
  path: "/files/{fileId}/restore",
  operationId: "restoreFile",
  summary: "Restore a file",
  description: `Requires scope \`files:delete\`. Brings a deleted file back to its run and clears who deleted it. Pass \`include_linked=true\` to restore the deleted files linked to it too, which \`linked\` lists, each with its own result. Returns \`409\` (\`details.reason: path_in_use\`, with \`details.held_by\` naming the file) when another file of the run now has this file's name or path, and \`409\` (\`details.reason: run_deleted\`) when the run was deleted. Restoring a file that isn't deleted succeeds with \`already_applied: true\`. ${WATCHER_TOKEN_OWN_INSTRUMENT}`,
  tags: ["Files"],
  security: bearerSecurity,
  request: { params: fileParams, query: fileActionQuery },
  responses: responses("Restore result.", fileRestored),
});
registry.registerPath({
  method: "post",
  path: "/instruments/{instrumentId}/runs/{runId}/files/delete",
  operationId: "deleteRunFiles",
  summary: "Delete several files of a run",
  description: `Requires scope \`files:delete\`. Deletes up to 100 files of one run, as \`DELETE /files/{fileId}\` does for one. The response lists a result for each file in the order sent, so one that can't be deleted doesn't stop the others: \`404\` for an ID that isn't a file of this run, \`409\` for a file that is queued or processing (\`details.reason: file_processing\`) or whose run was deleted (\`details.reason: run_deleted\`). Set \`include_linked\` to delete the files linked to them too; \`linked\` lists those. The request itself returns \`404\` only when the run doesn't exist. ${WATCHER_TOKEN_OWN_INSTRUMENT}`,
  tags: ["Files"],
  security: bearerSecurity,
  request: { params: runParams, body: body(fileActionBody) },
  responses: responses("Results for each file.", runFilesDeleted),
});
registry.registerPath({
  method: "post",
  path: "/instruments/{instrumentId}/runs/{runId}/files/restore",
  operationId: "restoreRunFiles",
  summary: "Restore several files of a run",
  description: `Requires scope \`files:delete\`. Restores up to 100 deleted files of one run, as \`POST /files/{fileId}/restore\` does for one. The response lists a result for each file in the order sent, so one that can't come back doesn't stop the others: \`404\` for an ID that isn't a file of this run, \`409\` (\`details.reason: path_in_use\`, with \`details.held_by\` naming the file) when another file of the run now has its name or path, and \`409\` (\`details.reason: run_deleted\`) when the run was deleted. Set \`include_linked\` to restore the deleted files linked to them too; \`linked\` lists those, each with its own result. The request itself returns \`404\` only when the run doesn't exist. ${WATCHER_TOKEN_OWN_INSTRUMENT}`,
  tags: ["Files"],
  security: bearerSecurity,
  request: { params: runParams, body: body(fileActionBody) },
  responses: responses("Results for each file.", runFilesRestored),
});
registry.registerPath({
  method: "get",
  path: "/instruments/{instrumentId}/runs/{runId}/files/linked",
  operationId: "listLinkedRunFiles",
  summary: "List the files linked to some files of a run",
  description: `Requires scope \`files:delete\`. Lists what a delete (the default) or a restore (\`for=restore\`) would take along with each file, grouped by the file you asked about, so you can show it before you act. For a delete, a raw file's linked files are the active processed files made from it and the \`run.json\` saved with its capture, which is listed only when every raw file in that folder is among the files asked about. For a restore, they are the deleted ones, and a deleted \`run.json\` comes back when any raw file of its folder does. A deleted processed file's linked file is the deleted raw file it was made from. ${WATCHER_TOKEN_OWN_INSTRUMENT}`,
  tags: ["Files"],
  security: bearerSecurity,
  request: { params: runParams, query: runFilesLinkedQuery },
  responses: responses("Linked files.", runFilesLinked),
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
  description: `Requires scope \`runs:upload\`. PAT only. Returns a few presigned UploadPart URLs. Fetch the next batch when these expire. ${WATCHER_TOKEN_OWN_INSTRUMENT}`,
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
  description: `Requires scope \`runs:upload\`. PAT only. Sends the part list and the whole-file CRC64NVME checksum to S3, then marks the file uploaded. ${WATCHER_TOKEN_OWN_INSTRUMENT}`,
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
  description: `Requires scope \`runs:upload\`. PAT only. Cancels the in-progress S3 upload and clears it from the file. ${WATCHER_TOKEN_OWN_INSTRUMENT}`,
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
  description: `Requires scope \`files:reprocess\`. Raw files only. Eligible statuses: \`uploaded\`, \`failed\`, \`completed\`, or stalled \`processing\` (file must have an S3 location). The file's instrument must have a Lambda processor. The file is queued first and starts as soon as a processing slot is free. Returns \`processing\` when the file started right away. Returns \`queued\` when it did not, for example because 10 raw files are already processing (the default limit across Data Hub). A file that is already \`queued\` returns \`409\`. ${WATCHER_TOKEN_OWN_INSTRUMENT}`,
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
