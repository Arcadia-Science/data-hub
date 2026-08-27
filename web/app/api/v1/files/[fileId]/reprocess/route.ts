import type { NextRequest } from "next/server";
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
// Transitions an uploaded, failed, completed, or stalled-processing raw
// file back to "processing" and invokes the Lambda Function URL to re-run
// the instrument's process_file workflow. Processed artifacts are rejected.
// The core logic lives in lib/api/file-reprocessing.ts so the MCP server
// can reuse it.
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

  return Response.json({ status: "processing", file_id: result.fileId });
}
