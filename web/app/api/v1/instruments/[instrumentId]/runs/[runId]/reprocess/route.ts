import type { NextRequest } from "next/server";
import { surfaceEvent, trackEvent } from "@/lib/analytics/track";
import { authorize } from "@/lib/api/auth";
import { apiErrorFromResult } from "@/lib/api/errors";
import { reprocessRun } from "@/lib/api/file-reprocessing";

interface RouteContext {
  params: Promise<{ instrumentId: string; runId: string }>;
}

// ---------------------------------------------------------------------------
// POST /api/v1/instruments/:instrumentId/runs/:runId/reprocess
//
// Run-level convenience endpoint that queues every `uploaded`, `completed`,
// `failed`, or stalled `processing` raw file on the run for reprocessing.
// Each file starts as soon as a processing slot is free, and a file that does
// not start right away waits as `queued`. Processed artifacts are skipped. Used
// by the runs list row/bulk actions.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "runs:reprocess");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { instrumentId, runId } = await params;
  const result = await reprocessRun(instrumentId, runId);

  if (!result.ok) {
    return apiErrorFromResult(result);
  }

  trackEvent("run_reprocessed", {
    ...surfaceEvent(authResult),
  });

  return Response.json({
    instrument_id: result.instrumentId,
    run_id: result.runId,
    files_queued: result.filesQueued,
    files_failed: result.filesFailed,
  });
}
