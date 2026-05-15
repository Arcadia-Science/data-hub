import { authenticateRequest } from "@/lib/api/auth";
import { apiError, NOT_FOUND, UNAUTHORIZED } from "@/lib/api/errors";
import {
  getAttributionsByRunIds,
  lookupRunByNaturalKey,
} from "@/lib/api/instrument-runs";
import { requireScope } from "@/lib/api/scopes";
import { db } from "@/lib/db";
import { runAttributions } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

type RouteContext = {
  params: Promise<{ instrumentId: string; runId: string }>;
};

// ---------------------------------------------------------------------------
// PUT /api/v1/instruments/:instrumentId/runs/:runId/attributions/me
//
// Claim a run for the authenticated user. Idempotent: calling twice has the
// same effect as calling once. The authenticated user id is the only user id
// used — the URL carries no user id, so spoofing another user's attribution
// is impossible.
// ---------------------------------------------------------------------------

export async function PUT(request: NextRequest, { params }: RouteContext) {
  const authResult = await authenticateRequest(request);
  if (!authResult) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }
  const scopeError = requireScope(authResult, "runs:write");
  if (scopeError) return scopeError;

  const { instrumentId, runId } = await params;
  const run = await lookupRunByNaturalKey(instrumentId, runId);
  if (!run) {
    return apiError(
      404,
      NOT_FOUND,
      `Run '${runId}' not found for instrument '${instrumentId}'`
    );
  }

  await db
    .insert(runAttributions)
    .values({ runId: run.id, userId: authResult.userId })
    .onConflictDoNothing();

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
  const authResult = await authenticateRequest(request);
  if (!authResult) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }
  const scopeError = requireScope(authResult, "runs:write");
  if (scopeError) return scopeError;

  const { instrumentId, runId } = await params;
  const run = await lookupRunByNaturalKey(instrumentId, runId);
  if (!run) {
    return apiError(
      404,
      NOT_FOUND,
      `Run '${runId}' not found for instrument '${instrumentId}'`
    );
  }

  await db
    .delete(runAttributions)
    .where(
      and(
        eq(runAttributions.runId, run.id),
        eq(runAttributions.userId, authResult.userId)
      )
    );

  const byRun = await getAttributionsByRunIds([run.id]);
  return Response.json(
    { attributions: byRun.get(run.id) ?? [] },
    { status: 200 }
  );
}
