import type { NextRequest } from "next/server";
import { surfaceEvent, trackEvent } from "@/lib/analytics/track";
import { actorRefFromAuth } from "@/lib/api/actor";
import { authorize } from "@/lib/api/auth";
import { apiError, apiErrorFromResult, NOT_FOUND } from "@/lib/api/errors";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import { createNotebookLinkBody, readJsonBody } from "@/lib/api/openapi";
import { readRunIdParam } from "@/lib/api/run-id-param";
import { notebookLinkToWire } from "@/lib/api/run-notebook-link-wire";
import {
  addNotebookLink,
  listNotebookLinksForRun,
} from "@/lib/api/run-notebook-links";
import { blankLabelToNull } from "@/lib/notebook-links/url";

interface RouteContext {
  params: Promise<{ instrumentId: string; runId: string }>;
}

function runNotFound(instrumentId: string, runId: string) {
  return apiError(
    404,
    NOT_FOUND,
    `Run '${runId}' not found for instrument '${instrumentId}'`
  );
}

// ---------------------------------------------------------------------------
// GET /api/v1/instruments/:instrumentId/runs/:runId/notebook-links
//
// The run's lab notebook links, oldest first. Deleted runs still list theirs.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "runs:read");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { instrumentId, runId: runIdParam } = await params;
  const runId = readRunIdParam(request.headers, runIdParam);
  const run = await lookupRunByNaturalKey(instrumentId, runId);
  if (!run) {
    return runNotFound(instrumentId, runId);
  }

  const links = await listNotebookLinksForRun(run.id);
  return Response.json({ notebook_links: links.map(notebookLinkToWire) });
}

// ---------------------------------------------------------------------------
// POST /api/v1/instruments/:instrumentId/runs/:runId/notebook-links
//
// Add a link. Body: { url, label? }. The caller is recorded as the person or
// token that added it. 409 when the run is deleted, already links to the same
// page, or has the most links allowed.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "runs:link");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { instrumentId, runId: runIdParam } = await params;
  const runId = readRunIdParam(request.headers, runIdParam);
  const run = await lookupRunByNaturalKey(instrumentId, runId);
  if (!run) {
    return runNotFound(instrumentId, runId);
  }

  const payload = await readJsonBody(request, createNotebookLinkBody);
  if (payload instanceof Response) {
    return payload;
  }

  const result = await addNotebookLink({
    runInternalId: run.id,
    url: payload.url,
    label: blankLabelToNull(payload.label ?? ""),
    actor: actorRefFromAuth(authResult),
  });
  if (!result.ok) {
    return apiErrorFromResult(result);
  }

  trackEvent("notebook_link_added", { ...surfaceEvent(authResult), runs: 1 });

  return Response.json(notebookLinkToWire(result.value), { status: 201 });
}
