import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { authorize } from "@/lib/api/auth";
import {
  apiError,
  CONFLICT,
  NOT_FOUND,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import { dismissFile } from "@/lib/api/files";
import { db } from "@/lib/db";
import { files, instrumentRuns } from "@/lib/db/schema";

interface RouteContext {
  params: Promise<{ fileId: string }>;
}

// Enforced state machine for file status transitions:
//   Watcher flow:   detected → [upload_requested →] uploaded → processing → completed|failed
//   Lambda flow:    (created as "uploaded" via POST .../files) → processing → completed|failed
//   Reprocessing:   completed|failed → processing → completed|failed
//   Cancel request: upload_requested → detected (watcher gave up locating
//                   the local file after repeated polls; clears the queue
//                   entry — see ENG-1397)
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

  // Verify the parent run is not soft-deleted.
  const [parentRun] = await db
    .select({ deletedAt: instrumentRuns.deletedAt })
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

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return apiError(400, VALIDATION_ERROR, "Invalid JSON body");
  }

  const updates: Record<string, unknown> = {};
  const now = new Date();

  // Status transition validation.
  if ("status" in body && typeof body.status === "string") {
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

  // S3 info — set when transitioning to "uploaded" (watcher path).
  if (typeof body.s3_bucket === "string") {
    updates.s3Bucket = body.s3_bucket;
  }
  if (typeof body.s3_key === "string") {
    updates.s3Key = body.s3_key;
  }
  if (typeof body.content_type === "string") {
    updates.contentType = body.content_type;
  }
  if (typeof body.size_bytes === "number") {
    updates.sizeBytes = body.size_bytes;
  }

  // Metadata — flat JSON object set by the Lambda after processing.
  if (
    "metadata" in body &&
    typeof body.metadata === "object" &&
    body.metadata !== null &&
    !Array.isArray(body.metadata)
  ) {
    updates.metadata = body.metadata;
  }

  // Error message — set when status transitions to "failed".
  if (typeof body.error_message === "string") {
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
    const code = result.code === "NOT_FOUND" ? NOT_FOUND : CONFLICT;
    return apiError(result.status, code, result.message);
  }

  return Response.json({
    id: result.id,
    filename: result.filename,
    deleted_at: result.deletedAt,
  });
}
