import type { NextRequest } from "next/server";
import { authorizeToken } from "@/lib/api/auth";
import {
  apiError,
  apiErrorFromResult,
  NOT_FOUND,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import {
  readJsonBody,
  watcherConfigRevisionResultBody,
} from "@/lib/api/openapi";
import { isValidUUID } from "@/lib/api/validators";
import {
  recordConfigRevisionResult,
  toRevisionWire,
} from "@/lib/api/watcher-config/revisions";
import { enforceWatcherBinding, findActiveWatcher } from "@/lib/api/watchers";

const REVISION_PATTERN = /^[1-9]\d{0,9}$/;

// The watcher reports whether it applied or rejected a revision. PAT-only,
// and only the watcher's own token may report.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ watcherId: string; revision: string }> }
) {
  const authResult = await authorizeToken(request, "watchers:report");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { watcherId, revision: rawRevision } = await params;
  if (!isValidUUID(watcherId)) {
    return apiError(400, VALIDATION_ERROR, "Invalid watcher ID format");
  }
  const revision = Number(rawRevision);
  if (!(REVISION_PATTERN.test(rawRevision) && revision <= 2_147_483_647)) {
    return apiError(400, VALIDATION_ERROR, "Invalid revision number");
  }

  const watcher = await findActiveWatcher(watcherId);
  if (!watcher) {
    return apiError(404, NOT_FOUND, `Watcher '${watcherId}' not found`);
  }

  const bindingError = await enforceWatcherBinding(authResult, watcher);
  if (bindingError) {
    return bindingError;
  }

  const body = await readJsonBody(request, watcherConfigRevisionResultBody);
  if (body instanceof Response) {
    return body;
  }

  const result = await recordConfigRevisionResult({
    watcherId,
    revision,
    status: body.status,
    reason: body.reason ?? null,
  });
  if (!result.ok) {
    return apiErrorFromResult(result);
  }

  return Response.json(toRevisionWire(result.revision));
}
