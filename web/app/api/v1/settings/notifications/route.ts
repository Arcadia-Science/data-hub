import { requireSession } from "@/lib/api/auth";
import { apiError, UNAUTHORIZED, VALIDATION_ERROR } from "@/lib/api/errors";
import {
  getPreferences,
  listInstrumentSubscriptions,
  updatePreferences,
} from "@/lib/api/notifications";
import type { NextRequest } from "next/server";
import { z } from "zod";

// PUT body is a partial: every key is optional and only present fields
// are written. Defaults live on the column, so a missing key on a fresh
// preferences row picks up the schema-side default rather than `false`.
const PutBodySchema = z
  .object({
    runs_all_muted: z.boolean().optional(),
    comments_attributed_enabled: z.boolean().optional(),
    comments_participated_enabled: z.boolean().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// GET /api/v1/settings/notifications
//
// Returns the current user's notification prefs + the full instrument
// catalogue with each row's subscription state. Used by the settings page
// to render the master toggles and the per-instrument switches in one
// payload.
// ---------------------------------------------------------------------------

export async function GET() {
  const auth = await requireSession();
  if (!auth) return apiError(401, UNAUTHORIZED, "Authentication required");

  const [prefs, subscriptions] = await Promise.all([
    getPreferences(auth.userId),
    listInstrumentSubscriptions(auth.userId),
  ]);

  return Response.json({
    runs_all_muted: prefs.runsAllMuted,
    comments_attributed_enabled: prefs.commentsAttributedEnabled,
    comments_participated_enabled: prefs.commentsParticipatedEnabled,
    instruments: subscriptions.map((s) => ({
      instrument_id: s.instrumentId,
      display_name: s.displayName,
      enabled: s.enabled,
    })),
  });
}

// ---------------------------------------------------------------------------
// PUT /api/v1/settings/notifications
//
// Partial update of the three boolean prefs. Per-instrument subscriptions
// have their own endpoint (`/instruments/:instrumentId`) so a single
// switch toggle can be written without re-sending the whole bag.
// ---------------------------------------------------------------------------

export async function PUT(request: NextRequest) {
  const auth = await requireSession();
  if (!auth) return apiError(401, UNAUTHORIZED, "Authentication required");

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

  const patch: Parameters<typeof updatePreferences>[1] = {};
  if (parsed.data.runs_all_muted !== undefined) {
    patch.runsAllMuted = parsed.data.runs_all_muted;
  }
  if (parsed.data.comments_attributed_enabled !== undefined) {
    patch.commentsAttributedEnabled = parsed.data.comments_attributed_enabled;
  }
  if (parsed.data.comments_participated_enabled !== undefined) {
    patch.commentsParticipatedEnabled =
      parsed.data.comments_participated_enabled;
  }

  const updated = await updatePreferences(auth.userId, patch);

  return Response.json({
    runs_all_muted: updated.runsAllMuted,
    comments_attributed_enabled: updated.commentsAttributedEnabled,
    comments_participated_enabled: updated.commentsParticipatedEnabled,
  });
}
