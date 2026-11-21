import type { NextRequest } from "next/server";
import { actorRefFromAuth } from "@/lib/api/actor";
import { authorize } from "@/lib/api/auth";
import { apiErrorFromResult } from "@/lib/api/errors";
import { restoreRunFiles } from "@/lib/api/file-batch";
import { linkedRestoreToWire, restoreResultToWire } from "@/lib/api/file-wire";
import { fileActionBody, readJsonBody } from "@/lib/api/openapi";
import { readRunIdParam } from "@/lib/api/run-id-param";
import { enforceWatcherTokenInstrument } from "@/lib/api/watchers";

interface RouteContext {
  params: Promise<{ instrumentId: string; runId: string }>;
}

// ---------------------------------------------------------------------------
// POST /api/v1/instruments/:instrumentId/runs/:runId/files/restore
//
// Restores up to 100 deleted files of one run. Body: { file_ids: [...],
// include_linked?: boolean }. Answers 200 with a result for each file, in the
// order sent, so a file that can't come back doesn't stop the others: a file
// whose name or path another file now holds gets a 409 result that names that
// file, and an ID that isn't a file of this run is not found. With
// `include_linked`, the deleted files linked to the requested ones come back
// too, and `linked` lists each with its own result. 404 only when the run
// doesn't exist.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "files:delete");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { instrumentId, runId: runIdParam } = await params;
  const denied = await enforceWatcherTokenInstrument(authResult, instrumentId);
  if (denied) {
    return denied;
  }
  const runId = readRunIdParam(request.headers, runIdParam);

  const body = await readJsonBody(request, fileActionBody);
  if (body instanceof Response) {
    return body;
  }

  const result = await restoreRunFiles({
    instrumentId,
    runId,
    fileIds: body.file_ids,
    includeLinked: body.include_linked ?? false,
    actor: actorRefFromAuth(authResult),
  });
  if (!result.ok) {
    return apiErrorFromResult(result);
  }

  return Response.json({
    instrument_id: result.instrumentId,
    run_id: result.runId,
    results: result.results.map(restoreResultToWire),
    linked: result.linked.map(linkedRestoreToWire),
    counts: {
      restored: result.counts.restored,
      already_restored: result.counts.alreadyRestored,
      failed: result.counts.failed,
    },
  });
}
