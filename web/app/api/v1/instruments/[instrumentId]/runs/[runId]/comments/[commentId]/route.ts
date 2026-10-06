import type { NextRequest } from "next/server";
import {
  type SurfaceEvent,
  surfaceEvent,
  trackEvent,
} from "@/lib/analytics/track";
import { type ActorRef, actorRefFromAuth } from "@/lib/api/actor";
import { type AuthResult, authorize } from "@/lib/api/auth";
import {
  apiError,
  CONFLICT,
  FORBIDDEN,
  NOT_FOUND,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import { commentBody, readJsonBody } from "@/lib/api/openapi";
import { commentToWire } from "@/lib/api/run-comment-wire";
import {
  commentDeleterFor,
  commentWrittenBy,
  getCommentForAuthorCheck,
  softDeleteComment,
  updateComment,
  validateCommentBody,
} from "@/lib/api/run-comments";

interface RouteContext {
  params: Promise<{
    instrumentId: string;
    runId: string;
    commentId: string;
  }>;
}

type PreflightResult =
  | {
      kind: "ok";
      actor: ActorRef;
      analytics: SurfaceEvent;
      authResult: AuthResult;
      comment: { id: string; userId: string | null; tokenId: string | null };
    }
  | { kind: "error"; response: Response };

// Shared preflight: resolves the run and validates the comment exists and
// belongs to the requested run. Who may change it differs per verb, so each
// handler checks that itself. Returning a discriminated result lets each
// handler short-circuit cleanly.
async function preflight(
  request: NextRequest,
  params: RouteContext["params"]
): Promise<PreflightResult> {
  // Both PATCH and DELETE on this route mutate comment state, so both
  // require runs:comment. Bake the check into the shared preflight so a
  // future verb added here can't accidentally skip it.
  const authResult = await authorize(request, "runs:comment");
  if (authResult instanceof Response) {
    return { kind: "error", response: authResult };
  }

  const { instrumentId, runId, commentId } = await params;
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
  if (run.deletedAt) {
    return {
      kind: "error",
      response: apiError(
        409,
        CONFLICT,
        "Cannot modify comments on a soft-deleted run"
      ),
    };
  }

  const comment = await getCommentForAuthorCheck(commentId);
  if (!comment || comment.runId !== run.id) {
    return {
      kind: "error",
      response: apiError(404, NOT_FOUND, `Comment '${commentId}' not found`),
    };
  }

  return {
    kind: "ok",
    authResult,
    actor: actorRefFromAuth(authResult),
    comment,
    analytics: surfaceEvent(authResult),
  };
}

// ---------------------------------------------------------------------------
// PATCH /api/v1/.../comments/:commentId
//
// Update body. Author-only, including for admins: an admin can remove a
// comment but not put words in someone else's mouth. A token may only edit
// the comments it posted. Sets `editedAt = now()` so the UI can label edited
// comments without a separate audit table.
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const pre = await preflight(request, params);
  if (pre.kind === "error") {
    return pre.response;
  }

  // Enforced here so we can return a clean 403 with a useful message. The
  // library function also enforces it in the SQL `where` clause as defense
  // in depth.
  if (!commentWrittenBy(pre.comment, pre.actor)) {
    return apiError(
      403,
      FORBIDDEN,
      "Only the comment author may edit this comment"
    );
  }

  const payload = await readJsonBody(request, commentBody);
  if (payload instanceof Response) {
    return payload;
  }

  const validated = validateCommentBody(payload.body);
  if (!validated.ok) {
    return apiError(400, VALIDATION_ERROR, validated.message);
  }

  const updated = await updateComment({
    commentId: pre.comment.id,
    actor: pre.actor,
    body: validated.body,
  });

  // Race condition: comment soft-deleted between the preflight lookup and
  // the update. Treat as 404 — the row is logically gone.
  if (!updated) {
    return apiError(404, NOT_FOUND, `Comment '${pre.comment.id}' not found`);
  }

  trackEvent("comment_edited", pre.analytics);

  return Response.json(commentToWire(updated));
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/.../comments/:commentId
//
// Soft-delete (sets `deletedAt`). Allowed for the author, or for a workspace
// admin signed in as a person. Tokens are never admins, so a token can only
// delete its own comments. Idempotent return: if the row is already deleted
// by the time the update runs, we still return 200 since the caller's intent
// has been satisfied.
// ---------------------------------------------------------------------------

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const pre = await preflight(request, params);
  if (pre.kind === "error") {
    return pre.response;
  }

  const deleter = await commentDeleterFor(pre.comment, pre.actor);
  if (!deleter) {
    return apiError(
      403,
      FORBIDDEN,
      "Only the comment author or an admin may delete this comment"
    );
  }

  await softDeleteComment(pre.comment.id, deleter);

  trackEvent("comment_deleted", pre.analytics);

  return Response.json({ id: pre.comment.id, deleted: true });
}
