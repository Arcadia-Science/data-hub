"use client";

import { parseAsInteger, useQueryStates } from "nuqs";
import { SortableTableHead } from "@/components/sortable-table-head";
import { useTablePending } from "@/components/table-pending";
import { type RUN_SORT_FIELDS, runSortSearchParams } from "@/lib/search-params";

// Same parsers on the dashboard, a member's runs page, and every instrument
// page, so this header does not need a source prop. `page` resets with the
// sort so a new order does not land on an empty page.
const runListSortParams = {
  ...runSortSearchParams,
  page: parseAsInteger.withDefault(1),
};

type RunSortField = (typeof RUN_SORT_FIELDS)[number];

export function SortableColumnHeader({
  label,
  field,
}: {
  label: string;
  field: RunSortField;
}) {
  const { startTransition } = useTablePending();
  const [sortState, setSortState] = useQueryStates(runListSortParams, {
    shallow: false,
    startTransition,
  });

  return (
    <SortableTableHead
      active={sortState.sort === field}
      align="end"
      label={label}
      onOrderChange={(order) => setSortState({ sort: field, order, page: 1 })}
      order={sortState.order}
    />
  );
}
