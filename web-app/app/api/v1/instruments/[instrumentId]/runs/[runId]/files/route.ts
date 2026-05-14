import { authenticateRequest } from "@/lib/api/auth";
import {
  apiError,
  CONFLICT,
  NOT_FOUND,
  UNAUTHORIZED,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import { requireScope } from "@/lib/api/scopes";
import { db } from "@/lib/db";
import { files } from "@/lib/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";

// Statuses where a row is "pre-S3" — safe for the Lambda path to overwrite
// when adopting a watcher-created row. Anything beyond uploaded is left
// untouched so Lambda retries don't regress in-progress / completed work.
const PRE_UPLOAD_STATUSES = new Set(["detected", "upload_requested"]);

type RouteContext = {
  params: Promise<{ instrumentId: string; runId: string }>;
};

// ---------------------------------------------------------------------------
// POST /api/v1/instruments/:instrumentId/runs/:runId/files
//
// Creates a file record with S3 info — this is the Lambda path. The file
// starts in "uploaded" status because the Lambda already has the file in S3
// by the time it calls this endpoint.
//
// Idempotent on s3_key: if a file with the same key already exists (partial
// unique index), returns the existing record with 200 instead of 201.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authResult = await authenticateRequest(request);
  if (!authResult) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }
  const scopeError = requireScope(authResult, "files:write");
  if (scopeError) return scopeError;

  const { instrumentId, runId } = await params;
  const run = await lookupRunByNaturalKey(instrumentId, runId);

  if (!run) {
    return apiError(
      404,
      NOT_FOUND,
      `Run '${runId}' not found for instrument '${instrumentId}'`
    );
  }

  if (run.deletedAt) {
    return apiError(409, CONFLICT, "Cannot add files to a soft-deleted run");
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return apiError(400, VALIDATION_ERROR, "Invalid JSON body");
  }

  const s3Bucket =
    typeof body.s3_bucket === "string" ? body.s3_bucket.trim() : "";
  const s3Key = typeof body.s3_key === "string" ? body.s3_key.trim() : "";
  const filename =
    typeof body.filename === "string" ? body.filename.trim() : "";

  if (!s3Bucket || !s3Key || !filename) {
    return apiError(
      400,
      VALIDATION_ERROR,
      "s3_bucket, s3_key, and filename are required"
    );
  }

  const contentType =
    typeof body.content_type === "string" ? body.content_type : null;
  const sizeBytes =
    typeof body.size_bytes === "number" ? body.size_bytes : null;
  const category =
    body.category === "processed" ? ("processed" as const) : ("raw" as const);

  const now = new Date();

  // Reconcile against any active row the watcher may have already created
  // for this file. Both writers now share the partial unique index on
  // (instrument_run_id, filename) WHERE deleted_at IS NULL, so we look up
  // by that key and adopt the existing row in place rather than inserting
  // a parallel one. Without this, a watcher-reported "detected" row would
  // be left orphaned forever after the Lambda fired.
  const [existing] = await db
    .select()
    .from(files)
    .where(
      and(
        eq(files.instrumentRunId, run.id),
        eq(files.filename, filename),
        isNull(files.deletedAt)
      )
    )
    .limit(1);

  if (existing) {
    if (PRE_UPLOAD_STATUSES.has(existing.status)) {
      const [updated] = await db
        .update(files)
        .set({
          s3Bucket,
          s3Key,
          contentType,
          sizeBytes,
          // Honour the Lambda-supplied category when adopting a row. The
          // watcher always inserts with the default ("raw"), so without
          // this the insert vs. reconcile branches would diverge for
          // Lambda-classified processed files.
          category,
          status: "uploaded",
          uploadedAt: now,
        })
        .where(eq(files.id, existing.id))
        .returning();

      return Response.json(formatFileResponse(updated), { status: 200 });
    }

    // Already uploaded / processing / completed / failed: Lambda is calling
    // again (likely a retry after a warm-container timeout). Don't regress
    // status — return the existing record as-is.
    return Response.json(formatFileResponse(existing), { status: 200 });
  }

  // No matching row yet — insert one. Set relativePath = filename so that
  // future watcher reports also dedup against this row via the existing
  // (instrument_run_id, relative_path) partial unique index. The
  // onConflictDoNothing() guards against concurrent retries that race past
  // the lookup above.
  const [inserted] = await db
    .insert(files)
    .values({
      instrumentRunId: run.id,
      relativePath: filename,
      s3Bucket,
      s3Key,
      filename,
      contentType,
      sizeBytes,
      category,
      status: "uploaded",
      uploadedAt: now,
    })
    .onConflictDoNothing()
    .returning();

  if (!inserted) {
    // Another concurrent insert won — fetch and return that row. Look up
    // by s3_key first (the most specific dedup key here) and fall back to
    // the (run, filename) key.
    const [raced] = await db
      .select()
      .from(files)
      .where(eq(files.s3Key, s3Key))
      .limit(1);

    if (raced) {
      return Response.json(formatFileResponse(raced), { status: 200 });
    }

    const [racedByName] = await db
      .select()
      .from(files)
      .where(
        and(
          eq(files.instrumentRunId, run.id),
          eq(files.filename, filename),
          isNull(files.deletedAt)
        )
      )
      .limit(1);

    return Response.json(formatFileResponse(racedByName), { status: 200 });
  }

  return Response.json(formatFileResponse(inserted), { status: 201 });
}

function formatFileResponse(f: typeof files.$inferSelect) {
  return {
    id: f.id,
    instrument_run_id: f.instrumentRunId,
    relative_path: f.relativePath,
    s3_bucket: f.s3Bucket,
    s3_key: f.s3Key,
    filename: f.filename,
    content_type: f.contentType,
    size_bytes: f.sizeBytes,
    category: f.category,
    status: f.status,
    metadata: f.metadata,
    error_message: f.errorMessage,
    uploaded_at: f.uploadedAt,
    processed_at: f.processedAt,
    created_at: f.createdAt,
    file_created_at: f.fileCreatedAt,
  };
}
