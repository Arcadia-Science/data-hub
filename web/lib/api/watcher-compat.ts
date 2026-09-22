// Gates server behavior on the watcher version sent with each request.
// A missing or unreadable `X-Data-Hub-Watcher-Version` keeps the previous
// behavior. The header is not the heartbeat version: upload requests carry
// no watcher id, and the stored version lags right after an upgrade.
// Delete a feature once `min_supported_version` reaches it.

import { isAtLeast } from "@/lib/api/watcher-versions";

export const WATCHER_VERSION_HEADER = "x-data-hub-watcher-version";

export const WATCHER_FEATURES = {
  // Same-named files from different folders are stored under a folder-hash
  // name instead of being dropped. Watchers older than this still upload by
  // bare filename, so renaming for them would leave a record nobody uploads.
  renameDuplicateFilenames: "1.1.0",
} as const satisfies Record<string, string>;

export type WatcherFeature = keyof typeof WATCHER_FEATURES;

export interface WatcherClient {
  supports(feature: WatcherFeature): boolean;
  version: string | null;
}

export function watcherClientFrom(request: Request): WatcherClient {
  const raw = request.headers.get(WATCHER_VERSION_HEADER);
  const version = raw?.trim() ? raw.trim() : null;
  return {
    version,
    supports(feature) {
      return isAtLeast(version, WATCHER_FEATURES[feature]);
    },
  };
}
