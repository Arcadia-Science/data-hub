import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { authorize } from "@/lib/api/auth";
import {
  apiError,
  NOT_FOUND,
  UPGRADE_REQUIRED,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import { isValidUUID } from "@/lib/api/validators";
import { isBelowFloor } from "@/lib/api/watcher-versions";
import {
  findActiveWatcher,
  revertUploadQueueIfWatcherOffline,
} from "@/lib/api/watchers";
import { db } from "@/lib/db";
import {
  watcherHeartbeats,
  watcherReleaseConfig,
  watchers,
} from "@/lib/db/schema";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ watcherId: string }> }
) {
  const authResult = await authorize(request, "watchers:write");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { watcherId } = await params;
  if (!isValidUUID(watcherId)) {
    return apiError(400, VALIDATION_ERROR, "Invalid watcher ID format");
  }

  const watcher = await findActiveWatcher(watcherId);
  if (!watcher) {
    return apiError(404, NOT_FOUND, `Watcher '${watcherId}' not found`);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return apiError(400, VALIDATION_ERROR, "Invalid JSON body");
  }

  const VALID_WATCHER_STATUSES = ["registered", "watching", "stopped"] as const;
  const status = body.status as string | undefined;
  if (!status) {
    return apiError(400, VALIDATION_ERROR, "status is required");
  }
  if (
    !VALID_WATCHER_STATUSES.includes(
      status as (typeof VALID_WATCHER_STATUSES)[number]
    )
  ) {
    return apiError(
      400,
      VALIDATION_ERROR,
      `Invalid status '${status}' — must be one of: ${VALID_WATCHER_STATUSES.join(", ")}`
    );
  }

  const timestamp = body.timestamp
    ? new Date(body.timestamp as string)
    : new Date();
  if (Number.isNaN(timestamp.getTime())) {
    return apiError(400, VALIDATION_ERROR, "Invalid timestamp");
  }

  // Enforce the configured min-supported-version floor before recording
  // anything. Below-floor watchers are sent away with a 426 so they
  // can't keep heartbeating (and silently look "alive") while skipping
  // a mandatory upgrade. We compare against `body.watcher_version`
  // rather than the stored `watchers.watcher_version` so the very first
  // heartbeat after a manual upgrade is judged on the new version, not
  // the stale stored one. The singleton constraint on
  // `watcher_release_config` keeps this a constant-cost select.
  const reportedVersion =
    typeof body.watcher_version === "string" && body.watcher_version
      ? body.watcher_version
      : null;
  const [releaseRow] = await db
    .select({
      minSupportedVersion: watcherReleaseConfig.minSupportedVersion,
      latestVersion: watcherReleaseConfig.latestVersion,
      channel: watcherReleaseConfig.channel,
    })
    .from(watcherReleaseConfig);

  if (
    releaseRow &&
    isBelowFloor(reportedVersion, releaseRow.minSupportedVersion)
  ) {
    return apiError(
      426,
      UPGRADE_REQUIRED,
      `Watcher version ${reportedVersion} is below the minimum supported version ${releaseRow.minSupportedVersion}. Self-update before continuing.`,
      {
        current_version: reportedVersion,
        min_supported_version: releaseRow.minSupportedVersion,
        latest_version: releaseRow.latestVersion,
        channel: releaseRow.channel,
      }
    );
  }

  // Two parallel writes: (1) append to the heartbeat history log, and
  // (2) update the watcher's denormalized last_heartbeat_at + status so
  // staleness checks don't need to scan the heartbeats table.
  //
  // API field names differ from DB columns — the watcher CLI sends verbose
  // names (e.g. "files_uploaded_since_last_heartbeat") that map to shorter
  // column names (e.g. "files_uploaded_since_last").
  await Promise.all([
    db.insert(watcherHeartbeats).values({
      watcherId,
      timestamp,
      status,
      uploadMode: (body.upload_mode as "auto" | "manual") ?? null,
      filesUploadedSinceLast:
        (body.files_uploaded_since_last_heartbeat as number) ?? 0,
      runsReportedSinceLast:
        (body.runs_reported_since_last_heartbeat as number) ?? 0,
      errorsSinceLast: (body.errors_since_last_heartbeat as number) ?? 0,
      uptimeSeconds: (body.uptime_seconds as number) ?? null,
    }),
    db
      .update(watchers)
      .set({
        lastHeartbeatAt: new Date(),
        status: status as "registered" | "watching" | "stopped",
        // Older watchers (pre-version-reporting) won't include this field —
        // fall back to the existing value rather than nulling it out so the
        // dashboard keeps the last-known version visible.
        ...(reportedVersion ? { watcherVersion: reportedVersion } : {}),
      })
      .where(eq(watchers.id, watcherId)),
  ]);

  // A graceful `stopped` heartbeat (shutdown) means this watcher can't drain
  // its queue, so revert anything left in `upload_requested`. We deliberately
  // ignore `registered`: it's a transient startup state, and reverting there
  // would churn the queue on every restart (`registered` → `watching`) when the
  // watcher is about to come back and drain it. The cron sweep backstops a
  // watcher that registers and then dies. The helper re-checks online status.
  //
  // Best-effort: the heartbeat itself is already committed above, so a failure
  // here must not fail the response (the watcher would treat a 500 as a missed
  // heartbeat).
  if (status === "stopped") {
    try {
      await revertUploadQueueIfWatcherOffline({
        instrumentId: watcher.instrumentId,
        watcherId,
        reason: "watcher_stopped",
      });
    } catch (err) {
      console.error(
        `[watcher-heartbeat] upload-queue revert failed for watcher ${watcherId}: ${err}`
      );
    }
  }

  return Response.json({ ok: true });
}
