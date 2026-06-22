import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/api/auth";
import { apiError, VALIDATION_ERROR } from "@/lib/api/errors";
import { db } from "@/lib/db";
import { users, watcherReleaseConfig } from "@/lib/db/schema";

// Admin-only read/write of the singleton `watcher_release_config` row,
// edited via `/settings/watchers`. The `update-check` endpoint reads
// the same row but is open to any watcher-scoped PAT — this route is
// the privileged write path and is therefore session-only via
// `requireAdmin()`, matching the `/api/v1/users/[userId]` PATCH model.

// Loose PEP-440-style version match — covers the values we already
// advertise (`9.9.9`, `0.1.0`) plus the common `1.2.3rc1` / `1.2.3.post1`
// shapes. We intentionally don't validate against PyPI here; a typo will
// surface to operators as an `update_failed` event from the fleet, which
// is the same failure mode they already debug today.
const VERSION_REGEX = /^\d+\.\d+\.\d+([.-].+)?$/;

// Trim and collapse `""` to `null` so the wire contract stays "empty
// means unset" everywhere — operators don't have to remember to send
// `null` instead of `""`. Shared by both version fields.
function normalizeVersionInput(v: string | null | undefined): string | null {
  if (v == null) {
    return null;
  }
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// PUT semantics: missing fields take their defaults rather than
// silently preserving the existing row's value. The form always sends
// all four, so this only affects hand-crafted callers — for whom a
// uniform "replace with these (or defaults)" rule is far less surprising
// than the previous mix where `channel`/`mandatory` defaulted but
// `latest_version`/`min_supported_version` were preserved.
const PutBodySchema = z.strictObject({
  latest_version: z
    .string()
    .nullish()
    .transform(normalizeVersionInput)
    .refine((v) => v === null || VERSION_REGEX.test(v), {
      message: "latest_version is not a valid PEP 440-style version",
    }),
  min_supported_version: z
    .string()
    .nullish()
    .transform(normalizeVersionInput)
    .refine((v) => v === null || VERSION_REGEX.test(v), {
      message: "min_supported_version is not a valid PEP 440-style version",
    }),
  channel: z
    .string()
    .optional()
    .transform((v) => (v ?? "stable").trim())
    .refine((v) => v.length > 0, {
      message: "channel must be a non-empty string",
    }),
  mandatory: z
    .boolean()
    .optional()
    .transform((v) => v ?? false),
});

interface WatcherReleaseResponse {
  channel: string;
  latest_version: string | null;
  mandatory: boolean;
  min_supported_version: string | null;
  updated_at: string | null;
  updated_by: {
    id: string;
    name: string | null;
    email: string | null;
  } | null;
}

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
  if (authResult instanceof Response) {
    return authResult;
  }

  return Response.json(await readCurrent());
}

export async function PUT(request: NextRequest) {
  const authResult = await requireAdmin();
  if (authResult instanceof Response) {
    return authResult;
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return apiError(400, VALIDATION_ERROR, "Invalid JSON body");
  }

  const parsed = PutBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError(400, VALIDATION_ERROR, "Invalid request body", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    });
  }

  const {
    latest_version: latestVersion,
    min_supported_version: minSupportedVersion,
    channel,
    mandatory,
  } = parsed.data;

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
