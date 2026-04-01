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

export function hasActiveFilters(params: {
  search: string;
  instrument_id: string[];
  date_from: string | null;
  date_to: string | null;
  include_deleted: boolean;
}): boolean {
  return (
    params.search !== "" ||
    params.instrument_id.length > 0 ||
    params.date_from !== null ||
    params.date_to !== null ||
    params.include_deleted
  );
}
