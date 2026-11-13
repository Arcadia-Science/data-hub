import { and, eq, isNull, type SQL } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { authorize } from "@/lib/api/auth";
import { apiError, VALIDATION_ERROR } from "@/lib/api/errors";
import { watcherStatusSchema } from "@/lib/api/openapi/schemas/common";
import {
  computeEffectiveStatus,
  effectiveStatusCondition,
} from "@/lib/api/watchers";
import { db } from "@/lib/db";
import { instruments, watchers } from "@/lib/db/schema";

export async function GET(request: NextRequest) {
  const authResult = await authorize(request, "watchers:read");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { searchParams } = request.nextUrl;
  const instrumentIdFilter = searchParams.get("instrument_id");
  const statusFilter = searchParams.get("status");
  const includeDeleted = searchParams.get("include_deleted") === "true";
  // One clock for the filter and for the status printed in each row, so a
  // watcher can't match one filter and print another status.
  const now = new Date();

  const conditions: SQL[] = [];

  if (!includeDeleted) {
    conditions.push(isNull(watchers.deletedAt));
  }

  if (instrumentIdFilter) {
    conditions.push(eq(watchers.instrumentId, instrumentIdFilter));
  }

  // Each value selects the watchers whose computed status, the one printed
  // below, is that value. "stale" is never stored, so the filter can't just
  // compare the stored status. The check runs in the WHERE clause so we don't
  // fetch all watchers just to filter in JS.
  if (statusFilter) {
    const parsedStatus = watcherStatusSchema.safeParse(statusFilter);
    if (!parsedStatus.success) {
      return apiError(
        400,
        VALIDATION_ERROR,
        `Invalid status '${statusFilter}'. Use one of: ${watcherStatusSchema.options.join(", ")}.`
      );
    }
    conditions.push(effectiveStatusCondition(parsedStatus.data, now));
  }

  const rows = await db
    .select({
      id: watchers.id,
      instrument_id: watchers.instrumentId,
      instrument_display_name: instruments.displayName,
      hostname: watchers.hostname,
      os_info: watchers.osInfo,
      status: watchers.status,
      status_reason: watchers.statusReason,
      config_revision: watchers.configRevision,
      applied_config_revision: watchers.appliedConfigRevision,
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
    status: computeEffectiveStatus(
      {
        status: row.status,
        statusReason: row.status_reason,
        lastHeartbeatAt: row.last_heartbeat_at,
      },
      now
    ),
  }));

  return Response.json({ data });
}
