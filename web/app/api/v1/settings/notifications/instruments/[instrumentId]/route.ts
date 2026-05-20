import { requireSession } from "@/lib/api/auth";
import {
  apiError,
  NOT_FOUND,
  UNAUTHORIZED,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import { setInstrumentSubscription } from "@/lib/api/notifications";
import { db } from "@/lib/db";
import { instruments } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";

const PutBodySchema = z.object({ enabled: z.boolean() }).strict();

type RouteContext = {
  params: Promise<{ instrumentId: string }>;
};

// ---------------------------------------------------------------------------
// PUT /api/v1/settings/notifications/instruments/:instrumentId  { enabled }
//
// Upserts the per-(user, instrument) subscription row. We validate that
// the instrument actually exists so a typo'd id doesn't silently insert
// — the FK on `instrument_notification_subscriptions.instrument_id`
// would also reject this, but a 404 is friendlier than a 500.
// ---------------------------------------------------------------------------

export async function PUT(request: NextRequest, { params }: RouteContext) {
  const auth = await requireSession();
  if (!auth) return apiError(401, UNAUTHORIZED, "Authentication required");

  const { instrumentId } = await params;

  const [instrument] = await db
    .select({ id: instruments.id })
    .from(instruments)
    .where(eq(instruments.id, instrumentId))
    .limit(1);

  if (!instrument) {
    return apiError(404, NOT_FOUND, `Instrument '${instrumentId}' not found`);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return apiError(400, VALIDATION_ERROR, "Invalid JSON body");
  }

  const parsed = PutBodySchema.safeParse(raw);
  if (!parsed.success) {
    return apiError(400, VALIDATION_ERROR, "Invalid request body", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    });
  }

  await setInstrumentSubscription(
    auth.userId,
    instrumentId,
    parsed.data.enabled
  );

  return Response.json({
    instrument_id: instrumentId,
    enabled: parsed.data.enabled,
  });
}
