// Gates server behavior on the watcher version sent with each request.
//
// Older watchers never send `X-Data-Hub-Watcher-Version`, so a missing
// header means "keep the previous behavior". A route checks
// `watcherClientFrom(request).supports("…")` and keeps that older branch
// next to the new one. The header only chooses between two safe
// behaviors; the token still controls access.
//
// The version is read from the request rather than the heartbeat column.
// Upload requests carry no watcher id, one token can belong to several
// watchers, and the stored version lags right after an upgrade.
//
// Delete a feature entry and its older branch once
// `watcher_release_config.min_supported_version` reaches that feature's
// version. Heartbeats already turn away every older watcher then, so the
// branch is dead.

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
