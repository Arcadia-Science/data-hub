/**
 * Rolled-up watcher status for an instrument:
 *  - `online`     — at least one watcher is actively heartbeating
 *  - `offline`    — watchers are registered but none are heartbeating
 *  - `no_watcher` — no watchers registered for the instrument
 *
 * This is distinct from the per-watcher `EffectiveStatus` in
 * `lib/api/watchers.ts`, which describes a single watcher's lifecycle.
 *
 * Lives in its own module (instead of alongside `WatcherStatusBadge`) so
 * Server Components can call this helper during render — the badge file is
 * marked "use client" to dodge a Radix Tooltip + asChild SSR/hydration
 * mismatch, and re-exporting a plain function from a "use client" module
 * would turn it into a client reference unusable on the server.
 */
export type WatcherOnlineStatus = "online" | "offline" | "no_watcher";

export function getWatcherOnlineStatus({
  watcherCount,
  watchersOnline,
}: {
  watcherCount: number;
  watchersOnline: number;
}): WatcherOnlineStatus {
  if (watcherCount === 0) {
    return "no_watcher";
  }
  return watchersOnline > 0 ? "online" : "offline";
}
