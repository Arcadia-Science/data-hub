// The summary line under the files table, and the link beside it that shows or
// hides the deleted files.

export interface FilesFooter {
  // The link after the count, or null when there is nothing to show or hide.
  link: { label: string; show: boolean } | null;
  summary: string;
}

/**
 * "Showing 1–9 of 9" with "Show 6 deleted" beside it while deleted files that
 * match the search and filters are hidden, and "Showing 1–15 of 15, including
 * 6 deleted" with "Hide deleted" while they are listed. `activeTotal` is the run's
 * file count, for the empty page.
 */
export function filesFooter({
  activeTotal,
  deletedCount,
  page,
  perPage,
  showDeleted,
  total,
}: {
  activeTotal: number;
  deletedCount: number;
  page: number;
  perPage: number;
  showDeleted: boolean;
  total: number;
}): FilesFooter {
  const from = total === 0 ? 0 : (page - 1) * perPage + 1;
  const to = Math.min(page * perPage, total);
  const count =
    total === 0
      ? `Showing 0 of ${activeTotal}`
      : `Showing ${from}–${to} of ${total}`;
  if (deletedCount === 0) {
    return { summary: count, link: null };
  }
  return showDeleted
    ? {
        summary: `${count}, including ${deletedCount} deleted`,
        link: { label: "Hide deleted", show: false },
      }
    : {
        summary: count,
        link: { label: `Show ${deletedCount} deleted`, show: true },
      };
}
