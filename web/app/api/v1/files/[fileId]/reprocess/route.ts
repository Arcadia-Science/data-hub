import type { NextRequest } from "next/server";
import { authorize } from "@/lib/api/auth";
import { apiError, VALIDATION_ERROR } from "@/lib/api/errors";
import { reprocessFile } from "@/lib/api/file-reprocessing";

interface RouteContext {
  params: Promise<{ fileId: string }>;
}

// ---------------------------------------------------------------------------
// POST /api/v1/files/:fileId/reprocess
//
// Transitions a failed or completed file back to "processing" and invokes
// the Lambda Function URL to re-run the instrument's process_file workflow.
// The core logic lives in lib/api/file-reprocessing.ts so the MCP server
// can reuse it.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "files:write");
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
    // ReprocessResult.code is the literal union ("NOT_FOUND" | "CONFLICT" |
    // "INTERNAL_ERROR") which matches the string values of the NOT_FOUND /
    // CONFLICT / INTERNAL_ERROR constants, so it can be passed straight
    // through to apiError.
    return apiError(result.status, result.code, result.message, result.details);
  }

  return Response.json({ status: "processing", file_id: result.fileId });
}
