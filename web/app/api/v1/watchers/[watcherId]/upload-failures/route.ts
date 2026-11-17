import type { NextRequest } from "next/server";
import { authorizeToken } from "@/lib/api/auth";
import { apiError, NOT_FOUND, VALIDATION_ERROR } from "@/lib/api/errors";
import { readJsonBody, uploadFailuresBody } from "@/lib/api/openapi";
import { recordUploadFailures } from "@/lib/api/upload-failures";
import { isValidUUID } from "@/lib/api/validators";
import { enforceWatcherBinding, findActiveWatcher } from "@/lib/api/watchers";

// ---------------------------------------------------------------------------
// POST /api/v1/watchers/:watcherId/upload-failures
//
// The watcher reports the files it gave up on in one call per queue check
// (watcher 1.4.5 and later): requested files it couldn't find or upload, and
// auto-mode files whose upload failed. Each file still waiting moves to
// `upload_failed` with its reason, and the server logs one `uploads_failed`
// event per run and reason. Older watchers cancel one file at a time with
// PATCH /files/:id instead.
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ watcherId: string }> }
) {
  // PAT-only, like every route a watcher calls: a session carries every scope.
  const authResult = await authorizeToken(request, "watchers:report");
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

  const body = await readJsonBody(request, uploadFailuresBody);
  if (body instanceof Response) {
    return body;
  }

  // Only the files of this watcher's instrument can move; the rest count as
  // skipped.
  const result = await recordUploadFailures(
    { id: watcher.id, instrumentId: watcher.instrumentId },
    body.files
  );

  return Response.json({ failed: result.failed, skipped: result.skipped });
}
