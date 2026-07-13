import type { NextRequest } from "next/server";
import { authorize } from "@/lib/api/auth";
import { apiErrorFromResult } from "@/lib/api/errors";
import { restoreRun } from "@/lib/api/run-lifecycle";

interface RouteContext {
  params: Promise<{ instrumentId: string; runId: string }>;
}

// ---------------------------------------------------------------------------
// POST /api/v1/instruments/:instrumentId/runs/:runId/restore
//
// Restores a soft-deleted run by clearing deleted_at. Idempotent: restoring a
// run that was never deleted succeeds as a no-op (`already_applied: true`).
// Data Hub never hard-deletes runs or S3 objects, so restore always succeeds
// for a previously soft-deleted run.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "runs:delete");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { instrumentId, runId } = await params;
  const result = await restoreRun(instrumentId, runId);

  if (!result.ok) {
    return apiErrorFromResult(result);
  }

  return Response.json({
    id: result.id,
    instrument_id: result.instrumentId,
    run_id: result.runId,
    deleted_at: result.deletedAt,
    already_applied: result.alreadyApplied,
  });
}
