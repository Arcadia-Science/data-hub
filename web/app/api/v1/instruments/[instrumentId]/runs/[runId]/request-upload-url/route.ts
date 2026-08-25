import { and, eq, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { authorizeToken } from "@/lib/api/auth";
import {
  apiError,
  CONFLICT,
  INTERNAL_ERROR,
  NOT_FOUND,
} from "@/lib/api/errors";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import { readJsonBody, requestUploadUrlBody } from "@/lib/api/openapi";
import { db } from "@/lib/db";
import { files } from "@/lib/db/schema";
import { getPresignedUploadUrl, getS3RawDataBucket } from "@/lib/s3";

interface RouteContext {
  params: Promise<{ instrumentId: string; runId: string }>;
}

const UPLOAD_URL_EXPIRY_SECONDS = 60 * 60; // 1 hour

const UPLOADED_OR_LATER_STATUSES = new Set([
  "uploaded",
  "processing",
  "completed",
  "failed",
]);

// ---------------------------------------------------------------------------
// POST /api/v1/instruments/:instrumentId/runs/:runId/request-upload-url
//
// Returns a presigned S3 PUT URL so the watcher can upload a file without
// needing AWS credentials. Creates a file record if one doesn't already exist.
// Short-circuits with `already_uploaded: true` when the file has already
// reached S3.
//
// PAT-only: session `*` would let any member mint a presigned PUT for the
// canonical raw-data key. The dashboard queues uploads via `request-upload`.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorizeToken(request, "runs:upload");
  if (authResult instanceof Response) {
    return authResult;
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
    return apiError(409, CONFLICT, "Cannot upload files to a soft-deleted run");
  }

  const body = await readJsonBody(request, requestUploadUrlBody);
  if (body instanceof Response) {
    return body;
  }

  const filename = body.filename;
  const contentType = body.content_type;
  const sizeBytes = body.size_bytes;
  const fileCreatedAt = body.file_created_at
    ? new Date(body.file_created_at)
    : null;

  // Look up existing file record by run + filename.  The file may have been
  // created by report_run with a full relative_path (e.g. "EXP-001/data.csv"),
  // but the watcher only sends the bare filename for upload requests.
  const [existingFile] = await db
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

  if (existingFile && UPLOADED_OR_LATER_STATUSES.has(existingFile.status)) {
    return Response.json({
      already_uploaded: true,
      file_id: existingFile.id,
      s3_bucket: existingFile.s3Bucket,
      s3_key: existingFile.s3Key,
    });
  }

  let s3Bucket: string;
  try {
    s3Bucket = getS3RawDataBucket();
  } catch {
    return apiError(500, INTERNAL_ERROR, "S3 bucket configuration is missing");
  }

  const s3Key = `${instrumentId}/${runId}/${filename}`;

  let fileId: number;

  if (existingFile) {
    // File exists in detected / upload_requested — reuse the record.
    fileId = existingFile.id;
    // Backfill file_created_at if the watcher started reporting it after
    // the row was first inserted (e.g. a queue-mode upload following an
    // earlier detected_files report that predated this column).
    if (fileCreatedAt && !existingFile.fileCreatedAt) {
      await db
        .update(files)
        .set({ fileCreatedAt })
        .where(eq(files.id, existingFile.id));
    }
  } else {
    const now = new Date();
    const [inserted] = await db
      .insert(files)
      .values({
        instrumentRunId: run.id,
        relativePath: filename,
        filename,
        contentType: contentType ?? null,
        sizeBytes: sizeBytes ?? null,
        status: "detected",
        detectedAt: now,
        fileCreatedAt,
      })
      .returning({ id: files.id });

    fileId = inserted.id;
  }

  const uploadUrl = await getPresignedUploadUrl(
    s3Bucket,
    s3Key,
    contentType,
    UPLOAD_URL_EXPIRY_SECONDS
  );

  return Response.json({
    upload_url: uploadUrl,
    s3_bucket: s3Bucket,
    s3_key: s3Key,
    file_id: fileId,
    expires_in: UPLOAD_URL_EXPIRY_SECONDS,
    already_uploaded: false,
  });
}
