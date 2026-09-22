import type { NextRequest } from "next/server";
import { authorize } from "@/lib/api/auth";
import { apiError, NOT_FOUND } from "@/lib/api/errors";
import {
  getAttributionsByRunIds,
  lookupRunByNaturalKey,
} from "@/lib/api/instrument-runs";
import { claimRuns, unclaimRuns } from "@/lib/api/run-attributions";

interface RouteContext {
  params: Promise<{ instrumentId: string; runId: string }>;
}

// ---------------------------------------------------------------------------
// PUT /api/v1/instruments/:instrumentId/runs/:runId/attributions/me
//
// Claim a run for the authenticated user. Idempotent: calling twice has the
// same effect as calling once. The authenticated user id is the only user id
// used — the URL carries no user id, so spoofing another user's attribution
// is impossible.
// ---------------------------------------------------------------------------

export async function PUT(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "runs:attribute");
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

  await claimRuns([run.id], authResult.userId);

  const byRun = await getAttributionsByRunIds([run.id]);
  return Response.json(
    { attributions: byRun.get(run.id) ?? [] },
    { status: 200 }
  );
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/instruments/:instrumentId/runs/:runId/attributions/me
//
// Remove the authenticated user's attribution from this run. Idempotent:
// deleting when no attribution exists is a no-op. Server-side enforcement of
// "self only" — the query always uses session.user.id.
// ---------------------------------------------------------------------------

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "runs:attribute");
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

  await unclaimRuns([run.id], authResult.userId);

  const byRun = await getAttributionsByRunIds([run.id]);
  return Response.json(
    { attributions: byRun.get(run.id) ?? [] },
    { status: 200 }
  );
}
