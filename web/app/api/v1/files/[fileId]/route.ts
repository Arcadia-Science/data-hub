import { eq } from "drizzle-orm";
import { after, type NextRequest } from "next/server";
import { actorRefFromAuth } from "@/lib/api/actor";
import { authorize, authorizeToken } from "@/lib/api/auth";
import {
  apiError,
  apiErrorFromResult,
  CONFLICT,
  fileDeletedError,
  INTERNAL_ERROR,
  NOT_FOUND,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import { deleteFiles } from "@/lib/api/file-deletion";
import { dispatchQueuedFiles } from "@/lib/api/file-reprocessing";
import { patchFileBody, readJsonBody } from "@/lib/api/openapi";
import { runFileS3Key } from "@/lib/api/run-file-location";
import { touchRuns } from "@/lib/api/touch-runs";
import {
  UPLOAD_ARRIVED_RESET,
  UPLOAD_REQUEST_CANCELLED_RESET,
} from "@/lib/api/upload-state";
import {
  enforceWatcherTokenFile,
  enforceWatcherTokenInstrument,
  NOT_THIS_FILE,
} from "@/lib/api/watchers";
import { db } from "@/lib/db";
import { files, instrumentRuns } from "@/lib/db/schema";
import { getS3RawDataBucket } from "@/lib/s3";

interface RouteContext {
  params: Promise<{ fileId: string }>;
}

// Enforced state machine for file status transitions:
//   Watcher flow:   detected → [upload_requested →] uploaded → processing → completed|failed
//   Lambda flow:    (created as "uploaded" via POST .../files) → processing → completed|failed
//   Reprocessing:   uploaded|completed|failed|stalled-processing → queued → processing → completed|failed
//                   A reprocess request sets `queued` and the dispatcher in
//                   lib/api/file-reprocessing.ts sets `processing`, so neither
//                   step is a PATCH. A queued file can still be PATCHed to
//                   `processing`, which is what the Lambda does when an S3
//                   re-upload of that file starts it directly.
//                   The dispatcher also stamps each start with a `dispatch_id`
//                   so it can tell its own start from a later one. A PATCH
//                   keeps that ID on processing → processing (the Lambda's own
//                   first update) and clears it on a move into `processing`
//                   from any other status and on `completed` and `failed`.
//   Cancel request: upload_requested → detected (watcher gave up locating
//                   the local file after repeated polls; clears the queue
//                   entry)
//   Repeat:         completed → completed and failed → failed. The Lambda
//                   sends a final status again when the first attempt got a
//                   transient error, and that attempt may have been saved
//                   with only its response lost. A repeat keeps `processed_at`
//                   and stores the same metadata and error message again.
const VALID_TRANSITIONS: Record<string, string[]> = {
  detected: ["uploaded"],
  upload_requested: ["uploaded", "detected"],
  // An auto-mode watcher retries a file it gave up on at its next start, and a
  // success still lands. The give-up itself goes through
  // POST /watchers/:id/upload-failures, not this route.
  upload_failed: ["uploaded"],
  uploaded: ["processing"],
  queued: ["processing"],
  processing: ["processing", "completed", "failed"],
  completed: ["processing", "completed"],
  failed: ["processing", "failed"],
};

// ---------------------------------------------------------------------------
// PATCH /api/v1/files/:fileId
//
// Serves multiple callers:
//   - Watcher: detected/upload_requested → uploaded (with S3 info)
//   - Lambda: uploaded → processing → completed/failed (with metadata)
//
// Enforces the file status state machine and rejects mutations on
// soft-deleted files (409, `details.reason: "file_deleted"`) or files whose
// parent run is soft-deleted. The Lambda reads that reason to stop quietly when
// a file was deleted while it processed.
//
// A token that registered a watcher may change only the files of an
// instrument whose active watcher it registered, and gets 403 for any other
// file. Tokens that registered no watcher, such as the Lambda's, may change
// any file.
//
// PAT-only (no browser sessions): session auth carries `*` scope, and
// accepting it let any signed-in user mark files uploaded or overwrite
// Lambda-owned metadata. DELETE below stays session-reachable for the UI.
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorizeToken(request, "files:update");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { fileId } = await params;
  const numericId = Number.parseInt(fileId, 10);
  if (Number.isNaN(numericId)) {
    return apiError(400, VALIDATION_ERROR, "Invalid file ID");
  }

  const [file] = await db
    .select()
    .from(files)
    .where(eq(files.id, numericId))
    .limit(1);

  if (!file) {
    return apiError(404, NOT_FOUND, `File '${fileId}' not found`);
  }

  // The parent run gives the file's instrument for the check below. Its
  // natural key also feeds the server-derived S3 location on the `uploaded`
  // transition.
  const [parentRun] = await db
    .select({
      deletedAt: instrumentRuns.deletedAt,
      instrumentId: instrumentRuns.instrumentId,
      runId: instrumentRuns.runId,
    })
    .from(instrumentRuns)
    .where(eq(instrumentRuns.id, file.instrumentRunId))
    .limit(1);

  if (!parentRun) {
    return apiError(404, NOT_FOUND, `File '${fileId}' not found`);
  }

  // A watcher's token may change only its own instrument's files. This comes
  // before the soft-delete checks, so a refused token learns nothing more
  // about another instrument's file.
  const denied = await enforceWatcherTokenInstrument(
    authResult,
    parentRun.instrumentId,
    NOT_THIS_FILE
  );
  if (denied) {
    return denied;
  }

  if (file.deletedAt) {
    return fileDeletedError("Cannot update a soft-deleted file");
  }

  if (parentRun.deletedAt) {
    return apiError(
      409,
      CONFLICT,
      "Cannot update a file whose parent run is soft-deleted"
    );
  }

  const body = await readJsonBody(request, patchFileBody);
  if (body instanceof Response) {
    return body;
  }

  const updates: Record<string, unknown> = {};
  const now = new Date();

  // Status transition validation.
  if (body.status !== undefined) {
    const allowed = VALID_TRANSITIONS[file.status];
    if (!allowed?.includes(body.status)) {
      return apiError(
        409,
        CONFLICT,
        `Cannot transition from '${file.status}' to '${body.status}'`,
        { allowed_transitions: allowed ?? [] }
      );
    }

    updates.status = body.status;

    if (body.status === "uploaded") {
      updates.uploadedAt = now;

      // Derive the S3 location from trusted DB state, not the request: the
      // watcher only echoed back what `request-upload-url` already computed,
      // and accepting it let any caller repoint a file at an arbitrary object.
      let bucket: string;
      try {
        bucket = getS3RawDataBucket();
      } catch {
        return apiError(
          500,
          INTERNAL_ERROR,
          "S3 bucket configuration is missing"
        );
      }
      updates.s3Bucket = bucket;
      updates.s3Key = runFileS3Key(
        parentRun.instrumentId,
        parentRun.runId,
        file.filename
      );
    }
    // The bytes arrived: a failure reason or an auto-upload mark from before no
    // longer applies.
    if (body.status === "uploaded") {
      Object.assign(updates, UPLOAD_ARRIVED_RESET);
    }
    // Reverting a pending request back to detected (a watcher before 1.4.5
    // cancelling): clear upload_requested_at so the row leaves the upload
    // queue, whose filter requires upload_requested_at to be non-null, and the
    // requester with it.
    if (body.status === "detected") {
      Object.assign(updates, UPLOAD_REQUEST_CANCELLED_RESET);
    }
    // A repeat of the same final status keeps the time of the first.
    if (
      (body.status === "completed" || body.status === "failed") &&
      file.status !== body.status
    ) {
      updates.processedAt = now;
    }
    // The start that the dispatcher made ends with a final status. Clearing the
    // ID means a late HTTP answer from that start cannot overwrite the result.
    if (body.status === "completed" || body.status === "failed") {
      updates.dispatchId = null;
    }
    if (body.status === "processing") {
      updates.processingStartedAt = now;
      // A queued file that starts another way (an S3 re-upload) leaves the
      // queue.
      updates.queuedAt = null;
      // The Lambda's own first update arrives while the file is already
      // `processing`, and it keeps the dispatcher's ID. A move into
      // `processing` from any other status is a start the dispatcher did not
      // make, such as an S3 upload, so it clears the ID. An older dispatch's
      // late answer then cannot fail this start.
      if (file.status !== "processing") {
        updates.dispatchId = null;
      }
      if (file.status === "completed" || file.status === "failed") {
        updates.processedAt = null;
        updates.errorMessage = null;
      }
    }
  }

  // Treat an explicit null as "no value": the watcher sends null for
  // extensions without a MIME mapping, and storing it would clear a type
  // the create/adopt paths may already have set.
  if (body.content_type != null) {
    updates.contentType = body.content_type;
  }
  if (body.size_bytes !== undefined) {
    updates.sizeBytes = body.size_bytes;
  }

  // Metadata — flat JSON object set by the Lambda after processing.
  if (body.metadata !== undefined) {
    updates.metadata = body.metadata;
  }

  // Error message — set when status transitions to "failed".
  if (body.error_message !== undefined) {
    updates.errorMessage = body.error_message;
  }

  if (Object.keys(updates).length > 0) {
    await db.update(files).set(updates).where(eq(files.id, numericId));
    await touchRuns([file.instrumentRunId]);
  }

  // A finished file frees a processing slot. Start the next queued file after
  // the response, so the Lambda's callback does not wait for it.
  if (body.status === "completed" || body.status === "failed") {
    after(async () => {
      try {
        await dispatchQueuedFiles();
      } catch (err) {
        console.error(
          "Failed to start queued files after a file finished:",
          err
        );
      }
    });
  }

  // Re-fetch the updated file to return current state.
  const [updated] = await db
    .select()
    .from(files)
    .where(eq(files.id, numericId))
    .limit(1);

  return Response.json({
    id: updated.id,
    instrument_run_id: updated.instrumentRunId,
    filename: updated.filename,
    relative_path: updated.relativePath,
    s3_bucket: updated.s3Bucket,
    s3_key: updated.s3Key,
    content_type: updated.contentType,
    size_bytes: updated.sizeBytes,
    category: updated.category,
    status: updated.status,
    metadata: updated.metadata,
    error_message: updated.errorMessage,
    detected_at: updated.detectedAt,
    upload_requested_at: updated.uploadRequestedAt,
    uploaded_at: updated.uploadedAt,
    processed_at: updated.processedAt,
    processing_started_at: updated.processingStartedAt,
    created_at: updated.createdAt,
    file_created_at: updated.fileCreatedAt,
    deleted_at: updated.deletedAt,
  });
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/files/:fileId
//
// Soft-deletes one file in any state a person can see it in, uploaded files
// included. The file keeps its row and its S3 object, records who deleted it,
// and can be restored. A file that is queued or processing is refused until
// processing finishes, and so is any file of a deleted run. Deleting a file
// that is already deleted succeeds with `already_applied`.
//
// A token that registered a watcher may delete only its own instrument's files,
// like PATCH above.
// ---------------------------------------------------------------------------

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "files:delete");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { fileId } = await params;
  const numericId = Number.parseInt(fileId, 10);
  if (Number.isNaN(numericId)) {
    return apiError(400, VALIDATION_ERROR, "Invalid file ID");
  }

  const denied = await enforceWatcherTokenFile(authResult, numericId);
  if (denied) {
    return denied;
  }

  const { results } = await deleteFiles(
    [numericId],
    actorRefFromAuth(authResult),
    { includeLinked: false }
  );
  const result = results[0];

  if (!result?.ok) {
    return result
      ? apiErrorFromResult(result)
      : apiError(404, NOT_FOUND, `File '${fileId}' not found`);
  }

  return Response.json({
    id: result.id,
    filename: result.filename,
    deleted_at: result.deletedAt,
    already_applied: result.alreadyApplied,
  });
}
