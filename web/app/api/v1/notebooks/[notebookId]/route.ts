import type { NextRequest } from "next/server";
import { surfaceEvent, trackEvent } from "@/lib/analytics/track";
import { actorRefFromAuth } from "@/lib/api/actor";
import { authorize } from "@/lib/api/auth";
import { apiError, apiErrorFromResult, NOT_FOUND } from "@/lib/api/errors";
import {
  ownerFromBody,
  WATCHER_TOKEN_NOTEBOOK_REFUSAL,
} from "@/lib/api/notebook-routes";
import { notebookToWire } from "@/lib/api/notebook-wire";
import {
  deleteNotebook,
  getNotebook,
  updateNotebook,
} from "@/lib/api/notebooks";
import { readJsonBody, updateNotebookBody } from "@/lib/api/openapi";
import { refuseWatcherTokenAdmin } from "@/lib/api/watchers";
import { blankToNull } from "@/lib/notebook-links/url";

interface RouteContext {
  params: Promise<{ notebookId: string }>;
}

// ---------------------------------------------------------------------------
// GET /api/v1/notebooks/:notebookId
//
// One notebook, deleted or not.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "runs:read");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { notebookId } = await params;
  const notebook = await getNotebook(notebookId);
  if (!notebook) {
    return apiError(404, NOT_FOUND, "Notebook not found");
  }

  return Response.json(notebookToWire(notebook));
}

// ---------------------------------------------------------------------------
// PATCH /api/v1/notebooks/:notebookId
//
// Edit a notebook. Body: { name?, description?, owner_id?, url? }. Fields
// left out stay as they are; a null or blank description, or a null owner,
// clears it. A new link must point to a page no other notebook has (409, as
// on create). A deleted notebook can't change until it is restored (409).
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "notebooks:write");
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

  const payload = await readJsonBody(request, updateNotebookBody);
  if (payload instanceof Response) {
    return payload;
  }

  const ownerId = ownerFromBody(authResult, payload.owner_id);
  if (ownerId instanceof Response) {
    return ownerId;
  }

  const { notebookId } = await params;
  const result = await updateNotebook({
    id: notebookId,
    name: payload.name,
    description:
      payload.description === undefined
        ? undefined
        : blankToNull(payload.description ?? ""),
    ownerId,
    url: payload.url,
    actor: actorRefFromAuth(authResult),
  });
  if (!result.ok) {
    return apiErrorFromResult(result);
  }

  trackEvent("notebook_updated", surfaceEvent(authResult));

  return Response.json(notebookToWire(result.value));
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/notebooks/:notebookId
//
// Mark a notebook deleted. Its runs keep their place in it, so restoring it
// brings them back. 409 when it is already deleted.
// ---------------------------------------------------------------------------

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "notebooks:write");
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

  const { notebookId } = await params;
  const result = await deleteNotebook({
    id: notebookId,
    actor: actorRefFromAuth(authResult),
  });
  if (!result.ok) {
    return apiErrorFromResult(result);
  }

  trackEvent("notebook_deleted", surfaceEvent(authResult));

  return Response.json(notebookToWire(result.value));
}
