import {
  createSearchParamsCache,
  parseAsArrayOf,
  parseAsBoolean,
  parseAsInteger,
  parseAsString,
} from "nuqs/server";

// All dashboard filter/pagination state lives in the URL via nuqs. This makes
// filter combinations shareable via link and keeps the server component in
// page.tsx the single source of truth for data fetching.
export const dashboardSearchParams = {
  search: parseAsString.withDefault(""),
  instrument_id: parseAsArrayOf(parseAsString).withDefault([]),
  date_from: parseAsString,
  date_to: parseAsString,
  include_deleted: parseAsBoolean.withDefault(false),
  page: parseAsInteger.withDefault(1),
  per_page: parseAsInteger.withDefault(25),
};

export const dashboardParamsCache = createSearchParamsCache(
  dashboardSearchParams
);

// Mirrors dashboardSearchParams but omits `instrument_id` (implicit from the
// route segment) and sort/order (defaults to created_at desc).
export const instrumentDetailSearchParams = {
  search: parseAsString.withDefault(""),
  date_from: parseAsString,
  date_to: parseAsString,
  include_deleted: parseAsBoolean.withDefault(false),
  page: parseAsInteger.withDefault(1),
  per_page: parseAsInteger.withDefault(25),
};

export const instrumentDetailParamsCache = createSearchParamsCache(
  instrumentDetailSearchParams
);

// Watcher detail page filters. `event_type` and `events_since` are controlled
// by EventLogToolbar. `since` (heartbeat time range) has no toolbar UI yet —
// it exists to support deep-linking; defaults to 24h in the data layer.
export const watcherDetailSearchParams = {
  event_type: parseAsArrayOf(parseAsString).withDefault([]),
  since: parseAsString,
  events_since: parseAsString,
  hb_page: parseAsInteger.withDefault(1),
  logs_page: parseAsInteger.withDefault(1),
};

export const watcherDetailParamsCache = createSearchParamsCache(
  watcherDetailSearchParams
);

export function hasActiveFilters(params: {
  search: string;
  instrument_id: string[];
  include_deleted: boolean;
}): boolean {
  return (
    params.search !== "" ||
    params.instrument_id.length > 0 ||
    params.include_deleted
  );
}
