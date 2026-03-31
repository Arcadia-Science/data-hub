import { db } from "@/lib/db";
import { watchers } from "@/lib/db/schema";
import { and, eq, isNull } from "drizzle-orm";

export const STALE_THRESHOLD_MS = 5 * 60 * 1000;

export async function findActiveWatcher(watcherId: string) {
  const [watcher] = await db
    .select()
    .from(watchers)
    .where(and(eq(watchers.id, watcherId), isNull(watchers.deletedAt)))
    .limit(1);

  return watcher ?? null;
}

type WatcherLike = {
  status: string;
  lastHeartbeatAt: Date | null;
};

/**
 * Derives the display status from stored status + heartbeat recency.
 * "stale" is never stored in the DB — it's a virtual status computed here.
 * Watchers in "registered" state haven't sent their first heartbeat yet,
 * so they're exempt from staleness checks.
 */
export function computeEffectiveStatus(watcher: WatcherLike): string {
  if (watcher.status === "registered") return "registered";

  if (!watcher.lastHeartbeatAt) return "stale";

  const age = Date.now() - watcher.lastHeartbeatAt.getTime();
  return age > STALE_THRESHOLD_MS ? "stale" : watcher.status;
}
