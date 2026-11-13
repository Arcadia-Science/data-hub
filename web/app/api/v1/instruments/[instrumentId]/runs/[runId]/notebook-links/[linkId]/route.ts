import type { NextRequest } from "next/server";
import {
  type SurfaceEvent,
  surfaceEvent,
  trackEvent,
} from "@/lib/analytics/track";
import { type ActorRef, actorRefFromAuth } from "@/lib/api/actor";
import { authorize } from "@/lib/api/auth";
import { apiError, apiErrorFromResult, NOT_FOUND } from "@/lib/api/errors";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import { readJsonBody, updateNotebookLinkBody } from "@/lib/api/openapi";
import { readRunIdParam } from "@/lib/api/run-id-param";
import { notebookLinkToWire } from "@/lib/api/run-notebook-link-wire";
import {
  removeNotebookLink,
  updateNotebookLink,
} from "@/lib/api/run-notebook-links";
import { isValidUUID } from "@/lib/api/validators";
import { blankLabelToNull } from "@/lib/notebook-links/url";

interface RouteContext {
  params: Promise<{ instrumentId: string; runId: string; linkId: string }>;
}

type PreflightResult =
  | {
      kind: "ok";
      actor: ActorRef;
      analytics: SurfaceEvent;
      linkId: string;
      runInternalId: string;
    }
  | { kind: "error"; response: Response };

// Shared by PATCH and DELETE: both change a link, so both need `runs:link`.
// Whether the run is deleted, and whether the link belongs to it, is checked
// again inside the write, under a lock on the run.
async function preflight(
  request: NextRequest,
  params: RouteContext["params"]
): Promise<PreflightResult> {
  const authResult = await authorize(request, "runs:link");
  if (authResult instanceof Response) {
    return { kind: "error", response: authResult };
  }

  const { instrumentId, runId: runIdParam, linkId } = await params;
  const runId = readRunIdParam(request.headers, runIdParam);
  const run = await lookupRunByNaturalKey(instrumentId, runId);
  if (!run) {
    return {
      kind: "error",
      response: apiError(
        404,
        NOT_FOUND,
        `Run '${runId}' not found for instrument '${instrumentId}'`
      ),
    };
  }
  if (!isValidUUID(linkId)) {
    return {
      kind: "error",
      response: apiError(404, NOT_FOUND, "Notebook link not found"),
    };
  }

  return {
    kind: "ok",
    actor: actorRefFromAuth(authResult),
    analytics: surfaceEvent(authResult),
    linkId,
    runInternalId: run.id,
  };
}

// ---------------------------------------------------------------------------
// PATCH /api/v1/.../notebook-links/:linkId
//
// Edit a link's URL, label, or both. Anyone with `runs:link` can edit any
// link. A null or blank label clears it; leaving `label` out keeps it.
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const pre = await preflight(request, params);
  if (pre.kind === "error") {
    return pre.response;
  }

  const payload = await readJsonBody(request, updateNotebookLinkBody);
  if (payload instanceof Response) {
    return payload;
  }

  const result = await updateNotebookLink({
    runInternalId: pre.runInternalId,
    linkId: pre.linkId,
    url: payload.url,
    label:
      payload.label === undefined
        ? undefined
        : blankLabelToNull(payload.label ?? ""),
    actor: pre.actor,
  });
  if (!result.ok) {
    return apiErrorFromResult(result);
  }

  trackEvent("notebook_link_edited", pre.analytics);

  return Response.json(notebookLinkToWire(result.value));
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/.../notebook-links/:linkId
//
// Delete a link for good. Removing it again returns 404.
// ---------------------------------------------------------------------------

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const pre = await preflight(request, params);
  if (pre.kind === "error") {
    return pre.response;
  }

  const result = await removeNotebookLink({
    runInternalId: pre.runInternalId,
    linkId: pre.linkId,
  });
  if (!result.ok) {
    return apiErrorFromResult(result);
  }

  trackEvent("notebook_link_removed", { ...pre.analytics, runs: 1 });

  return Response.json({ id: result.value.id, deleted: true });
}
