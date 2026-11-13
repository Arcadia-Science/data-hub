import type { NextRequest } from "next/server";
import { surfaceEvent, trackEvent } from "@/lib/analytics/track";
import { authorize } from "@/lib/api/auth";
import { apiErrorFromResult } from "@/lib/api/errors";
import { cancelQueuedFilesForRun } from "@/lib/api/file-reprocessing";
import { readRunIdParam } from "@/lib/api/run-id-param";

interface RouteContext {
  params: Promise<{ instrumentId: string; runId: string }>;
}

// ---------------------------------------------------------------------------
// POST /api/v1/instruments/:instrumentId/runs/:runId/cancel-queued
//
// Takes every `queued` file of the run out of the reprocessing queue. Each
// file becomes `failed` with a message that says the reprocess was cancelled,
// and can be reprocessed again. Files that already started are left alone.
// Needs the same scope as reprocessing the run, because it undoes that
// request. A soft-deleted run is accepted, so its queued files can be cleared.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "runs:reprocess");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { instrumentId, runId: runIdParam } = await params;
  const runId = readRunIdParam(request.headers, runIdParam);
  const result = await cancelQueuedFilesForRun(instrumentId, runId);

  if (!result.ok) {
    return apiErrorFromResult(result);
  }

  trackEvent("run_queue_cancelled", {
    ...surfaceEvent(authResult),
  });

  return Response.json({
    instrument_id: result.instrumentId,
    run_id: result.runId,
    files_cancelled: result.filesCancelled,
  });
}
