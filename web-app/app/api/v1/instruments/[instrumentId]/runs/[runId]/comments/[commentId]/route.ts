import { authenticateRequest } from "@/lib/api/auth";
import {
  apiError,
  CONFLICT,
  FORBIDDEN,
  NOT_FOUND,
  UNAUTHORIZED,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import {
  getCommentForAuthorCheck,
  softDeleteComment,
  updateComment,
} from "@/lib/api/run-comments";
import { requireScope } from "@/lib/api/scopes";
import type { NextRequest } from "next/server";

type RouteContext = {
  params: Promise<{
    instrumentId: string;
    runId: string;
    commentId: string;
  }>;
};

const MAX_BODY_LENGTH = 10_000;

type PreflightResult =
  | { kind: "ok"; userId: string; commentId: string }
  | { kind: "error"; response: Response };

// Shared preflight: resolves the run, validates the comment exists and
// belongs to the requested run, and confirms the caller is the author.
// Returning a discriminated result lets each handler short-circuit cleanly.
async function preflight(
  request: NextRequest,
  params: RouteContext["params"]
): Promise<PreflightResult> {
  const authResult = await authenticateRequest(request);
  if (!authResult) {
    return {
      kind: "error",
      response: apiError(401, UNAUTHORIZED, "Authentication required"),
    };
  }
  // Both PATCH and DELETE on this route mutate comment state, so both
  // require runs:write. Bake the check into the shared preflight so a
  // future verb added here can't accidentally skip it.
  const scopeError = requireScope(authResult, "runs:write");
  if (scopeError) {
    return { kind: "error", response: scopeError };
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

  // Author-only enforcement at the handler layer so we can return a clean
  // 403 with a useful message. The library functions also enforce this in
  // the SQL `where` clause as defense in depth.
  if (comment.userId !== authResult.userId) {
    return {
      kind: "error",
      response: apiError(
        403,
        FORBIDDEN,
        "Only the comment author may edit or delete this comment"
      ),
    };
  }

  return { kind: "ok", userId: authResult.userId, commentId };
}

// ---------------------------------------------------------------------------
// PATCH /api/v1/.../comments/:commentId
//
// Update body. Author-only. Sets `editedAt = now()` so the UI can label
// edited comments without a separate audit table.
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const pre = await preflight(request, params);
  if (pre.kind === "error") return pre.response;

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

  const updated = await updateComment({
    commentId: pre.commentId,
    userId: pre.userId,
    body: payload.body,
  });

  // Race condition: comment soft-deleted between the preflight lookup and
  // the update. Treat as 404 — the row is logically gone.
  if (!updated) {
    return apiError(404, NOT_FOUND, `Comment '${pre.commentId}' not found`);
  }

  return Response.json(updated);
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/.../comments/:commentId
//
// Soft-delete (sets `deletedAt`). Author-only. Idempotent return: if the
// row is already deleted by the time the update runs, we still return 200
// since the caller's intent has been satisfied.
// ---------------------------------------------------------------------------

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const pre = await preflight(request, params);
  if (pre.kind === "error") return pre.response;

  await softDeleteComment({
    commentId: pre.commentId,
    userId: pre.userId,
  });

  return Response.json({ id: pre.commentId, deleted: true });
}
