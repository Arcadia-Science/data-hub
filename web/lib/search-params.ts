import {
  createParser,
  createSearchParamsCache,
  parseAsArrayOf,
  parseAsBoolean,
  parseAsInteger,
  parseAsString,
  parseAsStringLiteral,
} from "nuqs/server";
import { FILES_LIFECYCLE_FILTER_VALUES } from "@/lib/runs/file-lifecycle-filter";
import {
  expandRunStatusAlias,
  RUN_STATUS_VALUES,
  type RunStatus,
} from "@/lib/runs/run-status";

function isRunStatus(value: string): value is RunStatus {
  return (RUN_STATUS_VALUES as readonly string[]).includes(value);
}

// The run-status multi-select, comma-separated like `parseAsArrayOf`. Old links
// may say `pending`, which is read as both statuses that replaced it.
export const parseAsRunStatuses = createParser<RunStatus[]>({
  parse(value) {
    const statuses = new Set<RunStatus>();
    for (const part of value.split(",")) {
      for (const status of expandRunStatusAlias(part.trim())) {
        if (isRunStatus(status)) {
          statuses.add(status);
        }
      }
    }
    return statuses.size > 0 ? [...statuses] : null;
  },
  serialize: (statuses) => statuses.join(","),
  eq: (a, b) =>
    a.length === b.length && a.every((status, i) => status === b[i]),
});

// "Lab Notebook" column filter: runs in at least one notebook or in none
// (`has_lab_notebook`), or runs in one notebook, by its ID (`lab_notebook_id`). The
// column's menu sets one of them at a time.
export const HAS_NOTEBOOK_VALUES = ["true", "false"] as const;

export const notebookFilterSearchParams = {
  has_lab_notebook: parseAsStringLiteral(HAS_NOTEBOOK_VALUES),
  lab_notebook_id: parseAsString,
};

// Shared by the dashboard, a member's runs page, and every instrument page.
// Defaults stay out of the URL so an unsorted link matches the table's
// built-in order: acquisition time, newest first.
export const RUN_SORT_FIELDS = ["acquired_at", "updated_at"] as const;
const RUN_SORT_ORDERS = ["asc", "desc"] as const;

export const runSortSearchParams = {
  sort: parseAsStringLiteral(RUN_SORT_FIELDS)
    .withDefault("acquired_at")
    .withOptions({ clearOnDefault: true }),
  order: parseAsStringLiteral(RUN_SORT_ORDERS)
    .withDefault("desc")
    .withOptions({ clearOnDefault: true }),
};

// `date_from` for "no lower bound" on a list that shows a narrower window by
// default: the dashboard lists today's runs unless the URL says otherwise.
export const ALL_TIME_DATE_FROM = "all";

// All dashboard filter/pagination state lives in the URL via nuqs. This makes
// filter combinations shareable via link and keeps the server component in
// page.tsx the single source of truth for data fetching.
export const dashboardSearchParams = {
  search: parseAsString.withDefault(""),
  instrument_id: parseAsArrayOf(parseAsString).withDefault([]),
  date_from: parseAsString.withOptions({ clearOnDefault: true }),
  date_to: parseAsString.withOptions({ clearOnDefault: true }),
  // Recent-comments preview on the home page. Independent of the runs
  // table's date range. Empty means the server default (today).
  comments_from: parseAsString.withOptions({ clearOnDefault: true }),
  comments_to: parseAsString.withOptions({ clearOnDefault: true }),
  include_deleted: parseAsBoolean.withDefault(false),
  // Derived run status, multi-select. Empty array = no filter (show all).
  status: parseAsRunStatuses
    .withDefault([])
    .withOptions({ clearOnDefault: true }),
  // Attribution filter: either a userId or the reserved sentinel
  // "unattributed". Mirrors `instrumentDetailSearchParams.ran_by`.
  ran_by: parseAsString,
  ...notebookFilterSearchParams,
  page: parseAsInteger.withDefault(1),
  per_page: parseAsInteger.withDefault(10),
  // The lab notebooks list on Home and on a member's page. It pages on its
  // own, so it has its own key beside the runs table's `page`.
  notebooks_page: parseAsInteger.withDefault(1),
  // The Name filter on Home's lab notebooks list: a name, part of a
  // description, or a pasted link, as on `/lab-notebooks`.
  notebooks_q: parseAsString.withDefault(""),
  // The Owner filter on Home's lab notebooks list: a user ID, or
  // NOTEBOOK_OWNER_NONE for notebooks with no owner.
  notebooks_owner: parseAsString,
  // The date range on Home's lab notebooks list, which lists notebooks that
  // got a run in it. Empty means today; `notebooks_from` can be
  // ALL_TIME_DATE_FROM.
  notebooks_from: parseAsString.withOptions({ clearOnDefault: true }),
  notebooks_to: parseAsString.withOptions({ clearOnDefault: true }),
  ...runSortSearchParams,
};

