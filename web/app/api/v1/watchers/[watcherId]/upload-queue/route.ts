import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { authorize } from "@/lib/api/auth";
import { apiError, NOT_FOUND, VALIDATION_ERROR } from "@/lib/api/errors";
import { isValidUUID } from "@/lib/api/validators";
import { enforceWatcherBinding, findActiveWatcher } from "@/lib/api/watchers";
import { db } from "@/lib/db";
import { files, instrumentRuns } from "@/lib/db/schema";

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

  const watcher = await findActiveWatcher(watcherId);
  if (!watcher) {
    return apiError(404, NOT_FOUND, `Watcher '${watcherId}' not found`);
  }

  const bindingError = await enforceWatcherBinding(authResult, watcher);
  if (bindingError) {
    return bindingError;
  }

  // A file is "pending upload" when a user requested it via the web UI
  // (upload_requested_at is set) but it hasn't been uploaded yet
  // (uploaded_at is NULL). Scoped to the watcher's instrument so each
  // watcher only sees files relevant to its instrument.
  const rows = await db
    .select({
      id: files.id,
      instrument_id: instrumentRuns.instrumentId,
      run_id: instrumentRuns.runId,
      relative_path: files.relativePath,
      filename: files.filename,
      size_bytes: files.sizeBytes,
    })
    .from(files)
    .innerJoin(instrumentRuns, eq(files.instrumentRunId, instrumentRuns.id))
    .where(
      and(
        eq(instrumentRuns.instrumentId, watcher.instrumentId),
        isNotNull(files.uploadRequestedAt),
        isNull(files.uploadedAt),
        isNull(files.deletedAt)
      )
    );

  return Response.json({ files: rows });
}
