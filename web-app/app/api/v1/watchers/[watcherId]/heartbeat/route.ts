import { authenticateRequest } from "@/lib/api/auth";
import {
  apiError,
  NOT_FOUND,
  UNAUTHORIZED,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import { isValidUUID } from "@/lib/api/validators";
import { findActiveWatcher } from "@/lib/api/watchers";
import { db } from "@/lib/db";
import { watcherHeartbeats, watchers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ watcherId: string }> }
) {
  const authResult = await authenticateRequest(request);
  if (!authResult) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }

  const { watcherId } = await params;
  if (!isValidUUID(watcherId)) {
    return apiError(400, VALIDATION_ERROR, "Invalid watcher ID format");
  }

  const watcher = await findActiveWatcher(watcherId);
  if (!watcher) {
    return apiError(404, NOT_FOUND, `Watcher '${watcherId}' not found`);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return apiError(400, VALIDATION_ERROR, "Invalid JSON body");
  }

  const VALID_WATCHER_STATUSES = ["registered", "watching", "stopped"] as const;
  const status = body.status as string | undefined;
  if (!status) {
    return apiError(400, VALIDATION_ERROR, "status is required");
  }
  if (
    !VALID_WATCHER_STATUSES.includes(
      status as (typeof VALID_WATCHER_STATUSES)[number]
    )
  ) {
    return apiError(
      400,
      VALIDATION_ERROR,
      `Invalid status '${status}' — must be one of: ${VALID_WATCHER_STATUSES.join(", ")}`
    );
  }

  const timestamp = body.timestamp
    ? new Date(body.timestamp as string)
    : new Date();
  if (isNaN(timestamp.getTime())) {
    return apiError(400, VALIDATION_ERROR, "Invalid timestamp");
  }

  // Two parallel writes: (1) append to the heartbeat history log, and
  // (2) update the watcher's denormalized last_heartbeat_at + status so
  // staleness checks don't need to scan the heartbeats table.
  //
  // API field names differ from DB columns — the watcher CLI sends verbose
  // names (e.g. "files_uploaded_since_last_heartbeat") that map to shorter
  // column names (e.g. "files_uploaded_since_last").
  await Promise.all([
    db.insert(watcherHeartbeats).values({
      watcherId,
      timestamp,
      status,
      uploadMode: (body.upload_mode as "auto" | "manual") ?? null,
      filesUploadedSinceLast:
        (body.files_uploaded_since_last_heartbeat as number) ?? 0,
      runsReportedSinceLast:
        (body.runs_reported_since_last_heartbeat as number) ?? 0,
      errorsSinceLast: (body.errors_since_last_heartbeat as number) ?? 0,
      uptimeSeconds: (body.uptime_seconds as number) ?? null,
    }),
    db
      .update(watchers)
      .set({
        lastHeartbeatAt: new Date(),
        status: status as "registered" | "watching" | "stopped",
      })
      .where(eq(watchers.id, watcherId)),
  ]);

  return Response.json({ ok: true });
}
