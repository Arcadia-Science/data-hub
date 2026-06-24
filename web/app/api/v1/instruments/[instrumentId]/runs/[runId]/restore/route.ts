import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { authorize } from "@/lib/api/auth";
import { apiError, CONFLICT, NOT_FOUND } from "@/lib/api/errors";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import { db } from "@/lib/db";
import { instrumentRuns } from "@/lib/db/schema";

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
  const authResult = await authorize(request, "runs:write");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { instrumentId, runId } = await params;
  const run = await lookupRunByNaturalKey(instrumentId, runId);

  if (!run) {
    return apiError(
      404,
      NOT_FOUND,
      `Run '${runId}' not found for instrument '${instrumentId}'`
    );
  }

  if (!run.deletedAt) {
    return apiError(409, CONFLICT, "Run is not deleted — nothing to restore");
  }

  await db
    .update(instrumentRuns)
    .set({ deletedAt: null, deletedBy: null })
    .where(eq(instrumentRuns.id, run.id));

  const restored = await lookupRunByNaturalKey(instrumentId, runId);

  if (!restored) {
    return apiError(
      404,
      NOT_FOUND,
      `Run '${runId}' could not be found after restore`
    );
  }

  return Response.json({
    id: restored.id,
    instrument_id: restored.instrumentId,
    run_id: restored.runId,
    deleted_at: restored.deletedAt,
  });
}
