import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { authorize } from "@/lib/api/auth";
import {
  apiError,
  apiErrorFromResult,
  CONFLICT,
  INTERNAL_ERROR,
  NOT_FOUND,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import { dismissFile } from "@/lib/api/files";
import { patchFileBody, readJsonBody } from "@/lib/api/openapi";
import { db } from "@/lib/db";
import { files, instrumentRuns } from "@/lib/db/schema";
import { getS3RawDataBucket } from "@/lib/s3";

interface RouteContext {
  params: Promise<{ fileId: string }>;
}

// Enforced state machine for file status transitions:
//   Watcher flow:   detected → [upload_requested →] uploaded → processing → completed|failed
//   Lambda flow:    (created as "uploaded" via POST .../files) → processing → completed|failed
//   Reprocessing:   uploaded|completed|failed → processing → completed|failed
//   Cancel request: upload_requested → detected (watcher gave up locating
//                   the local file after repeated polls; clears the queue
//                   entry)
const VALID_TRANSITIONS: Record<string, string[]> = {
  detected: ["uploaded"],
  upload_requested: ["uploaded", "detected"],
  uploaded: ["processing"],
  processing: ["processing", "completed", "failed"],
  completed: ["processing"],
  failed: ["processing"],
};

// ---------------------------------------------------------------------------
// PATCH /api/v1/files/:fileId
//
// Serves multiple callers:
//   - Watcher: detected/upload_requested → uploaded (with S3 info)
//   - Lambda: uploaded → processing → completed/failed (with metadata)
//
// Enforces the file status state machine and rejects mutations on
// soft-deleted files or files whose parent run is soft-deleted.
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "files:update");
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

  if (file.deletedAt) {
    return apiError(409, CONFLICT, "Cannot update a soft-deleted file");
  }

  // Verify the parent run is not soft-deleted. Its natural key also feeds the
  // server-derived S3 location on the `uploaded` transition below.
  const [parentRun] = await db
    .select({
      deletedAt: instrumentRuns.deletedAt,
      instrumentId: instrumentRuns.instrumentId,
      runId: instrumentRuns.runId,
    })
    .from(instrumentRuns)
    .where(eq(instrumentRuns.id, file.instrumentRunId))
    .limit(1);

  if (parentRun?.deletedAt) {
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
      if (!parentRun) {
        return apiError(404, NOT_FOUND, `File '${fileId}' not found`);
      }
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
      updates.s3Key = `${parentRun.instrumentId}/${parentRun.runId}/${file.filename}`;
    }
    // Reverting a pending request back to detected (watcher cancel): clear
    // upload_requested_at so the row leaves the upload queue, whose filter
    // requires upload_requested_at to be non-null.
    if (body.status === "detected") {
      updates.uploadRequestedAt = null;
    }
    if (body.status === "completed" || body.status === "failed") {
      updates.processedAt = now;
    }
    if (
      body.status === "processing" &&
      (file.status === "completed" || file.status === "failed")
    ) {
      updates.processedAt = null;
      updates.errorMessage = null;
    }
  }

  if (body.content_type !== undefined) {
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
    created_at: updated.createdAt,
    file_created_at: updated.fileCreatedAt,
  });
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/files/:fileId
//
// Soft-delete for dismissing individual detected/upload_requested files from
// the UI. Files that have already been uploaded to S3 (status "uploaded" or
// later) cannot be dismissed here — use the run-level DELETE instead.
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

  const result = await dismissFile(numericId);

  if (!result.ok) {
    return apiErrorFromResult(result);
  }

  return Response.json({
    id: result.id,
    filename: result.filename,
    deleted_at: result.deletedAt,
    already_applied: result.alreadyApplied,
  });
}
