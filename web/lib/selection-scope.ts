import {
  dashboardSearchParams,
  instrumentDetailSearchParams,
} from "@/lib/search-params";

/**
 * Identifies which list a selection was made on. Two URLs give the same key
 * when the same rows would be listed, so moving to another page of the results
 * keeps the key, while a new search, filter, or sort changes it. A selection
 * clears when the key changes, so hidden rows are never acted on by accident.
 */
export function selectionScopeKey(
  searchParams: URLSearchParams | string,
  isScopeParam: (key: string) => boolean
): string {
  const entries = [...new URLSearchParams(searchParams).entries()]
    .filter(([key]) => isScopeParam(key))
    .sort(([keyA, valueA], [keyB, valueB]) =>
      keyA === keyB ? valueA.localeCompare(valueB) : keyA.localeCompare(keyB)
    );
  return new URLSearchParams(entries).toString();
}

// Params that sit beside a run list without changing which runs it lists.
// `comments_*` drive the comments preview on the dashboard.
const NOT_RUN_LIST_PARAMS = new Set([
  "page",
  "per_page",
  "comments_from",
  "comments_to",
]);

// An allow-list built from the list pages' own param definitions, so an
// unrelated param such as the member page's `?comments=` tab never clears the
// selection, and a filter added to those definitions is covered automatically.
const RUN_LIST_PARAMS = new Set(
  [
    ...Object.keys(dashboardSearchParams),
    ...Object.keys(instrumentDetailSearchParams),
  ].filter((key) => !NOT_RUN_LIST_PARAMS.has(key))
);

export function isRunListScopeParam(key: string): boolean {
  return RUN_LIST_PARAMS.has(key);
}

// The run page's files table keeps its search, filters, and sort in `files_*`
// params; `files_page` only moves between pages of the same results.
export function isFilesScopeParam(key: string): boolean {
  return key.startsWith("files_") && key !== "files_page";
}
