import type { NextRequest } from "next/server";
import { authorize } from "@/lib/api/auth";
import { apiErrorFromResult } from "@/lib/api/errors";
import { readJsonBody, requestUploadBody } from "@/lib/api/openapi";
import { requestRunUploads } from "@/lib/api/run-uploads";

interface RouteContext {
  params: Promise<{ instrumentId: string; runId: string }>;
}

// ---------------------------------------------------------------------------
// POST /api/v1/instruments/:instrumentId/runs/:runId/request-upload
//
// Transitions detected files to upload_requested status. Called by the web UI
// when a user selects files (or an entire run) to upload.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "runs:upload");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { instrumentId, runId } = await params;

  const body = await readJsonBody(request, requestUploadBody);
  if (body instanceof Response) {
    return body;
  }

  // Pass raw ids through; `requestRunUploads` fails closed on non-integers.
  // Filtering here would silently drop bad entries and queue the rest.
  const fileIds = body.file_ids;

  const result = await requestRunUploads({ instrumentId, runId, fileIds });

  if (!result.ok) {
    return apiErrorFromResult(result);
  }

  return Response.json({
    instrument_id: result.instrumentId,
    run_id: result.runId,
    files_queued: result.filesQueued,
    files: result.files?.map((f) => ({
      id: f.id,
      filename: f.filename,
      upload_requested_at: f.uploadRequestedAt,
    })),
  });
}
