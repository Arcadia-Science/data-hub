import type { NextRequest } from "next/server";
import { actorRefFromAuth } from "@/lib/api/actor";
import { authorize, requireAdminForSession } from "@/lib/api/auth";
import {
  apiError,
  apiErrorFromResult,
  NOT_FOUND,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import {
  createWatcherConfigRevisionBody,
  readJsonBody,
} from "@/lib/api/openapi";
import { isValidUUID } from "@/lib/api/validators";
import {
  CONFIG_REVISIONS_DEFAULT_LIMIT,
  CONFIG_REVISIONS_MAX_LIMIT,
  createWebConfigRevision,
  listConfigRevisions,
  toRevisionWire,
} from "@/lib/api/watcher-config/revisions";
import { findActiveWatcher } from "@/lib/api/watchers";

// History of a watcher's config changes, newest first. Any signed-in member
// can read it, as can a token with `watchers:read`.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ watcherId: string }> }
) {
  const authResult = await authorize(request, "watchers:read");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { watcherId } = await params;
  if (!isValidUUID(watcherId)) {
    return apiError(400, VALIDATION_ERROR, "Invalid watcher ID format");
  }

  const rawLimit = request.nextUrl.searchParams.get("limit");
  let limit = CONFIG_REVISIONS_DEFAULT_LIMIT;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return apiError(
        400,
        VALIDATION_ERROR,
        "limit must be a positive integer"
      );
    }
    limit = Math.min(parsed, CONFIG_REVISIONS_MAX_LIMIT);
  }

  const watcher = await findActiveWatcher(watcherId);
  if (!watcher) {
    return apiError(404, NOT_FOUND, `Watcher '${watcherId}' not found`);
  }

  const revisions = await listConfigRevisions(watcherId, limit);
  return Response.json({ data: revisions.map(toRevisionWire) });
}

// Stores an admin's change as a pending revision. The watcher picks it up
// from its next heartbeat reply.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ watcherId: string }> }
) {
  const authResult = await authorize(request, "watchers:admin");
  if (authResult instanceof Response) {
    return authResult;
  }
  // Browser sessions must also belong to an admin. Tokens pass on the
  // `watchers:admin` scope alone.
  const adminGate = await requireAdminForSession(authResult);
  if (adminGate) {
    return adminGate;
  }

  const { watcherId } = await params;
  if (!isValidUUID(watcherId)) {
    return apiError(400, VALIDATION_ERROR, "Invalid watcher ID format");
  }

  const body = await readJsonBody(request, createWatcherConfigRevisionBody);
  if (body instanceof Response) {
    return body;
  }

  const result = await createWebConfigRevision({
    watcherId,
    baseRevision: body.base_revision,
    settings: body.settings,
    actor: actorRefFromAuth(authResult),
  });
  if (!result.ok) {
    return apiErrorFromResult(result);
  }

  return Response.json(toRevisionWire(result.revision), { status: 201 });
}
