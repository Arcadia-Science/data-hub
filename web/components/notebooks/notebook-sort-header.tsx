"use client";

import { useQueryStates } from "nuqs";
import { SortableTableHead } from "@/components/sortable-table-head";
import { useTablePending } from "@/components/table-pending";
import {
  type NOTEBOOK_LIST_SORT_FIELDS,
  notebooksIndexSearchParams,
} from "@/lib/search-params";

type NotebookSortField = (typeof NOTEBOOK_LIST_SORT_FIELDS)[number];

const sortParams = {
  sort: notebooksIndexSearchParams.sort,
  order: notebooksIndexSearchParams.order,
  page: notebooksIndexSearchParams.page,
};

// The order a sort uses when the URL doesn't say, matching `listNotebooks`.
function defaultOrder(field: NotebookSortField): "asc" | "desc" {
  return field === "name" ? "asc" : "desc";
}

/**
 * A `/lab-notebooks` column header with a menu to sort by that column, the way
 * the runs tables sort by time. Picking an order goes back to page 1.
 */
export function NotebookSortHeader({
  label,
  field,
  align = "start",
}: {
  label: string;
  field: NotebookSortField;
  align?: "start" | "end";
}) {
  const { startTransition } = useTablePending();
  const [state, setState] = useQueryStates(sortParams, {
    shallow: false,
    startTransition,
  });

  return (
    <SortableTableHead
      active={state.sort === field}
      align={align}
      label={label}
      onOrderChange={(order) =>
        setState({
          sort: field,
          // The column's own default stays out of the URL.
          order: order === defaultOrder(field) ? null : order,
          page: null,
        })
      }
      order={state.order ?? defaultOrder(field)}
    />
  );
}
