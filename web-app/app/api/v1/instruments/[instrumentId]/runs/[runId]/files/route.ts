import { authenticateRequest } from "@/lib/api/auth";
import {
  apiError,
  CONFLICT,
  NOT_FOUND,
  UNAUTHORIZED,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import { db } from "@/lib/db";
import { files } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

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

  // Insert with "uploaded" status — the Lambda already has the file in S3 by
  // the time it calls this endpoint. The partial unique index on s3_key
  // prevents duplicate file records when the Lambda retries after a timeout.
  const [inserted] = await db
    .insert(files)
    .values({
      instrumentRunId: run.id,
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

  // If onConflictDoNothing fired, the row already exists — return it.
  if (!inserted) {
    const [existing] = await db
      .select()
      .from(files)
      .where(eq(files.s3Key, s3Key))
      .limit(1);

    return Response.json(formatFileResponse(existing), { status: 200 });
  }

  return Response.json(formatFileResponse(inserted), { status: 201 });
}

function formatFileResponse(f: typeof files.$inferSelect) {
  return {
    id: f.id,
    instrument_run_id: f.instrumentRunId,
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
