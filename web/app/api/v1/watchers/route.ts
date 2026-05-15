import { authorize } from "@/lib/api/auth";
import { computeEffectiveStatus, STALE_THRESHOLD_MS } from "@/lib/api/watchers";
import { db } from "@/lib/db";
import { instruments, watchers } from "@/lib/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const authResult = await authorize(request, "watchers:read");
  if (authResult instanceof Response) return authResult;

  const { searchParams } = request.nextUrl;
  const instrumentIdFilter = searchParams.get("instrument_id");
  const statusFilter = searchParams.get("status");
  const includeDeleted = searchParams.get("include_deleted") === "true";

  const conditions = [];

  if (!includeDeleted) {
    conditions.push(isNull(watchers.deletedAt));
  }

  if (instrumentIdFilter) {
    conditions.push(eq(watchers.instrumentId, instrumentIdFilter));
  }

  if (statusFilter === "stale") {
    // "stale" is virtual — push the staleness check into the WHERE clause
    // so we don't fetch all watchers just to filter in JS. A watcher is stale
    // if its last heartbeat is too old, OR it has no heartbeat at all and
    // isn't in the initial "registered" state (which is exempt).
    const threshold = new Date(Date.now() - STALE_THRESHOLD_MS);
    conditions.push(
      sql`(${watchers.lastHeartbeatAt} < ${threshold} OR (${watchers.lastHeartbeatAt} IS NULL AND ${watchers.status} != 'registered'))`
    );
  } else if (statusFilter) {
    conditions.push(
      eq(watchers.status, statusFilter as "registered" | "watching" | "stopped")
    );
  }

  const rows = await db
    .select({
      id: watchers.id,
      instrument_id: watchers.instrumentId,
      instrument_display_name: instruments.displayName,
      hostname: watchers.hostname,
      os_info: watchers.osInfo,
      status: watchers.status,
      last_heartbeat_at: watchers.lastHeartbeatAt,
      created_at: watchers.createdAt,
      updated_at: watchers.updatedAt,
      deleted_at: watchers.deletedAt,
    })
    .from(watchers)
    .leftJoin(instruments, eq(watchers.instrumentId, instruments.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  // Override stored status with the computed effective status (may be "stale").
  const data = rows.map((row) => ({
    ...row,
    status: computeEffectiveStatus({
      status: row.status,
      lastHeartbeatAt: row.last_heartbeat_at,
    }),
  }));

  return Response.json({ data });
}
