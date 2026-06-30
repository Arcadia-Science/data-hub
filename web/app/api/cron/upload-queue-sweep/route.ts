import { and, eq, isNull, sql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import {
  revertUploadQueueIfWatcherOffline,
  UPLOAD_REQUEST_REVERT_GRACE_MS,
} from "@/lib/api/watchers";
import { db } from "@/lib/db";
import { files, instrumentRuns, watchers } from "@/lib/db/schema";

// Staleness sweep for the manual upload queue: reverts files stuck in
// `upload_requested` once their instrument has had no online watcher for longer
// than the grace window. Catches ungraceful watcher death (no `stopped`
// heartbeat ever arrives), which the request-upload guard and heartbeat hook
// can't. Triggered by Vercel Cron (`web/vercel.json`), authed via `CRON_SECRET`.

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Distinct instruments with at least one file still sitting in the queue.
  const queuedInstruments = await db
    .selectDistinct({ instrumentId: instrumentRuns.instrumentId })
    .from(files)
    .innerJoin(instrumentRuns, eq(files.instrumentRunId, instrumentRuns.id))
    .where(
      and(
        eq(files.status, "upload_requested"),
        isNull(files.uploadedAt),
        isNull(files.deletedAt)
      )
    );

  let sweptInstruments = 0;
  let revertedFiles = 0;
  let failedInstruments = 0;

  for (const { instrumentId } of queuedInstruments) {
    // Isolate each instrument: a query/insert failure on one (e.g. a transient
    // DB error) must not abort the rest of the sweep. The next cron tick retries
    // anything skipped here.
    try {
      // Newest heartbeat among active watchers decides staleness; a null one (no
      // active watcher, or never checked in) counts as stale. Skip inside the
      // grace window so a brief blip doesn't churn the queue.
      const [active] = await db
        .select({ lastHeartbeatAt: watchers.lastHeartbeatAt })
        .from(watchers)
        .where(
          and(
            eq(watchers.instrumentId, instrumentId),
            isNull(watchers.deletedAt)
          )
        )
        .orderBy(sql`${watchers.lastHeartbeatAt} desc nulls last`)
        .limit(1);

      const newestHeartbeat = active?.lastHeartbeatAt ?? null;
      const withinGrace =
        newestHeartbeat !== null &&
        Date.now() - newestHeartbeat.getTime() < UPLOAD_REQUEST_REVERT_GRACE_MS;
      if (withinGrace) {
        continue;
      }

      // The event's `watcher_id` is NOT NULL, so attribute it to the most
      // recently seen watcher — including soft-deleted ones, which covers an
      // instrument whose only watcher was deregistered after files were queued.
      const [attribution] = await db
        .select({ id: watchers.id })
        .from(watchers)
        .where(eq(watchers.instrumentId, instrumentId))
        .orderBy(sql`${watchers.lastHeartbeatAt} desc nulls last`)
        .limit(1);
      if (!attribution) {
        continue;
      }

      const reverted = await revertUploadQueueIfWatcherOffline({
        instrumentId,
        watcherId: attribution.id,
        reason: "watcher_offline_sweep",
      });
      if (reverted > 0) {
        sweptInstruments += 1;
        revertedFiles += reverted;
      }
    } catch (err) {
      failedInstruments += 1;
      console.error(
        `[upload-queue-sweep] failed to sweep instrument ${instrumentId}: ${err}`
      );
    }
  }

  return Response.json({
    swept_instruments: sweptInstruments,
    reverted_files: revertedFiles,
    failed_instruments: failedInstruments,
  });
}
