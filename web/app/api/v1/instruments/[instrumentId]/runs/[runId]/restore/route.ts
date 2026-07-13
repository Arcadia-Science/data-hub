import type { NextRequest } from "next/server";
import { authorize } from "@/lib/api/auth";
import { apiError, CONFLICT, NOT_FOUND } from "@/lib/api/errors";
import { restoreRun } from "@/lib/api/run-lifecycle";

interface RouteContext {
  params: Promise<{ instrumentId: string; runId: string }>;
}

// ---------------------------------------------------------------------------
// POST /api/v1/instruments/:instrumentId/runs/:runId/restore
//
// Restores a soft-deleted run by clearing deleted_at. Rejects with 409 if the
// run was never deleted. Data Hub never hard-deletes runs or S3 objects, so
// restore always succeeds for a previously soft-deleted run.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "runs:delete");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { instrumentId, runId } = await params;
  const result = await restoreRun(instrumentId, runId);

  if (!result.ok) {
    const code = result.code === "NOT_FOUND" ? NOT_FOUND : CONFLICT;
    return apiError(result.status, code, result.message);
  }

  return Response.json({
    id: result.id,
    instrument_id: result.instrumentId,
    run_id: result.runId,
    deleted_at: result.deletedAt,
  });
}
