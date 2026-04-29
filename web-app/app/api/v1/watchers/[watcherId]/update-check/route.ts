import { authenticateRequest } from "@/lib/api/auth";
import {
  apiError,
  NOT_FOUND,
  UNAUTHORIZED,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import { isValidUUID } from "@/lib/api/validators";
import { findActiveWatcher } from "@/lib/api/watchers";
import type { NextRequest } from "next/server";

/**
 * Server-reported watcher release metadata.
 *
 * Source of truth is environment variables today; a dedicated
 * `watcher_releases` table can replace this once we need per-channel
 * rollouts or per-watcher pinned versions:
 *
 *   - `WATCHER_LATEST_VERSION`        — required to advertise a release
 *   - `WATCHER_MIN_SUPPORTED_VERSION` — optional floor for forced upgrades
 *   - `WATCHER_RELEASE_CHANNEL`       — defaults to "stable"
 *   - `WATCHER_MANDATORY_UPDATE`      — "true" / "1" to force rollout
 *
 * When `WATCHER_LATEST_VERSION` is unset the endpoint still returns 200 so
 * watchers don't log spurious 5xxs; `latest_version: null` tells the
 * client to skip the upgrade attempt.
 */
type WatcherReleaseInfo = {
  latest_version: string | null;
  min_supported_version: string | null;
  channel: string;
  mandatory: boolean;
};

function readReleaseInfo(): WatcherReleaseInfo {
  const latest = process.env.WATCHER_LATEST_VERSION?.trim() || null;
  const minSupported =
    process.env.WATCHER_MIN_SUPPORTED_VERSION?.trim() || null;
  const channel = process.env.WATCHER_RELEASE_CHANNEL?.trim() || "stable";
  const mandatoryRaw = process.env.WATCHER_MANDATORY_UPDATE?.trim() ?? "";
  const mandatory =
    mandatoryRaw === "1" || mandatoryRaw.toLowerCase() === "true";

  return {
    latest_version: latest,
    min_supported_version: minSupported,
    channel,
    mandatory: mandatory && latest !== null,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ watcherId: string }> }
) {
  const authResult = await authenticateRequest(request);
  if (!authResult) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
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

  return Response.json(readReleaseInfo());
}
