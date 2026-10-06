import type { NextRequest } from "next/server";
import { surfaceEvent, trackEvent } from "@/lib/analytics/track";
import { actorRefFromAuth } from "@/lib/api/actor";
import { authorize } from "@/lib/api/auth";
import {
  apiError,
  CONFLICT,
  NOT_FOUND,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import { commentBody, readJsonBody } from "@/lib/api/openapi";
import { commentToWire } from "@/lib/api/run-comment-wire";
import {
  createCommentAndNotify,
  listCommentsForRun,
  validateCommentBody,
} from "@/lib/api/run-comments";

interface RouteContext {
  params: Promise<{ instrumentId: string; runId: string }>;
}

// ---------------------------------------------------------------------------
// GET /api/v1/instruments/:instrumentId/runs/:runId/comments
//
// List active (non-soft-deleted) comments for a run, oldest first. Open to
// any authenticated user.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "runs:read");
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

  const comments = await listCommentsForRun(run.id);
  return Response.json({ comments: comments.map(commentToWire) });
}

// ---------------------------------------------------------------------------
// POST /api/v1/instruments/:instrumentId/runs/:runId/comments
//
// Create a comment. Body: { body: string }. The author is always the caller:
// the signed-in user, or the token itself for API callers. The URL/body carry
// no author, so spoofing is impossible. Rejects creates on soft-deleted runs
// with 409.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "runs:comment");
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

  if (run.deletedAt) {
    return apiError(409, CONFLICT, "Cannot comment on a soft-deleted run");
  }

  const payload = await readJsonBody(request, commentBody);
  if (payload instanceof Response) {
    return payload;
  }

  const validated = validateCommentBody(payload.body);
  if (!validated.ok) {
    return apiError(400, VALIDATION_ERROR, validated.message);
  }

  const comment = await createCommentAndNotify({
    runInternalId: run.id,
    actor: actorRefFromAuth(authResult),
    body: validated.body,
    instrumentId,
    instrumentDisplayName: run.instrumentDisplayName,
    runDisplayId: runId,
    origin: new URL(request.url).origin,
  });

  trackEvent("comment_added", {
    ...surfaceEvent(authResult),
  });

  return Response.json(commentToWire(comment), { status: 201 });
}