// The `notebooks_owner` value for notebooks with no owner.
export const NOTEBOOK_OWNER_NONE = "none";

export const dashboardParamsCache = createSearchParamsCache(
  dashboardSearchParams
);

// Mirrors dashboardSearchParams but omits `instrument_id` (implicit from the
// route segment). Sort defaults to acquisition time, newest first.
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
  // Aunty metadata column filters. Temperature is a `start|end` pair of the
  // stored °C values (e.g. "25|95") so the URL stays a single token.
  aunty_experiment_type: parseAsString,
  aunty_analysis_mode: parseAsString,
  aunty_temperature: parseAsString,
  aunty_ramp_rate: parseAsString,
  // Attribution filter: either a userId or the reserved sentinel "unattributed".
  ran_by: parseAsString,
  ...notebookFilterSearchParams,
  // Derived run status, multi-select. Empty array = no filter (show all).
  status: parseAsRunStatuses
    .withDefault([])
    .withOptions({ clearOnDefault: true }),
  ...runSortSearchParams,
};

export const instrumentDetailParamsCache = createSearchParamsCache(
  instrumentDetailSearchParams
);

// Watcher page filters, shared by the Activity and Health tabs. `date_from` and
// `date_to` are the range that `RunsDateFilter` writes. `event_type` and `shown`
// are Activity's: the event types to list, and how many rows are showing (the
// "Show more" button asks for another page of them). The tab is the route, and
// `?watcher=` and `?focus=` are read by the pages themselves.
//
// `since` (Health) and `events_since` (Activity) are what links to the old
// one-day toolbars carry. They are read, so those links still work, and cleared
// whenever a new range is picked, but never written.
export const WATCHER_EVENTS_PAGE_SIZE = 20;

/** The most events "Show more" reveals. A longer log needs a narrower range. */
export const WATCHER_EVENTS_MAX_SHOWN = 1000;

export const watcherDetailSearchParams = {
  event_type: parseAsArrayOf(parseAsString).withDefault([]),
  date_from: parseAsString.withOptions({ clearOnDefault: true }),
  date_to: parseAsString.withOptions({ clearOnDefault: true }),
  shown: parseAsInteger
    .withDefault(WATCHER_EVENTS_PAGE_SIZE)
    .withOptions({ clearOnDefault: true }),
  since: parseAsString,
  events_since: parseAsString,
};

export const watcherDetailParamsCache = createSearchParamsCache(
  watcherDetailSearchParams
);

// Run detail page: the files table is server-paginated, so its search /
// filter / sort / page state lives in the URL. Keys are prefixed `files_` so
// they don't collide with the comments section or future run-detail params.
// This single object is the source of truth for both the server cache below
// and the client `useQueryStates` in the files toolbar.
//
// Category and lifecycle status are independent multi-selects. Empty array =
// no filter (show all), matching dashboard/instrument `status` arrays.
const FILES_CATEGORY_VALUES = ["raw", "processed"] as const;

const FILES_SORT_VALUES = ["name", "size", "date", "status"] as const;

// `files_sort` is the column and `files_order` its direction, both set by a
// column header's menu. `files_deleted` shows deleted files. Its old name,
// `files_dismissed`, is still read so saved links keep working, but never
// written.
export const runDetailSearchParams = {
  files_page: parseAsInteger.withDefault(1),
  files_search: parseAsString.withDefault(""),
  files_category: parseAsArrayOf(parseAsStringLiteral(FILES_CATEGORY_VALUES))
    .withDefault([])
    .withOptions({ clearOnDefault: true }),
  files_status: parseAsArrayOf(
    parseAsStringLiteral(FILES_LIFECYCLE_FILTER_VALUES)
  )
    .withDefault([])
    .withOptions({ clearOnDefault: true }),
  files_sort: parseAsStringLiteral(FILES_SORT_VALUES).withDefault("name"),
  files_order: parseAsStringLiteral(RUN_SORT_ORDERS)
    .withDefault("asc")
    .withOptions({ clearOnDefault: true }),
  files_deleted: parseAsBoolean
    .withDefault(false)
    .withOptions({ clearOnDefault: true }),
  files_dismissed: parseAsBoolean.withDefault(false),
};

