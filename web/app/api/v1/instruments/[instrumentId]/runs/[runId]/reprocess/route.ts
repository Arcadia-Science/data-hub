import type { NextRequest } from "next/server";
import { authorize } from "@/lib/api/auth";
import { apiErrorFromResult } from "@/lib/api/errors";
import { reprocessRun } from "@/lib/api/file-reprocessing";

interface RouteContext {
  params: Promise<{ instrumentId: string; runId: string }>;
}

// ---------------------------------------------------------------------------
// POST /api/v1/instruments/:instrumentId/runs/:runId/reprocess
//
// Run-level convenience endpoint that reprocesses every `completed` or
// `failed` file on the run. Used by the runs list row/bulk actions.
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

  return Response.json({
    instrument_id: result.instrumentId,
    run_id: result.runId,
    files_queued: result.filesQueued,
    files_failed: result.filesFailed,
  });
}
