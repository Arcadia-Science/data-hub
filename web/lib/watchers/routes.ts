// Where a watcher's pages live. The watcher belongs to its instrument, so every
// page is under `/instruments/<id>/watcher`. No imports, so server and client
// code share one definition.

export const WATCHER_TABS = [
  { key: "activity", label: "Activity", segment: "" },
  { key: "health", label: "Health", segment: "/health" },
  { key: "settings", label: "Settings", segment: "/settings" },
] as const;

export type WatcherTab = (typeof WATCHER_TABS)[number]["key"];

/** The query parameter that picks a registration other than the default. */
export const WATCHER_PARAM = "watcher";

/**
 * The page's path, with the instrument ID encoded once. Pass `watcherId` for a
 * registration other than the one the page opens on, `focus` to have the
 * Settings form put the cursor in that field, and `params` for the tab's own
 * filters, such as the Activity tab's `event_type`.
 */
export function watcherPageHref(
  instrumentId: string,
  options: {
    tab?: WatcherTab;
    watcherId?: string | null;
    focus?: string;
    params?: Record<string, string>;
  } = {}
): string {
  const tab = options.tab ?? "activity";
  const segment = WATCHER_TABS.find((t) => t.key === tab)?.segment ?? "";
  const query = new URLSearchParams();
  if (options.watcherId) {
    query.set(WATCHER_PARAM, options.watcherId);
  }
  if (options.focus) {
    query.set("focus", options.focus);
  }
  for (const [name, value] of Object.entries(options.params ?? {})) {
    query.set(name, value);
  }
  const queryString = query.toString();
  const search = queryString ? `?${queryString}` : "";
  return `/instruments/${encodeURIComponent(instrumentId)}/watcher${segment}${search}`;
}

// The tabs of the old `/watchers/<id>` page, and the sub-tab each one became.
const LEGACY_TABS = new Map<string, WatcherTab>([
  ["logs", "activity"],
  ["status", "health"],
  ["configuration", "settings"],
]);

/**
 * Where the old `/watchers/<id>` URL goes now. An active watcher is its
 * instrument's current one, so its URL has no `?watcher=`. A deregistered one
 * keeps its ID in the query. A missing or unknown `?tab=` opens Activity, as
 * the old page's first tab did.
 */
export function legacyWatcherRedirect(options: {
  instrumentId: string;
  watcherId: string;
  deregistered: boolean;
  tab: string | null | undefined;
}): string {
  const tab = LEGACY_TABS.get(options.tab ?? "") ?? "activity";
  return watcherPageHref(options.instrumentId, {
    tab,
    watcherId: options.deregistered ? options.watcherId : null,
  });
}

/**
 * Where the old `/watchers` list goes. An admin finds the list in Settings ›
 * Watchers, on its Deregistered tab when the old URL asked for that tab. A
 * member has no list, so goes to the instruments.
 */
export function legacyWatchersRedirect(options: {
  isAdmin: boolean;
  tab: string | null | undefined;
}): string {
  if (!options.isAdmin) {
    return "/instruments";
  }
  return options.tab === "deregistered"
    ? "/settings/watchers?tab=deregistered"
    : "/settings/watchers";
}

const WATCHER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `value` has the shape of a watcher's ID, a UUID. */
export function isWatcherId(value: string): boolean {
  return WATCHER_ID_PATTERN.test(value);
}

/** True for `/instruments/<id>/watcher` and every path below it. */
export function isWatcherPagePath(pathname: string): boolean {
  return /^\/instruments\/[^/]+\/watcher(?:\/|$)/.test(pathname);
}
