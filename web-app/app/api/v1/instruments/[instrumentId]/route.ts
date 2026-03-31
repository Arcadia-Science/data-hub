import { authenticateRequest } from "@/lib/api/auth";
import {
  apiError,
  NOT_FOUND,
  UNAUTHORIZED,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import { db } from "@/lib/db";
import { instrumentRuns, instruments, watchers } from "@/lib/db/schema";
import { and, count, eq, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ instrumentId: string }> }
) {
  const authResult = await authenticateRequest(request);
  if (!authResult) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }

  const { instrumentId } = await params;

  const [instrument] = await db
    .select()
    .from(instruments)
    .where(eq(instruments.id, instrumentId))
    .limit(1);

  if (!instrument) {
    return apiError(404, NOT_FOUND, `Instrument '${instrumentId}' not found`);
  }

  // Counts exclude soft-deleted records to reflect the "active" totals.
  const [runCountResult, watcherCountResult] = await Promise.all([
    db
      .select({ value: count() })
      .from(instrumentRuns)
      .where(
        and(
          eq(instrumentRuns.instrumentId, instrumentId),
          isNull(instrumentRuns.deletedAt)
        )
      ),
    db
      .select({ value: count() })
      .from(watchers)
      .where(
        and(eq(watchers.instrumentId, instrumentId), isNull(watchers.deletedAt))
      ),
  ]);

  return Response.json({
    id: instrument.id,
    display_name: instrument.displayName,
    status: instrument.status,
    file_patterns: instrument.filePatterns,
    s3_trigger_suffix: instrument.s3TriggerSuffix,
    created_at: instrument.createdAt,
    updated_at: instrument.updatedAt,
    run_count: runCountResult[0].value,
    watcher_count: watcherCountResult[0].value,
  });
}

const ALLOWED_PATCH_FIELDS = new Set([
  "status",
  "file_patterns",
  "display_name",
]);

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ instrumentId: string }> }
) {
  const authResult = await authenticateRequest(request);
  if (!authResult) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }

  const { instrumentId } = await params;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return apiError(400, VALIDATION_ERROR, "Invalid JSON body");
  }

  const unknownKeys = Object.keys(body).filter(
    (k) => !ALLOWED_PATCH_FIELDS.has(k)
  );
  if (unknownKeys.length > 0) {
    return apiError(400, VALIDATION_ERROR, "Unknown fields", {
      unknown_fields: unknownKeys,
      allowed_fields: [...ALLOWED_PATCH_FIELDS],
    });
  }

  const [existing] = await db
    .select({ id: instruments.id })
    .from(instruments)
    .where(eq(instruments.id, instrumentId))
    .limit(1);

  if (!existing) {
    return apiError(404, NOT_FOUND, `Instrument '${instrumentId}' not found`);
  }

  // Map API snake_case field names to Drizzle camelCase column names.
  const updates: Record<string, unknown> = {};
  if ("status" in body) updates.status = body.status;
  if ("file_patterns" in body) updates.filePatterns = body.file_patterns;
  if ("display_name" in body) updates.displayName = body.display_name;

  const [updated] = await db
    .update(instruments)
    .set(updates)
    .where(eq(instruments.id, instrumentId))
    .returning({
      id: instruments.id,
      display_name: instruments.displayName,
      status: instruments.status,
      file_patterns: instruments.filePatterns,
      s3_trigger_suffix: instruments.s3TriggerSuffix,
      created_at: instruments.createdAt,
      updated_at: instruments.updatedAt,
    });

  return Response.json(updated);
}
