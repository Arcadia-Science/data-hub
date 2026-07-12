import type { NextRequest } from "next/server";
import { authorize } from "@/lib/api/auth";
import {
  apiError,
  CONFLICT,
  NOT_FOUND,
  WATCHER_OFFLINE,
} from "@/lib/api/errors";
import { requestAllRunUploads } from "@/lib/api/run-uploads";

interface RouteContext {
  params: Promise<{ instrumentId: string; runId: string }>;
}

// ---------------------------------------------------------------------------
// POST /api/v1/instruments/:instrumentId/runs/:runId/request-upload-all
//
// Run-level convenience endpoint that transitions every `detected` file on
// the run to `upload_requested`. Used by the runs list row/bulk actions.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "runs:upload");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { instrumentId, runId } = await params;
  const result = await requestAllRunUploads(instrumentId, runId);

  if (!result.ok) {
    if (result.code === "NOT_FOUND") {
      return apiError(result.status, NOT_FOUND, result.message);
    }
    if (result.code === "WATCHER_OFFLINE") {
      return apiError(result.status, WATCHER_OFFLINE, result.message);
    }
    return apiError(result.status, CONFLICT, result.message);
  }

  return Response.json({
    instrument_id: result.instrumentId,
    run_id: result.runId,
    files_queued: result.filesQueued,
  });
}
