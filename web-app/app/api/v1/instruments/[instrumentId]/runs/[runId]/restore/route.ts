import { authenticateRequest } from "@/lib/api/auth";
import { apiError, CONFLICT, NOT_FOUND, UNAUTHORIZED } from "@/lib/api/errors";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import { db } from "@/lib/db";
import { instrumentRuns } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

type RouteContext = {
  params: Promise<{ instrumentId: string; runId: string }>;
};

// ---------------------------------------------------------------------------
// POST /api/v1/instruments/:instrumentId/runs/:runId/restore
//
// Restores a soft-deleted run by clearing deleted_at. Rejects if the run was
// never deleted (409) or if S3 objects have already been purged (409).
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authResult = await authenticateRequest(request);
  if (!authResult) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
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

  // After the 30-day retention window, a background job permanently removes S3
  // objects and sets filesPurgedAt. At that point the run is unrecoverable.
  if (run.filesPurgedAt) {
    return apiError(
      409,
      CONFLICT,
      "Cannot restore a run whose files have been permanently purged"
    );
  }

  await db
    .update(instrumentRuns)
    .set({ deletedAt: null })
    .where(eq(instrumentRuns.id, run.id));

  const restored = await lookupRunByNaturalKey(instrumentId, runId);

  return Response.json({
    id: restored!.id,
    instrument_id: restored!.instrumentId,
    run_id: restored!.runId,
    deleted_at: restored!.deletedAt,
  });
}
