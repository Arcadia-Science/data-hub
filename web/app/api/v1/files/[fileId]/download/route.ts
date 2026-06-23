import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { authorize } from "@/lib/api/auth";
import { apiError, NOT_FOUND, VALIDATION_ERROR } from "@/lib/api/errors";
import { db } from "@/lib/db";
import { files, instrumentRuns } from "@/lib/db/schema";
import { getPresignedDownloadUrl } from "@/lib/s3";

interface RouteContext {
  params: Promise<{ fileId: string }>;
}

// ---------------------------------------------------------------------------
// GET /api/v1/files/:fileId/download
//
// Generates a short-lived pre-signed S3 URL and issues a 302 redirect.
// This avoids exposing raw S3 URLs in the web UI's HTML while still
// allowing direct browser downloads.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "files:read");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { fileId } = await params;
  const numericId = Number.parseInt(fileId, 10);
  if (Number.isNaN(numericId)) {
    return apiError(400, VALIDATION_ERROR, "Invalid file ID");
  }

  const [file] = await db
    .select({
      s3Bucket: files.s3Bucket,
      s3Key: files.s3Key,
      deletedAt: files.deletedAt,
      instrumentRunId: files.instrumentRunId,
    })
    .from(files)
    .where(eq(files.id, numericId))
    .limit(1);

  if (!file) {
    return apiError(404, NOT_FOUND, `File '${fileId}' not found`);
  }

  if (file.deletedAt) {
    return apiError(404, NOT_FOUND, `File '${fileId}' not found`);
  }

  const [parentRun] = await db
    .select({ deletedAt: instrumentRuns.deletedAt })
    .from(instrumentRuns)
    .where(eq(instrumentRuns.id, file.instrumentRunId))
    .limit(1);

  if (parentRun?.deletedAt) {
    return apiError(404, NOT_FOUND, `File '${fileId}' not found`);
  }

  if (!(file.s3Bucket && file.s3Key)) {
    return apiError(404, NOT_FOUND, "File has not been uploaded to S3 yet");
  }

  const url = await getPresignedDownloadUrl(file.s3Bucket, file.s3Key);

  return new Response(null, {
    status: 302,
    headers: { Location: url },
  });
}
