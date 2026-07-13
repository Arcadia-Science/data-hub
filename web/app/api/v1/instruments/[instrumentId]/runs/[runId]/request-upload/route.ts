import type { NextRequest } from "next/server";
import { authorize } from "@/lib/api/auth";
import {
  apiError,
  CONFLICT,
  NOT_FOUND,
  VALIDATION_ERROR,
  WATCHER_OFFLINE,
} from "@/lib/api/errors";
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

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return apiError(400, VALIDATION_ERROR, "Invalid JSON body");
  }

  // Pass raw ids through; `requestRunUploads` fails closed on non-integers.
  // Filtering here would silently drop bad entries and queue the rest.
  const fileIds: unknown[] = Array.isArray(body.file_ids) ? body.file_ids : [];

  const result = await requestRunUploads({ instrumentId, runId, fileIds });

  if (!result.ok) {
    if (result.code === "NOT_FOUND") {
      return apiError(result.status, NOT_FOUND, result.message);
    }
    if (result.code === "WATCHER_OFFLINE") {
      return apiError(result.status, WATCHER_OFFLINE, result.message);
    }
    if (result.code === "CONFLICT") {
      return apiError(result.status, CONFLICT, result.message);
    }
    return apiError(result.status, VALIDATION_ERROR, result.message);
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
