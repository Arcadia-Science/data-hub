import type { NextRequest } from "next/server";
import { actorRefFromAuth } from "@/lib/api/actor";
import { authorize } from "@/lib/api/auth";
import { apiErrorFromResult } from "@/lib/api/errors";
import { deleteRunFiles } from "@/lib/api/file-batch";
import { deleteResultToWire, linkedDeleteToWire } from "@/lib/api/file-wire";
import { fileActionBody, readJsonBody } from "@/lib/api/openapi";
import { readRunIdParam } from "@/lib/api/run-id-param";
import { enforceWatcherTokenInstrument } from "@/lib/api/watchers";

interface RouteContext {
  params: Promise<{ instrumentId: string; runId: string }>;
}

// ---------------------------------------------------------------------------
// POST /api/v1/instruments/:instrumentId/runs/:runId/files/delete
//
// Soft-deletes up to 100 files of one run. Body: { file_ids: [...],
// include_linked?: boolean }. Answers 200 with a result for each file, in the
// order sent, so a file that can't be deleted (not found, still processing, or
// in a deleted run) doesn't stop the others. An ID that isn't a file of this
// run is not found. With `include_linked`, the files linked to the requested
// ones go too, which `linked` lists. 404 only when the run doesn't exist. A
// POST rather than a DELETE with a body, which some proxies and clients drop.
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

  const result = await deleteRunFiles({
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
    results: result.results.map(deleteResultToWire),
    linked: result.linked.map(linkedDeleteToWire),
    counts: {
      deleted: result.counts.deleted,
      already_deleted: result.counts.alreadyDeleted,
      failed: result.counts.failed,
    },
  });
}
