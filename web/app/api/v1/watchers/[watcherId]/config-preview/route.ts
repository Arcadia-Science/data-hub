import type { NextRequest } from "next/server";
import {
  authorize,
  requireAdminForSession,
  requireExplicitTokenScope,
} from "@/lib/api/auth";
import { apiError, NOT_FOUND, VALIDATION_ERROR } from "@/lib/api/errors";
import { readJsonBody, watcherConfigPreviewBody } from "@/lib/api/openapi";
import { isValidUUID } from "@/lib/api/validators";
import { previewConfigForInstrument } from "@/lib/api/watcher-config/revisions";
import { findActiveWatcher } from "@/lib/api/watchers";

// Shows which of the instrument's recent files a settings change would match
// and the run ID each would get. Used only by the edit form, so it stays out
// of the OpenAPI document.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ watcherId: string }> }
) {
  const authResult = await authorize(request, "watchers:admin");
  if (authResult instanceof Response) {
    return authResult;
  }
  // Browser sessions must belong to an admin. Tokens must list
  // `watchers:admin` themselves: the legacy `watchers:write` and `*` that old
  // watcher PCs carry imply it, but must not let them repoint other watchers.
  const adminGate =
    (await requireAdminForSession(authResult)) ??
    requireExplicitTokenScope(authResult, "watchers:admin");
  if (adminGate) {
    return adminGate;
  }

  const { watcherId } = await params;
  if (!isValidUUID(watcherId)) {
    return apiError(400, VALIDATION_ERROR, "Invalid watcher ID format");
  }

  const body = await readJsonBody(request, watcherConfigPreviewBody);
  if (body instanceof Response) {
    return body;
  }

  const watcher = await findActiveWatcher(watcherId);
  if (!watcher) {
    return apiError(404, NOT_FOUND, `Watcher '${watcherId}' not found`);
  }

  return Response.json(
    await previewConfigForInstrument(watcher.instrumentId, body.settings)
  );
}
