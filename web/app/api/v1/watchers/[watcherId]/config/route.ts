import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { authorize } from "@/lib/api/auth";
import { apiError, NOT_FOUND, VALIDATION_ERROR } from "@/lib/api/errors";
import { isValidUUID } from "@/lib/api/validators";
import {
  extractWatchDirectory,
  findActiveWatcher,
  revertPendingUploadRequests,
} from "@/lib/api/watchers";
import { db } from "@/lib/db";
import { watcherEvents, watchers } from "@/lib/db/schema";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ watcherId: string }> }
) {
  const authResult = await authorize(request, "watchers:write");
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

  let body: { config_checksum?: string; config_yaml?: string };
  try {
    body = await request.json();
  } catch {
    return apiError(400, VALIDATION_ERROR, "Invalid JSON body");
  }

  if (
    typeof body.config_checksum !== "string" ||
    typeof body.config_yaml !== "string"
  ) {
    return apiError(
      400,
      VALIDATION_ERROR,
      "config_checksum and config_yaml are required"
    );
  }

  const previousWatchDir = extractWatchDirectory(watcher.configYaml);
  const nextWatchDir = extractWatchDirectory(body.config_yaml);

  await db
    .update(watchers)
    .set({
      configChecksum: body.config_checksum,
      configYaml: body.config_yaml,
    })
    .where(eq(watchers.id, watcherId));

  // A watch_directory change orphans every pending request: each carries a
  // relative_path under the old root that no longer resolves. Revert them to
  // `detected` to drain the queue instead of erroring each poll (ENG-1397).
  // Gated on a known previous dir so first-push / unrelated edits don't
  // revert spuriously.
  if (previousWatchDir && nextWatchDir && previousWatchDir !== nextWatchDir) {
    const revertedIds = await revertPendingUploadRequests(watcher.instrumentId);
    if (revertedIds.length > 0) {
      await db.insert(watcherEvents).values({
        watcherId,
        eventType: "config_synced",
        message: `Cancelled ${revertedIds.length} pending upload request(s) after watch directory changed`,
        details: {
          kind: "upload_requests_cancelled",
          cancelled_count: revertedIds.length,
          previous_watch_directory: previousWatchDir,
          watch_directory: nextWatchDir,
        },
        timestamp: new Date(),
      });
    }
  }

  return Response.json({ config_checksum: body.config_checksum });
}
