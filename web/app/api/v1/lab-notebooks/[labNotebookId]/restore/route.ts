import type { NextRequest } from "next/server";
import { surfaceEvent, trackEvent } from "@/lib/analytics/track";
import { actorRefFromAuth } from "@/lib/api/actor";
import { authorize } from "@/lib/api/auth";
import { apiErrorFromResult } from "@/lib/api/errors";
import { WATCHER_TOKEN_NOTEBOOK_REFUSAL } from "@/lib/api/notebook-routes";
import { notebookToWire } from "@/lib/api/notebook-wire";
import { restoreNotebook } from "@/lib/api/notebooks";
import { refuseWatcherTokenAdmin } from "@/lib/api/watchers";

interface RouteContext {
  params: Promise<{ labNotebookId: string }>;
}

// ---------------------------------------------------------------------------
// POST /api/v1/lab-notebooks/:labNotebookId/restore
//
// Bring back a deleted notebook with the runs it had. 409 when it isn't
// deleted.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "lab-notebooks:write");
  if (authResult instanceof Response) {
    return authResult;
  }

  const refused = await refuseWatcherTokenAdmin(
    authResult,
    WATCHER_TOKEN_NOTEBOOK_REFUSAL
  );
  if (refused) {
    return refused;
  }

  const { labNotebookId: notebookId } = await params;
  const result = await restoreNotebook({
    id: notebookId,
    actor: actorRefFromAuth(authResult),
  });
  if (!result.ok) {
    return apiErrorFromResult(result);
  }

  trackEvent("notebook_restored", surfaceEvent(authResult));

  return Response.json(notebookToWire(result.value));
}
