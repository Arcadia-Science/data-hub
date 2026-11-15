import { cache } from "react";
import { db } from "@/lib/db";
import { watcherReleaseConfig } from "@/lib/db/schema";

/**
 * The latest watcher version on the release form (Settings › Watchers), or
 * null when an admin hasn't saved one. A watcher page compares each watcher's
 * version with it.
 */
export const getLatestWatcherVersion = cache(
  async function getLatestWatcherVersion(): Promise<string | null> {
    const [row] = await db
      .select({ latestVersion: watcherReleaseConfig.latestVersion })
      .from(watcherReleaseConfig)
      .limit(1);
    return row?.latestVersion?.trim() || null;
  }
);
