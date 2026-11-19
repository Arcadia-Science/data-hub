import type { NextRequest } from "next/server";
import { surfaceEvent, trackEvent } from "@/lib/analytics/track";
import { authorize } from "@/lib/api/auth";
import { apiErrorFromResult } from "@/lib/api/errors";
import { runKeysFromBody } from "@/lib/api/notebook-routes";
import { runOutcomesToWire } from "@/lib/api/notebook-wire";
import {
  REMOVE_RUN_OUTCOMES,
  removeRunsFromNotebook,
} from "@/lib/api/notebooks";
import { notebookRunsBody, readJsonBody } from "@/lib/api/openapi";
import { enforceWatcherTokenInstrument } from "@/lib/api/watchers";

interface RouteContext {
  params: Promise<{ labNotebookId: string }>;
}

// ---------------------------------------------------------------------------
// POST /api/v1/lab-notebooks/:labNotebookId/runs/remove
//
// Remove runs from a notebook. Body: { runs: [{ instrument_id, run_id }] }.
// Reports an outcome for each run instead of failing the whole request. The
// notebook stays, even with no runs left. 409 when the notebook is deleted.
// A POST rather than a DELETE with a body, which some proxies and clients
// drop.
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
  const result = await removeRunsFromNotebook({
    notebookId,
    runs: runKeysFromBody(payload.runs),
  });
  if (!result.ok) {
    return apiErrorFromResult(result);
  }

  const wire = runOutcomesToWire(REMOVE_RUN_OUTCOMES, result.value);
  if (wire.counts.removed > 0) {
    trackEvent("notebook_runs_removed", {
      ...surfaceEvent(authResult),
      runs: wire.counts.removed,
    });
  }

  return Response.json(wire);
}
