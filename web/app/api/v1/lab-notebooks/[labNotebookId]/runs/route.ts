import type { NextRequest } from "next/server";
import { surfaceEvent, trackEvent } from "@/lib/analytics/track";
import { actorRefFromAuth } from "@/lib/api/actor";
import { authorize } from "@/lib/api/auth";
import { apiErrorFromResult } from "@/lib/api/errors";
import { runKeysFromBody } from "@/lib/api/notebook-routes";
import { runOutcomesToWire } from "@/lib/api/notebook-wire";
import { ADD_RUN_OUTCOMES, addRunsToNotebook } from "@/lib/api/notebooks";
import { notebookRunsBody, readJsonBody } from "@/lib/api/openapi";
import { enforceWatcherTokenInstrument } from "@/lib/api/watchers";

interface RouteContext {
  params: Promise<{ labNotebookId: string }>;
}

// ---------------------------------------------------------------------------
// POST /api/v1/lab-notebooks/:labNotebookId/runs
//
// Add runs to a notebook. Body: { runs: [{ instrument_id, run_id }] }. The
// runs can belong to different instruments. Reports an outcome for each run
// instead of failing the whole request: runs already in the notebook stay as
// they are, and runs that are deleted, missing, or already in the most
// notebooks allowed are skipped. 409 when the notebook is deleted.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "lab-notebooks:write");
  if (authResult instanceof Response) {
    return authResult;
  }

  const payload = await readJsonBody(request, notebookRunsBody);
  if (payload instanceof Response) {
    return payload;
  }

  // A watcher's token may change only its own instrument's runs, so one
  // run on another instrument refuses the whole request.
  const denied = await enforceWatcherTokenInstrument(
    authResult,
    payload.runs.map((run) => run.instrument_id)
  );
  if (denied) {
    return denied;
  }

  const { labNotebookId: notebookId } = await params;
  const result = await addRunsToNotebook({
    notebookId,
    runs: runKeysFromBody(payload.runs),
    actor: actorRefFromAuth(authResult),
  });
  if (!result.ok) {
    return apiErrorFromResult(result);
  }

  const wire = runOutcomesToWire(ADD_RUN_OUTCOMES, result.value);
  if (wire.counts.added > 0) {
    trackEvent("notebook_runs_added", {
      ...surfaceEvent(authResult),
      runs: wire.counts.added,
    });
  }

  return Response.json(wire);
}
