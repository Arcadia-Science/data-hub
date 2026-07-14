import { and, count, eq, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { authorize, requireAdminForSession } from "@/lib/api/auth";
import { apiError, NOT_FOUND, VALIDATION_ERROR } from "@/lib/api/errors";
import { patchInstrumentBody, readJsonBody } from "@/lib/api/openapi";
import { deregisterInstrumentWatchers } from "@/lib/api/watchers";
import { db } from "@/lib/db";
import { instrumentRuns, instruments, watchers } from "@/lib/db/schema";

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

  const body = await readJsonBody(request, patchInstrumentBody);
  if (body instanceof Response) {
    return body;
  }

  const [existing] = await db
    .select({ id: instruments.id })
    .from(instruments)
    .where(eq(instruments.id, instrumentId))
    .limit(1);

  if (!existing) {
    return apiError(404, NOT_FOUND, `Instrument '${instrumentId}' not found`);
  }

  const updates: Record<string, unknown> = {};
  if (body.status !== undefined) {
    updates.status = body.status;
    // Keep the retirement audit fields in lockstep with the status: only an
    // `inactive` instrument has a retirer.
    if (body.status === "inactive") {
      updates.retiredAt = new Date();
      updates.retiredBy = authResult.userId;
    } else {
      updates.retiredAt = null;
      updates.retiredBy = null;
    }
  }
  if (body.display_name !== undefined) {
    updates.displayName = body.display_name;
  }
  if (body.instrument_type !== undefined) {
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

    // A retired instrument has no live agent, so always tear down its watchers,
    // attributing the teardown to the same actor that retired it.
    if (updates.status === "inactive") {
      await deregisterInstrumentWatchers(instrumentId, authResult.userId, tx);
    }

    return row;
  });

  return Response.json(updated);
}
