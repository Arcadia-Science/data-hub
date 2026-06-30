import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { after } from "next/server";
import { authorize } from "@/lib/api/auth";
import {
  apiError,
  CONFLICT,
  NOT_FOUND,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import { notifyComment } from "@/lib/api/notifications";
import { createComment, listCommentsForRun } from "@/lib/api/run-comments";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

interface RouteContext {
  params: Promise<{ instrumentId: string; runId: string }>;
}

// Cap on the markdown source we accept. Generous for prose, well below any
// jsonb / text limit. Bumping is a route-only change — no migration needed.
const MAX_BODY_LENGTH = 10_000;

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
  return Response.json({ comments });
}

// ---------------------------------------------------------------------------
// POST /api/v1/instruments/:instrumentId/runs/:runId/comments
//
// Create a comment. Body: { body: string }. Author is always the
// authenticated user — the URL/body carry no user id, so attribution
// spoofing is impossible. Rejects creates on soft-deleted runs with 409.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "runs:write");
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

  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return apiError(400, VALIDATION_ERROR, "Invalid JSON body");
  }

  if (typeof payload.body !== "string") {
    return apiError(400, VALIDATION_ERROR, "body must be a string");
  }

  const trimmed = payload.body.trim();
  if (trimmed.length === 0) {
    return apiError(400, VALIDATION_ERROR, "body must not be empty");
  }
  if (payload.body.length > MAX_BODY_LENGTH) {
    return apiError(
      400,
      VALIDATION_ERROR,
      `body must be at most ${MAX_BODY_LENGTH} characters`
    );
  }

  const comment = await createComment({
    runInternalId: run.id,
    userId: authResult.userId,
    body: payload.body,
  });

  // Fan out to attributees + prior commenters after the response is sent.
  // Fetch the author's display name here (before the response) so the
  // closure captures a concrete string rather than making a DB call inside
  // the deferred `after()` block where request context may be gone.
  const [author] = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, authResult.userId))
    .limit(1);
  const authorDisplayName = author?.name ?? author?.email ?? "Someone";

  after(async () => {
    await notifyComment({
      runInternalId: run.id,
      commentId: comment.id,
      authorUserId: authResult.userId,
      authorDisplayName,
      instrumentId,
      instrumentDisplayName: run.instrumentDisplayName,
      runDisplayId: runId,
      commentBody: payload.body as string,
      origin: new URL(request.url).origin,
    });
  });

  return Response.json(comment, { status: 201 });
}
