"use client";

import { X } from "lucide-react";
import { useQueryStates } from "nuqs";
import { RunsDateFilter } from "@/components/runs/runs-date-filter";
import { useTablePending } from "@/components/table-pending";
import { Button } from "@/components/ui/button";
import { ALL_TIME_DATE_FROM, dashboardSearchParams } from "@/lib/search-params";

const filterParams = {
  notebooks_q: dashboardSearchParams.notebooks_q,
  notebooks_owner: dashboardSearchParams.notebooks_owner,
  notebooks_from: dashboardSearchParams.notebooks_from,
  notebooks_to: dashboardSearchParams.notebooks_to,
  notebooks_page: dashboardSearchParams.notebooks_page,
};

/**
 * The date range and Clear button beside Home's "Lab notebooks" heading. The
 * range lists the notebooks that got a run in it, today unless the URL says
 * otherwise. Clear also resets the Name and Owner column filters, whose
 * headers are gone when no notebook matches. A change goes back to page 1.
 */
export function NotebookListFilters() {
  const { startTransition } = useTablePending();
  const [filters, setFilters] = useQueryStates(filterParams, {
    shallow: false,
    startTransition,
  });
  const hasFilters =
    filters.notebooks_q !== "" ||
    filters.notebooks_owner !== null ||
    filters.notebooks_from !== null ||
    filters.notebooks_to !== null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {hasFilters ? (
        <Button
          className="h-9 gap-1.5 font-normal text-sm"
          onClick={() =>
            setFilters({
              notebooks_q: null,
              notebooks_owner: null,
              notebooks_from: null,
              notebooks_to: null,
              notebooks_page: null,
            })
          }
          size="sm"
          variant="ghost"
        >
          <X className="size-3.5" />
          Clear
        </Button>
      ) : null}
      <RunsDateFilter
        align="end"
        allTimeFrom={ALL_TIME_DATE_FROM}
        defaultPreset="today"
        onChange={(range) =>
          setFilters({
            notebooks_from: range.from,
            notebooks_to: range.to,
            notebooks_page: null,
          })
        }
        value={{ from: filters.notebooks_from, to: filters.notebooks_to }}
      />
    </div>
  );
}
