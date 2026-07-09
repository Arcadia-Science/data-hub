import { and, count, eq, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { authorize, requireAdminForSession } from "@/lib/api/auth";
import { apiError, NOT_FOUND, VALIDATION_ERROR } from "@/lib/api/errors";
import { deregisterInstrumentWatchers } from "@/lib/api/watchers";
import { db } from "@/lib/db";
import {
  instrumentRuns,
  instruments,
  VALID_INSTRUMENT_TYPES,
  watchers,
} from "@/lib/db/schema";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ instrumentId: string }> }
) {
  const authResult = await authorize(request, "instruments:read");
  if (authResult instanceof Response) {
    return authResult;
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
    instrument_type: instrument.instrumentType,
    created_at: instrument.createdAt,
    updated_at: instrument.updatedAt,
    run_count: runCountResult[0].value,
    watcher_count: watcherCountResult[0].value,
  });
}

const ALLOWED_PATCH_FIELDS = new Set([
  "status",
  "display_name",
  "instrument_type",
]);

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ instrumentId: string }> }
) {
  const authResult = await authorize(request, "instruments:write");
  if (authResult instanceof Response) {
    return authResult;
  }

  // Browser callers (the Edit dialog and the "Confirm pending" button on
  // `/instruments`) must additionally be admins. PAT callers — the watcher
  // CLI and Lambda — pass through purely on the `instruments:write` scope
  // so existing automation continues to work without rotation.
  const adminGate = await requireAdminForSession(authResult);
  if (adminGate) {
    return adminGate;
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

  const VALID_INSTRUMENT_STATUSES = ["pending", "active", "inactive"];
  if (
    "status" in body &&
    !VALID_INSTRUMENT_STATUSES.includes(body.status as string)
  ) {
    return apiError(
      400,
      VALIDATION_ERROR,
      `Invalid status — must be one of: ${VALID_INSTRUMENT_STATUSES.join(", ")}`
    );
  }

  if (
    "instrument_type" in body &&
    !(VALID_INSTRUMENT_TYPES as readonly string[]).includes(
      body.instrument_type as string
    )
  ) {
    return apiError(
      400,
      VALIDATION_ERROR,
      `Invalid instrument_type — must be one of: ${VALID_INSTRUMENT_TYPES.join(", ")}`
    );
  }

  const updates: Record<string, unknown> = {};
  if ("status" in body) {
    updates.status = body.status;
  }
  if ("display_name" in body) {
    updates.displayName = body.display_name;
  }
  if ("instrument_type" in body) {
    updates.instrumentType = body.instrument_type;
  }

  if (Object.keys(updates).length === 0) {
    return apiError(400, VALIDATION_ERROR, "No valid fields to update");
  }

  // Retirement flips the status and tears down every watcher; both run in one
  // transaction so a mid-teardown failure can't leave the instrument
  // `inactive` while its watchers stay live and heartbeating.
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(instruments)
      .set(updates)
      .where(eq(instruments.id, instrumentId))
      .returning({
        id: instruments.id,
        display_name: instruments.displayName,
        status: instruments.status,
        instrument_type: instruments.instrumentType,
        created_at: instruments.createdAt,
        updated_at: instruments.updatedAt,
      });

    // A retired instrument has no live agent, so always tear down its watchers.
    if (updates.status === "inactive") {
      await deregisterInstrumentWatchers(instrumentId, tx);
    }

    return row;
  });

  return Response.json(updated);
}
