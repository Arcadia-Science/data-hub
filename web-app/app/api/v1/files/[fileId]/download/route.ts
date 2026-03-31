import { authenticateRequest } from "@/lib/api/auth";
import { apiError, NOT_FOUND, UNAUTHORIZED } from "@/lib/api/errors";
import { db } from "@/lib/db";
import { files } from "@/lib/db/schema";
import { getPresignedDownloadUrl } from "@/lib/s3";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

type RouteContext = {
  params: Promise<{ fileId: string }>;
};

// ---------------------------------------------------------------------------
// GET /api/v1/files/:fileId/download
//
// Generates a short-lived pre-signed S3 URL and issues a 302 redirect.
// This avoids exposing raw S3 URLs in the web UI's HTML while still
// allowing direct browser downloads.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest, { params }: RouteContext) {
  const authResult = await authenticateRequest(request);
  if (!authResult) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }

  const { fileId } = await params;
  const numericId = parseInt(fileId, 10);
  if (isNaN(numericId)) {
    return apiError(404, NOT_FOUND, "Invalid file ID");
  }

  const [file] = await db
    .select({
      s3Bucket: files.s3Bucket,
      s3Key: files.s3Key,
    })
    .from(files)
    .where(eq(files.id, numericId))
    .limit(1);

  if (!file) {
    return apiError(404, NOT_FOUND, `File '${fileId}' not found`);
  }

  if (!file.s3Bucket || !file.s3Key) {
    return apiError(404, NOT_FOUND, "File has not been uploaded to S3 yet");
  }

  const url = await getPresignedDownloadUrl(file.s3Bucket, file.s3Key);

  return new Response(null, {
    status: 302,
    headers: { Location: url },
  });
}
