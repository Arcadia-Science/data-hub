import { and, eq, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { authorizeToken } from "@/lib/api/auth";
import {
  apiError,
  CONFLICT,
  NOT_FOUND,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import { readJsonBody, registerWatcherBody } from "@/lib/api/openapi";
import { db } from "@/lib/db";
import { instruments, watchers } from "@/lib/db/schema";

// PAT-only: browser sessions carry `*` and would let any signed-in
// member register a watcher and occupy the one-per-instrument slot.
export async function POST(request: NextRequest) {
  const authResult = await authorizeToken(request, "watchers:report");
  if (authResult instanceof Response) {
    return authResult;
  }

  const body = await readJsonBody(request, registerWatcherBody);
  if (body instanceof Response) {
    return body;
  }

  const instrumentId = body.instrument_id;

  const [instrument] = await db
    .select({ id: instruments.id, status: instruments.status })
    .from(instruments)
    .where(eq(instruments.id, instrumentId))
    .limit(1);

  if (!instrument) {
    return apiError(404, NOT_FOUND, `Instrument '${instrumentId}' not found`);
  }

  // Only active or pending instruments accept new watchers; inactive ones
  // are fully decommissioned and should not have new watchers registering.
  if (instrument.status !== "active" && instrument.status !== "pending") {
    return apiError(
      400,
      VALIDATION_ERROR,
      `Instrument '${instrumentId}' is ${instrument.status} and cannot accept new watchers`
    );
  }

  // Enforce 1:1 active watcher per instrument. The partial unique index on
  // `watchers (instrument_id) WHERE deleted_at IS NULL` is the actual safety
  // net; this lookup gives the CLI a friendlier error with the existing
  // watcher id so the operator can deregister it.
  const [existing] = await db
    .select({ id: watchers.id, hostname: watchers.hostname })
    .from(watchers)
    .where(
      and(eq(watchers.instrumentId, instrumentId), isNull(watchers.deletedAt))
    )
    .limit(1);

  if (existing) {
    return apiError(
      409,
      CONFLICT,
      `Instrument '${instrumentId}' already has an active watcher (id: ${existing.id}). Deregister it before registering a new one.`,
      { existing_watcher_id: existing.id, hostname: existing.hostname }
    );
  }

  const [created] = await db
    .insert(watchers)
    .values({
      instrumentId,
      hostname: body.hostname ?? null,
      osInfo: body.os_info ?? null,
      status: "registered",
      // Bind this watcher to the registering PAT so later ops can't be
      // driven by a different watchers:report token (cross-control IDOR).
      registeredByToken: authResult.tokenId,
    })
    .returning({ id: watchers.id });

  return Response.json({ watcher_id: created.id }, { status: 201 });
}
