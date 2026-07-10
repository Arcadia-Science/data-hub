import {
  createSearchParamsCache,
  parseAsArrayOf,
  parseAsBoolean,
  parseAsInteger,
  parseAsString,
  parseAsStringLiteral,
} from "nuqs/server";
import { RUN_STATUS_VALUES, type RunStatus } from "@/lib/runs/run-status";

// All dashboard filter/pagination state lives in the URL via nuqs. This makes
// filter combinations shareable via link and keeps the server component in
// page.tsx the single source of truth for data fetching.
export const dashboardSearchParams = {
  search: parseAsString.withDefault(""),
  instrument_id: parseAsArrayOf(parseAsString).withDefault([]),
  date_from: parseAsString.withOptions({ clearOnDefault: true }),
  date_to: parseAsString.withOptions({ clearOnDefault: true }),
  include_deleted: parseAsBoolean.withDefault(false),
  // Derived run status, multi-select. Empty array = no filter (show all).
  status: parseAsArrayOf(parseAsStringLiteral(RUN_STATUS_VALUES))
    .withDefault([])
    .withOptions({ clearOnDefault: true }),
  // Attribution filter: either a userId or the reserved sentinel
  // "unattributed". Mirrors `instrumentDetailSearchParams.ran_by`.
  ran_by: parseAsString,
  page: parseAsInteger.withDefault(1),
  per_page: parseAsInteger.withDefault(10),
};

export const dashboardParamsCache = createSearchParamsCache(
  dashboardSearchParams
);

// Mirrors dashboardSearchParams but omits `instrument_id` (implicit from the
// route segment) and sort/order (defaults to created_at desc).
export const instrumentDetailSearchParams = {
  search: parseAsString.withDefault(""),
  date_from: parseAsString.withOptions({ clearOnDefault: true }),
  date_to: parseAsString.withOptions({ clearOnDefault: true }),
  include_deleted: parseAsBoolean.withDefault(false),
  page: parseAsInteger.withDefault(1),
  per_page: parseAsInteger.withDefault(10),
  // Plate-reader metadata column filters (ignored for generic instruments).
  wavelength: parseAsString,
  measurement_mode: parseAsString,
  measurement_type: parseAsString,
  // Gel-doc metadata column filters.
  capture_type: parseAsString,
  imaging_mode: parseAsString,
  gel_wavelength: parseAsString,
  gel_color: parseAsString,
  // qPCR metadata column filters.
  dye_channel: parseAsString,
  // Hina microscope metadata column filters. `hina_size` stores the raw sizes
  // JSONB object (url-encoded) so different dimension permutations collapse to
  // a single canonical value server-side via jsonb equality.
  hina_channel: parseAsString,
  hina_dimension: parseAsString,
  hina_size: parseAsString,
  // Epson V700 Scanner metadata column filters. `dpi` is a numeric string
  // ("300", "600"); `color_mode` is "rgb" or "bw".
  dpi: parseAsString,
  color_mode: parseAsString,
  // Attribution filter: either a userId or the reserved sentinel "unattributed".
  ran_by: parseAsString,
  // Derived run status, multi-select. Empty array = no filter (show all).
  status: parseAsArrayOf(parseAsStringLiteral(RUN_STATUS_VALUES))
    .withDefault([])
    .withOptions({ clearOnDefault: true }),
};

export const instrumentDetailParamsCache = createSearchParamsCache(
  instrumentDetailSearchParams
);

// Watcher detail page filters. `event_type` and `events_since` are controlled
// by EventLogToolbar. `since` (heartbeat time range) is controlled by
// StatusToolbar; defaults to today when absent.
export const watcherDetailSearchParams = {
  tab: parseAsString.withDefault("logs"),
  event_type: parseAsArrayOf(parseAsString).withDefault([]),
  since: parseAsString,
  events_since: parseAsString,
  logs_page: parseAsInteger.withDefault(1),
};

export const watcherDetailParamsCache = createSearchParamsCache(
  watcherDetailSearchParams
);

// Run detail page: the files table is server-paginated, so its search /
// filter / sort / page state lives in the URL. Keys are prefixed `files_` so
// they don't collide with the comments section or future run-detail params.
// This single object is the source of truth for both the server cache below
// and the client `useQueryStates` in the files toolbar.
const FILES_STATUS_VALUES = [
  "all",
  "raw",
  "processed",
  "pending",
  "uploaded",
  "processing",
  "completed",
  "failed",
] as const;

const FILES_SORT_VALUES = ["name", "size", "date", "status"] as const;

export const runDetailSearchParams = {
  files_page: parseAsInteger.withDefault(1),
  files_search: parseAsString.withDefault(""),
  files_status: parseAsStringLiteral(FILES_STATUS_VALUES).withDefault("all"),
  files_sort: parseAsStringLiteral(FILES_SORT_VALUES).withDefault("name"),
  files_dismissed: parseAsBoolean.withDefault(false),
};

export const runDetailParamsCache = createSearchParamsCache(
  runDetailSearchParams
);

export function hasActiveFilters(params: {
  search: string;
  instrument_id: string[];
  include_deleted: boolean;
  status: RunStatus[];
  ran_by: string | null;
}): boolean {
  return (
    params.search !== "" ||
    params.instrument_id.length > 0 ||
    params.include_deleted ||
    params.status.length > 0 ||
    params.ran_by !== null
  );
}
