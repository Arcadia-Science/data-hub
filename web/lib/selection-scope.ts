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

// Params on the dashboard, instrument, and member run lists that do not change
// which runs are listed. `comments_*` belong to the comments preview on the
// dashboard.
const RUN_LIST_UNRELATED_PARAMS = new Set([
  "page",
  "per_page",
  "comments_from",
  "comments_to",
]);

export function isRunListScopeParam(key: string): boolean {
  return !RUN_LIST_UNRELATED_PARAMS.has(key);
}

// The run page's files table keeps its search, filters, and sort in `files_*`
// params; `files_page` only moves between pages of the same results.
export function isFilesScopeParam(key: string): boolean {
  return key.startsWith("files_") && key !== "files_page";
}
