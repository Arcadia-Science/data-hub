import type { NextRequest } from "next/server";
import { authorize } from "@/lib/api/auth";
import { apiError, NOT_FOUND, VALIDATION_ERROR } from "@/lib/api/errors";
import { isValidUUID } from "@/lib/api/validators";
import { enforceWatcherBinding, findActiveWatcher } from "@/lib/api/watchers";
import { db } from "@/lib/db";
import { watcherReleaseConfig } from "@/lib/db/schema";

/**
 * Server-reported watcher release metadata.
 *
 * Source of truth is the `watcher_release_config` singleton row, edited
 * by admins via `/settings/watchers`. Until that row exists (fresh
 * deploy, before any admin save) the endpoint still returns 200 with
 * `latest_version: null` so watchers don't log spurious 5xxs and the
 * client treats it as "no update available".
 */
interface WatcherReleaseInfo {
  channel: string;
  latest_version: string | null;
  mandatory: boolean;
  min_supported_version: string | null;
}

async function readReleaseInfo(): Promise<WatcherReleaseInfo> {
  // The singleton check constraint on `id` guarantees at most one row;
  // no LIMIT 1 or ORDER BY discipline required on read.
  const [row] = await db.select().from(watcherReleaseConfig);
  if (!row) {
    return {
      latest_version: null,
      min_supported_version: null,
      channel: "stable",
      mandatory: false,
    };
  }
  return {
    latest_version: row.latestVersion,
    min_supported_version: row.minSupportedVersion,
    channel: row.channel,
    // Collapsing mandatory→false when no version is advertised keeps the
    // wire response self-consistent. The watcher's mandatory branch is
    // gated on `latest_version` anyway, but mirroring that invariant
    // here means a misconfigured `mandatory=true` with a blank version
    // never leaks out of the API.
    mandatory: row.mandatory && row.latestVersion !== null,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ watcherId: string }> }
) {
  const authResult = await authorize(request, "watchers:read");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { watcherId } = await params;
  if (!isValidUUID(watcherId)) {
    return apiError(400, VALIDATION_ERROR, "Invalid watcher ID format");
  }

  // Soft-deleted watchers can't legitimately self-update — they shouldn't
  // be calling home at all. Return 404 so the CLI surfaces the same
  // "Watcher not found" error operators see elsewhere.
  const watcher = await findActiveWatcher(watcherId);
  if (!watcher) {
    return apiError(404, NOT_FOUND, `Watcher '${watcherId}' not found`);
  }

  const bindingError = await enforceWatcherBinding(authResult, watcher);
  if (bindingError) {
    return bindingError;
  }

  return Response.json(await readReleaseInfo());
}
