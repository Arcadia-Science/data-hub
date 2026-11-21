"use client";

import { useQueryStates } from "nuqs";
import type { ReactNode } from "react";
import { SortableTableHead } from "@/components/sortable-table-head";
import { useTablePending } from "@/components/table-pending";
import type { FilesSortField } from "@/lib/api/instrument-runs";
import { runDetailSearchParams } from "@/lib/search-params";

// Only the sort params, so a header re-renders for a sort and not for a search.
// The page resets with the sort so a new order does not land on an empty page.
const filesSortParams = {
  files_sort: runDetailSearchParams.files_sort,
  files_order: runDetailSearchParams.files_order,
  files_page: runDetailSearchParams.files_page,
};

/**
 * A files table column header with a menu to sort by that column. The sort
 * lives in the URL as `files_sort` and `files_order`, like the files search and
 * filters, so a sorted table can be linked to.
 */
export function FilesSortHeader({
  align,
  field,
  label,
  trailing,
}: {
  align?: "start" | "end";
  field: FilesSortField;
  label: string;
  // A control beside the sort button, such as the Status legend.
  trailing?: ReactNode;
}) {
  const { startTransition } = useTablePending();
  const [sortState, setSortState] = useQueryStates(filesSortParams, {
    shallow: false,
    startTransition,
  });

  return (
    <SortableTableHead
      active={sortState.files_sort === field}
      align={align}
      label={label}
      onOrderChange={(order) =>
        setSortState({ files_sort: field, files_order: order, files_page: 1 })
      }
      order={sortState.files_order}
      trailing={trailing}
    />
  );
}
