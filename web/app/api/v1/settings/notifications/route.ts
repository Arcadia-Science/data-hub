import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/api/auth";
import { apiError, UNAUTHORIZED, VALIDATION_ERROR } from "@/lib/api/errors";
import {
  getPreferences,
  listInstrumentSubscriptions,
  type NotificationPreferencesDto,
  updatePreferences,
} from "@/lib/api/notifications";

// Single source of truth mapping snake_case API keys to their camelCase DTO
// counterparts. The schema, request parsing, and response serialization are
// all derived from this so a new toggle only has to be added here.
const PREFERENCE_FIELDS = {
  runs_all_muted: "runsAllMuted",
  comments_attributed_enabled: "commentsAttributedEnabled",
  comments_participated_enabled: "commentsParticipatedEnabled",
  slack_runs_enabled: "slackRunsEnabled",
  slack_comments_attributed_enabled: "slackCommentsAttributedEnabled",
  slack_comments_participated_enabled: "slackCommentsParticipatedEnabled",
} as const satisfies Record<string, keyof NotificationPreferencesDto>;

type ApiPreferenceKey = keyof typeof PREFERENCE_FIELDS;

// PUT body is a partial: every key is optional and only present fields
// are written. Defaults live on the column, so a missing key on a fresh
// preferences row picks up the schema-side default rather than `false`.
const PutBodySchema = z
  .object(
    Object.fromEntries(
      Object.keys(PREFERENCE_FIELDS).map((key) => [key, z.boolean().optional()])
    ) as Record<ApiPreferenceKey, z.ZodOptional<z.ZodBoolean>>
  )
  .strict();

function serializePreferences(
  prefs: NotificationPreferencesDto
): Record<ApiPreferenceKey, boolean> {
  const out = {} as Record<ApiPreferenceKey, boolean>;
  for (const apiKey of Object.keys(PREFERENCE_FIELDS) as ApiPreferenceKey[]) {
    out[apiKey] = prefs[PREFERENCE_FIELDS[apiKey]];
  }
  return out;
}

function toPreferencesPatch(
  data: Partial<Record<ApiPreferenceKey, boolean>>
): Partial<NotificationPreferencesDto> {
  const patch: Partial<NotificationPreferencesDto> = {};
  for (const apiKey of Object.keys(PREFERENCE_FIELDS) as ApiPreferenceKey[]) {
    const value = data[apiKey];
    if (value !== undefined) {
      patch[PREFERENCE_FIELDS[apiKey]] = value;
    }
  }
  return patch;
}

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
  if (!auth) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }

  const [prefs, subscriptions] = await Promise.all([
    getPreferences(auth.userId),
    listInstrumentSubscriptions(auth.userId),
  ]);

  return Response.json({
    ...serializePreferences(prefs),
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
  if (!auth) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
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

  const updated = await updatePreferences(
    auth.userId,
    toPreferencesPatch(parsed.data)
  );

  return Response.json(serializePreferences(updated));
}
