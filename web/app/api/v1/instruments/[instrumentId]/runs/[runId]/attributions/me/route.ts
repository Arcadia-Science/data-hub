import type { NextRequest } from "next/server";
import { surfaceEvent, trackEvent } from "@/lib/analytics/track";
import { requireSession } from "@/lib/api/auth";
import { apiError, NOT_FOUND, UNAUTHORIZED } from "@/lib/api/errors";
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
// Claim a run for the signed-in user. Idempotent: calling twice has the
// same effect as calling once. The session's user id is the only user id
// used — the URL carries no user id, so spoofing another user's attribution
// is impossible. Session-only: a run is claimed by the person who performed
// it, and API tokens are not people.
// ---------------------------------------------------------------------------

export async function PUT(_request: NextRequest, { params }: RouteContext) {
  const authResult = await requireSession();
  if (!authResult) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
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
  trackEvent("run_claimed", {
    ...surfaceEvent(authResult),
  });

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

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  const authResult = await requireSession();
  if (!authResult) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
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
  trackEvent("run_unclaimed", {
    ...surfaceEvent(authResult),
  });

  const byRun = await getAttributionsByRunIds([run.id]);
  return Response.json(
    { attributions: byRun.get(run.id) ?? [] },
    { status: 200 }
  );
}
