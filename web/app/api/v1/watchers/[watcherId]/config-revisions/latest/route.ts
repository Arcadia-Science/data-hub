import type { NextRequest } from "next/server";
import { authorizeToken } from "@/lib/api/auth";
import { apiError, NOT_FOUND, VALIDATION_ERROR } from "@/lib/api/errors";
import { isValidUUID } from "@/lib/api/validators";
import {
  getRevisionForWatcher,
  toRevisionWire,
} from "@/lib/api/watcher-config/revisions";
import { enforceWatcherBinding, findActiveWatcher } from "@/lib/api/watchers";

// The watcher fetches this when its heartbeat reply carries a revision
// number higher than the last one it saw. Returns the pending revision if
// there is one, else the highest. PAT-only, like the other watcher-agent
// routes.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ watcherId: string }> }
) {
  const authResult = await authorizeToken(request, "watchers:read");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { watcherId } = await params;
  if (!isValidUUID(watcherId)) {
    return apiError(400, VALIDATION_ERROR, "Invalid watcher ID format");
  }

  const watcher = await findActiveWatcher(watcherId);
  if (!watcher) {
    return apiError(404, NOT_FOUND, `Watcher '${watcherId}' not found`);
  }

  const bindingError = await enforceWatcherBinding(authResult, watcher);
  if (bindingError) {
    return bindingError;
  }

  const latest = await getRevisionForWatcher(watcherId);
  if (!latest) {
    return apiError(404, NOT_FOUND, "This watcher has no config revisions");
  }

  return Response.json(toRevisionWire(latest));
}
