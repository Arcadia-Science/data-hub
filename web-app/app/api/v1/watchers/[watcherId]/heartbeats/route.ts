import { authenticateRequest } from "@/lib/api/auth";
import { apiError, NOT_FOUND, UNAUTHORIZED } from "@/lib/api/errors";
import {
  isValidUUID,
  parseDateParam,
  parseIntParam,
} from "@/lib/api/validators";
import { findActiveWatcher } from "@/lib/api/watchers";
import { db } from "@/lib/db";
import { watcherHeartbeats } from "@/lib/db/schema";
import { and, desc, eq, gte } from "drizzle-orm";
import type { NextRequest } from "next/server";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ watcherId: string }> }
) {
  const authResult = await authenticateRequest(request);
  if (!authResult) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }

  const { watcherId } = await params;
  if (!isValidUUID(watcherId)) {
    return apiError(400, NOT_FOUND, "Invalid watcher ID format");
  }

  const watcher = await findActiveWatcher(watcherId);
  if (!watcher) {
    return apiError(404, NOT_FOUND, `Watcher '${watcherId}' not found`);
  }

  const { searchParams } = request.nextUrl;
  const limit = parseIntParam(searchParams.get("limit"), {
    default: 100,
    min: 1,
    max: 1000,
  });
  const since = parseDateParam(searchParams.get("since"));

  const conditions = [eq(watcherHeartbeats.watcherId, watcherId)];
  if (since) {
    conditions.push(gte(watcherHeartbeats.timestamp, since));
  }

  const rows = await db
    .select({
      id: watcherHeartbeats.id,
      timestamp: watcherHeartbeats.timestamp,
      status: watcherHeartbeats.status,
      upload_mode: watcherHeartbeats.uploadMode,
      files_uploaded_since_last: watcherHeartbeats.filesUploadedSinceLast,
      runs_reported_since_last: watcherHeartbeats.runsReportedSinceLast,
      errors_since_last: watcherHeartbeats.errorsSinceLast,
      uptime_seconds: watcherHeartbeats.uptimeSeconds,
      created_at: watcherHeartbeats.createdAt,
    })
    .from(watcherHeartbeats)
    .where(and(...conditions))
    .orderBy(desc(watcherHeartbeats.timestamp))
    .limit(limit);

  return Response.json({ data: rows });
}
