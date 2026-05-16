import { requireAdmin } from "@/lib/api/auth";
import { apiError, VALIDATION_ERROR } from "@/lib/api/errors";
import { db } from "@/lib/db";
import { users, watcherReleaseConfig } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

// Admin-only read/write of the singleton `watcher_release_config` row,
// edited via `/settings/watcher-release`. The `update-check` endpoint
// reads the same row but is open to any watcher-scoped PAT — this route
// is the privileged write path and is therefore session-only via
// `requireAdmin()`, matching the `/api/v1/users/[userId]` PATCH model.

// Loose PEP-440-style version match — covers the values we already
// advertise (`9.9.9`, `0.1.0`) plus the common `1.2.3rc1` / `1.2.3.post1`
// shapes. We intentionally don't validate against PyPI here; a typo will
// surface to operators as an `update_failed` event from the fleet, which
// is the same failure mode they already debug today.
const VERSION_REGEX = /^\d+\.\d+\.\d+([.-].+)?$/;

const ALLOWED_PUT_FIELDS = new Set([
  "latest_version",
  "min_supported_version",
  "channel",
  "mandatory",
]);

type WatcherReleaseResponse = {
  latest_version: string | null;
  min_supported_version: string | null;
  channel: string;
  mandatory: boolean;
  updated_at: string | null;
  updated_by: {
    id: string;
    name: string | null;
    email: string | null;
  } | null;
};

const EMPTY_RESPONSE: WatcherReleaseResponse = {
  latest_version: null,
  min_supported_version: null,
  channel: "stable",
  mandatory: false,
  updated_at: null,
  updated_by: null,
};

async function readCurrent(): Promise<WatcherReleaseResponse> {
  // Left-join on `user` so we can render "Last updated by …" without a
  // second round-trip. The singleton constraint guarantees at most one
  // row, so this is a constant-cost query regardless of fleet size.
  const [row] = await db
    .select({
      latestVersion: watcherReleaseConfig.latestVersion,
      minSupportedVersion: watcherReleaseConfig.minSupportedVersion,
      channel: watcherReleaseConfig.channel,
      mandatory: watcherReleaseConfig.mandatory,
      updatedAt: watcherReleaseConfig.updatedAt,
      updatedById: users.id,
      updatedByName: users.name,
      updatedByEmail: users.email,
    })
    .from(watcherReleaseConfig)
    .leftJoin(users, eq(users.id, watcherReleaseConfig.updatedBy));

  if (!row) {
    return EMPTY_RESPONSE;
  }

  return {
    latest_version: row.latestVersion,
    min_supported_version: row.minSupportedVersion,
    channel: row.channel,
    mandatory: row.mandatory,
    updated_at: row.updatedAt.toISOString(),
    updated_by: row.updatedById
      ? {
          id: row.updatedById,
          name: row.updatedByName,
          email: row.updatedByEmail,
        }
      : null,
  };
}

export async function GET() {
  const authResult = await requireAdmin();
  if (authResult instanceof Response) return authResult;

  return Response.json(await readCurrent());
}

// Normalises a string input from the form: trims whitespace and treats
// an empty string the same as an omitted/explicit-null value. Keeps the
// "version unset" semantics from the env-var era — operators don't have
// to remember to send `null` instead of `""`.
function normalizeOptionalString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return value as never;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export async function PUT(request: NextRequest) {
  const authResult = await requireAdmin();
  if (authResult instanceof Response) return authResult;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return apiError(400, VALIDATION_ERROR, "Invalid JSON body");
  }

  const unknownKeys = Object.keys(body).filter(
    (k) => !ALLOWED_PUT_FIELDS.has(k)
  );
  if (unknownKeys.length > 0) {
    return apiError(400, VALIDATION_ERROR, "Unknown fields", {
      unknown_fields: unknownKeys,
      allowed_fields: [...ALLOWED_PUT_FIELDS],
    });
  }

  // Type-check each field individually so the error messages name the
  // offending property (rather than the all-or-nothing failure you'd get
  // from a single zod parse).
  if (
    body.latest_version !== undefined &&
    body.latest_version !== null &&
    typeof body.latest_version !== "string"
  ) {
    return apiError(
      400,
      VALIDATION_ERROR,
      "latest_version must be a string or null"
    );
  }
  if (
    body.min_supported_version !== undefined &&
    body.min_supported_version !== null &&
    typeof body.min_supported_version !== "string"
  ) {
    return apiError(
      400,
      VALIDATION_ERROR,
      "min_supported_version must be a string or null"
    );
  }
  if (body.channel !== undefined && typeof body.channel !== "string") {
    return apiError(400, VALIDATION_ERROR, "channel must be a string");
  }
  if (body.mandatory !== undefined && typeof body.mandatory !== "boolean") {
    return apiError(400, VALIDATION_ERROR, "mandatory must be a boolean");
  }

  const latestVersion = normalizeOptionalString(body.latest_version);
  const minSupportedVersion = normalizeOptionalString(
    body.min_supported_version
  );
  const channel =
    typeof body.channel === "string" ? body.channel.trim() : "stable";
  const mandatory = body.mandatory === true;

  if (latestVersion !== null && !VERSION_REGEX.test(latestVersion)) {
    return apiError(
      400,
      VALIDATION_ERROR,
      `latest_version '${latestVersion}' is not a valid PEP 440-style version`
    );
  }
  if (
    minSupportedVersion !== null &&
    !VERSION_REGEX.test(minSupportedVersion)
  ) {
    return apiError(
      400,
      VALIDATION_ERROR,
      `min_supported_version '${minSupportedVersion}' is not a valid PEP 440-style version`
    );
  }
  if (channel.length === 0) {
    return apiError(
      400,
      VALIDATION_ERROR,
      "channel must be a non-empty string"
    );
  }

  const now = new Date();
  // Singleton upsert: `id = true` is the primary key, so ON CONFLICT
  // collapses concurrent admin saves onto the same row. The set clause
  // explicitly omits `id` to keep the constraint happy.
  await db
    .insert(watcherReleaseConfig)
    .values({
      id: true,
      latestVersion,
      minSupportedVersion,
      channel,
      mandatory,
      updatedAt: now,
      updatedBy: authResult.userId,
    })
    .onConflictDoUpdate({
      target: watcherReleaseConfig.id,
      set: {
        latestVersion,
        minSupportedVersion,
        channel,
        mandatory,
        updatedAt: now,
        updatedBy: authResult.userId,
      },
    });

  return Response.json(await readCurrent());
}
