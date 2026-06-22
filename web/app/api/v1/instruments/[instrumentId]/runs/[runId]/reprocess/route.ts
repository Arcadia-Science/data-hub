import { and, eq, inArray, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { authorize } from "@/lib/api/auth";
import { apiError, CONFLICT, NOT_FOUND } from "@/lib/api/errors";
import { reprocessFile } from "@/lib/api/file-reprocessing";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import { db } from "@/lib/db";
import { files } from "@/lib/db/schema";

type RouteContext = {
  params: Promise<{ instrumentId: string; runId: string }>;
};

const REPROCESSABLE_STATUSES = ["completed", "failed"] as const;

// ---------------------------------------------------------------------------
// POST /api/v1/instruments/:instrumentId/runs/:runId/reprocess
//
// Run-level convenience endpoint that reprocesses every `completed` or
// `failed` file on the run. Used by the runs list row/bulk actions. Each
// eligible file is handed off to the shared `reprocessFile()` helper which
// enforces per-file state-machine validation and schedules the Lambda
// invocation via `after()`.
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

  if (run.deletedAt) {
    return apiError(409, CONFLICT, "Cannot reprocess a soft-deleted run");
  }

  const eligible = await db
    .select({ id: files.id })
    .from(files)
    .where(
      and(
        eq(files.instrumentRunId, run.id),
        inArray(files.status, [...REPROCESSABLE_STATUSES]),
        isNull(files.deletedAt)
      )
    );

  if (eligible.length === 0) {
    return Response.json({
      instrument_id: run.instrumentId,
      run_id: run.runId,
      files_queued: 0,
      files_failed: 0,
    });
  }

  // Fan out per-file through the shared helper so each file goes through the
  // same state-machine checks and Lambda invocation the per-file endpoint
  // uses. Failures are collected into the response but don't abort the batch.
  const results = await Promise.all(eligible.map((f) => reprocessFile(f.id)));

  const queued = results.filter((r) => r.ok).length;
  const failed = results.length - queued;

  return Response.json({
    instrument_id: run.instrumentId,
    run_id: run.runId,
    files_queued: queued,
    files_failed: failed,
  });
}
