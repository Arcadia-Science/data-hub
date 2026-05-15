import { authorize } from "@/lib/api/auth";
import { apiError, CONFLICT, NOT_FOUND } from "@/lib/api/errors";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import { db } from "@/lib/db";
import { files, instrumentRuns } from "@/lib/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";

type RouteContext = {
  params: Promise<{ instrumentId: string; runId: string }>;
};

// ---------------------------------------------------------------------------
// POST /api/v1/instruments/:instrumentId/runs/:runId/request-upload-all
//
// Run-level convenience endpoint that transitions every `detected` file on
// the run to `upload_requested`. Used by the runs list row/bulk actions where
// the client has no file IDs to pass. Idempotent — files already queued are
// left alone.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "runs:write");
  if (authResult instanceof Response) return authResult;

  const { instrumentId, runId } = await params;
  const run = await lookupRunByNaturalKey(instrumentId, runId);

  if (!run) {
    return apiError(
      404,
      NOT_FOUND,
      `Run '${runId}' not found for instrument '${instrumentId}'`
    );
  }

  if (run.deletedAt) {
    return apiError(
      409,
      CONFLICT,
      "Cannot request uploads for a soft-deleted run"
    );
  }

  const now = new Date();

  // Update all active, still-detected files for this run in a single query.
  // Files already in `upload_requested` or past it are untouched, so the
  // endpoint is safe to retry.
  const updated = await db
    .update(files)
    .set({ status: "upload_requested", uploadRequestedAt: now })
    .where(
      and(
        eq(files.instrumentRunId, run.id),
        eq(files.status, "detected"),
        isNull(files.deletedAt)
      )
    )
    .returning({ id: files.id });

  if (updated.length > 0) {
    await db
      .update(instrumentRuns)
      .set({ updatedAt: now })
      .where(eq(instrumentRuns.id, run.id));
  }

  return Response.json({
    instrument_id: run.instrumentId,
    run_id: run.runId,
    files_queued: updated.length,
  });
}
