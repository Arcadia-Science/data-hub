import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { authorize, requireAdminForSession } from "@/lib/api/auth";
import {
  apiError,
  CONFLICT,
  NOT_FOUND,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import { isValidUUID } from "@/lib/api/validators";
import {
  computeEffectiveStatus,
  deregisterWatcherRow,
  findActiveWatcher,
} from "@/lib/api/watchers";
import { db } from "@/lib/db";
import { instruments, watchers } from "@/lib/db/schema";

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

  const [instrument] = await db
    .select({ displayName: instruments.displayName })
    .from(instruments)
    .where(eq(instruments.id, watcher.instrumentId))
    .limit(1);

  return Response.json({
    id: watcher.id,
    instrument_id: watcher.instrumentId,
    instrument_display_name: instrument?.displayName ?? null,
    hostname: watcher.hostname,
    os_info: watcher.osInfo,
    config_checksum: watcher.configChecksum,
    config_yaml: watcher.configYaml,
    status: computeEffectiveStatus(watcher),
    last_heartbeat_at: watcher.lastHeartbeatAt,
    created_at: watcher.createdAt,
    updated_at: watcher.updatedAt,
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ watcherId: string }> }
) {
  const authResult = await authorize(request, "watchers:admin");
  if (authResult instanceof Response) {
    return authResult;
  }

  // Browser callers (the Deregister dialog on `/watchers`) must additionally
  // be admins. PAT callers pass through purely on the `watchers:admin` scope.
  const adminGate = await requireAdminForSession(authResult);
  if (adminGate) {
    return adminGate;
  }

  const { watcherId } = await params;
  if (!isValidUUID(watcherId)) {
    return apiError(400, VALIDATION_ERROR, "Invalid watcher ID format");
  }

  // Intentionally does NOT use findActiveWatcher() here — we need to
  // distinguish "not found" (404) from "already soft-deleted" (409).
  const [watcher] = await db
    .select({
      id: watchers.id,
      instrumentId: watchers.instrumentId,
      deletedAt: watchers.deletedAt,
    })
    .from(watchers)
    .where(eq(watchers.id, watcherId))
    .limit(1);

  if (!watcher) {
    return apiError(404, NOT_FOUND, `Watcher '${watcherId}' not found`);
  }

  if (watcher.deletedAt) {
    return apiError(409, CONFLICT, "Watcher is already deleted");
  }

  const now = await deregisterWatcherRow(
    { id: watcher.id, instrumentId: watcher.instrumentId },
    "watcher_deregistered",
    authResult.userId
  );

  return Response.json({ id: watcherId, deleted_at: now });
}
