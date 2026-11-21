// What the run page's files table can be narrowed by, as the toolbar reads it.
// Client-safe, so the "Add filter" button can count filters without importing
// the menu, which loads on demand.

/** How many choices are on in the "Add filter" menu, for the button's badge. */
export function countActiveFileFilters(filters: {
  categories: readonly string[];
  showDeleted: boolean;
  statuses: readonly string[];
}): number {
  return (
    (filters.showDeleted ? 1 : 0) +
    filters.categories.length +
    filters.statuses.length
  );
}

/**
 * Whether the toolbar's search or filters narrow which files a download holds.
 * Showing deleted files does not: an archive never holds a deleted file, so
 * that choice leaves "Download all" as it was.
 */
export function narrowsFileDownload(filters: {
  categories: readonly string[];
  search: string;
  statuses: readonly string[];
}): boolean {
  return (
    filters.search.trim() !== "" ||
    filters.categories.length > 0 ||
    filters.statuses.length > 0
  );
}
