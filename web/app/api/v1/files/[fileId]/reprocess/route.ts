import type { NextRequest } from "next/server";
import { surfaceEvent, trackEvent } from "@/lib/analytics/track";
import { authorize } from "@/lib/api/auth";
import {
  apiError,
  apiErrorFromResult,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import { reprocessFile } from "@/lib/api/file-reprocessing";

interface RouteContext {
  params: Promise<{ fileId: string }>;
}

// ---------------------------------------------------------------------------
// POST /api/v1/files/:fileId/reprocess
//
// Queues an uploaded, failed, completed, or stalled-processing raw file for
// reprocessing. The file starts right away ("processing") when a processing
// slot is free, and otherwise waits ("queued") and starts as soon as a slot is
// free. Starting a file invokes the Lambda Function URL to re-run the instrument's
// process_file workflow. Processed artifacts are rejected. The core logic
// lives in lib/api/file-reprocessing.ts so the MCP server can reuse it.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "files:reprocess");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { fileId } = await params;
  const numericId = Number.parseInt(fileId, 10);
  if (Number.isNaN(numericId)) {
    return apiError(400, VALIDATION_ERROR, "Invalid file ID");
  }

  const result = await reprocessFile(numericId);
  if (!result.ok) {
    return apiErrorFromResult(result);
  }

  trackEvent("file_reprocessed", {
    ...surfaceEvent(authResult),
  });

  return Response.json({ status: result.fileStatus, file_id: result.fileId });
}