/** Whether the files table lists deleted files, by either of the two params. */
export function filesShowDeleted(params: {
  files_deleted: boolean;
  files_dismissed: boolean;
}): boolean {
  return params.files_deleted || params.files_dismissed;
}

export const runDetailParamsCache = createSearchParamsCache(
  runDetailSearchParams
);

// The `/lab-notebooks` index. `q` is a name, part of a description, or a pasted
// link. The sorts are the ones `listNotebooks` takes that have a column; a
// missing `order` leaves it to the sort (A to Z for names, otherwise largest
// or newest first).
export const NOTEBOOK_LIST_SORT_FIELDS = [
  "last_run",
  "name",
  "run_count",
] as const;

export const notebooksIndexSearchParams = {
  q: parseAsString.withDefault(""),
  include_deleted: parseAsBoolean
    .withDefault(false)
    .withOptions({ clearOnDefault: true }),
  sort: parseAsStringLiteral(NOTEBOOK_LIST_SORT_FIELDS)
    .withDefault("last_run")
    .withOptions({ clearOnDefault: true }),
  order: parseAsStringLiteral(RUN_SORT_ORDERS),
  page: parseAsInteger.withDefault(1),
};

export const notebooksIndexParamsCache = createSearchParamsCache(
  notebooksIndexSearchParams
);

// Cross-run comments page. `author` and `ran_by` are mutually exclusive in
// the UI (a person filter replaces the All / Comments on my runs choice) but
// the query applies whichever are present. `instrument_id` narrows that scope.
export const commentsSearchParams = {
  author: parseAsString,
  ran_by: parseAsString,
  instrument_id: parseAsArrayOf(parseAsString).withDefault([]),
  page: parseAsInteger.withDefault(1),
};

export const commentsParamsCache =
  createSearchParamsCache(commentsSearchParams);

// The changelog window opens over whichever page is showing, so a link can
// carry this key on any signed-in page. It holds an entry ID and is only
// written by links, never by opening the window from the account menu.
export const changelogSearchParams = {
  changelog: parseAsString,
};

export function hasActiveFilters(params: {
  search: string;
  instrument_id: string[];
  date_from: string | null;
  date_to: string | null;
  include_deleted: boolean;
  status: RunStatus[];
  ran_by: string | null;
  has_lab_notebook: string | null;
  lab_notebook_id: string | null;
}): boolean {
  return (
    params.search !== "" ||
    params.instrument_id.length > 0 ||
    params.date_from !== null ||
    params.date_to !== null ||
    params.include_deleted ||
    params.status.length > 0 ||
    params.ran_by !== null ||
    params.has_lab_notebook !== null ||
    params.lab_notebook_id !== null
  );
}

// Every nullable filter on an instrument's runs table. The toolbar's "Clear"
// button and the page's empty-state message both read this list, so a filter
// added to `instrumentDetailSearchParams` is covered in one place.
export const INSTRUMENT_NULLABLE_FILTER_KEYS = [
  "date_from",
  "date_to",
  "wavelength",
  "measurement_mode",
  "measurement_type",
  "capture_type",
  "imaging_mode",
  "gel_wavelength",
  "gel_color",
  "dye_channel",
  "hina_channel",
  "hina_dimension",
  "hina_size",
  "dpi",
  "color_mode",
  "aunty_experiment_type",
  "aunty_analysis_mode",
  "aunty_temperature",
  "aunty_ramp_rate",
  "ran_by",
  "has_lab_notebook",
  "lab_notebook_id",
] as const;

type InstrumentFilterParams = {
  search: string;
  include_deleted: boolean;
  status: RunStatus[];
} & Record<(typeof INSTRUMENT_NULLABLE_FILTER_KEYS)[number], string | null>;

export function hasActiveInstrumentFilters(
  params: InstrumentFilterParams
): boolean {
  return (
    params.search !== "" ||
    params.include_deleted ||
    params.status.length > 0 ||
    INSTRUMENT_NULLABLE_FILTER_KEYS.some((key) => params[key] !== null)
  );
}

/** Values that put every instrument filter back to its default. */
export function clearedInstrumentFilters() {
  return {
    search: "",
    include_deleted: false,
    status: [] as RunStatus[],
    page: 1,
    ...(Object.fromEntries(
      INSTRUMENT_NULLABLE_FILTER_KEYS.map((key) => [key, null])
    ) as Record<(typeof INSTRUMENT_NULLABLE_FILTER_KEYS)[number], null>),
  };
}
