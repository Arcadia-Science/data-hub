import type { NextRequest } from "next/server";
import { authorize } from "@/lib/api/auth";
import { apiError, NOT_FOUND, VALIDATION_ERROR } from "@/lib/api/errors";
import { lookupFileForDownload } from "@/lib/api/files";
import { embedDownloadOptions, getPresignedDownloadUrl } from "@/lib/s3";

interface RouteContext {
  params: Promise<{ fileId: string }>;
}

// ---------------------------------------------------------------------------
// GET /api/v1/files/:fileId/download
//
// Generates a short-lived pre-signed S3 URL and issues a 302 redirect.
// This avoids exposing raw S3 URLs in the web UI's HTML while still
// allowing direct browser downloads.
//
// `?disposition=inline` signs the URL so S3 returns the file as a renderable
// document. Needed for PDF iframes: watcher uploads of `.PDF` often store
// `binary/octet-stream`, which browsers download instead of displaying.
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

  const file = await lookupFileForDownload(numericId);
  if (!file.ok) {
    if (file.reason === "not_uploaded") {
      return apiError(404, NOT_FOUND, "File has not been uploaded to S3 yet");
    }
    return apiError(404, NOT_FOUND, `File '${fileId}' not found`);
  }

  const inline =
    new URL(request.url).searchParams.get("disposition") === "inline";
  const url = await getPresignedDownloadUrl(
    file.s3Bucket,
    file.s3Key,
    inline ? embedDownloadOptions(file.filename, file.contentType) : {}
  );

  return new Response(null, {
    status: 302,
    headers: { Location: url },
  });
}
