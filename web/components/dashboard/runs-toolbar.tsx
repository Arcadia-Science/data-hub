"use client";

import { X } from "lucide-react";
import { useQueryStates } from "nuqs";
import { RunFiltersCombobox } from "@/components/runs/run-filters-combobox";
import {
  type PresetId,
  RunsDateFilter,
} from "@/components/runs/runs-date-filter";
import { useTablePending } from "@/components/table-pending";
import { Button } from "@/components/ui/button";
import {
  ALL_TIME_DATE_FROM,
  dashboardSearchParams,
  hasActiveFilters,
} from "@/lib/search-params";

/**
 * The Clear button, date range, and Add filter menu that sit beside the
 * "Instrument runs" heading. The run ID and instrument filters are in the
 * table's column headers, and Clear resets them too.
 */
export function RunsToolbar({
  dateDefaultPreset,
}: {
  // The page's server-side default date window, reflected in the date filter's
  // label/highlight. Omitted on pages that show all runs by default (e.g. "My
  // activity"), which surfaces an "All time" option instead.
  dateDefaultPreset?: PresetId;
}) {
  const { startTransition } = useTablePending();
  const [filters, setFilters] = useQueryStates(dashboardSearchParams, {
    shallow: false,
    throttleMs: 300,
    startTransition,
  });

  const hasFilters = hasActiveFilters(filters);

  function clearFilters() {
    setFilters({
      search: "",
      instrument_id: [],
      date_from: null,
      date_to: null,
      include_deleted: false,
      status: [],
      ran_by: null,
      has_lab_notebook: null,
      lab_notebook_id: null,
      page: 1,
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {hasFilters && (
        <Button
          className="h-9 gap-1.5 font-normal text-sm"
          onClick={clearFilters}
          size="sm"
          variant="ghost"
        >
          <X className="size-3.5" />
          Clear
        </Button>
      )}

      <RunsDateFilter
        align="end"
        allTimeFrom={dateDefaultPreset ? ALL_TIME_DATE_FROM : undefined}
        defaultPreset={dateDefaultPreset}
        onChange={(range) =>
          setFilters({
            date_from: range.from,
            date_to: range.to,
            page: 1,
          })
        }
        value={{ from: filters.date_from, to: filters.date_to }}
      />

      <RunFiltersCombobox
        onChange={({ includeDeleted }) =>
          setFilters({ include_deleted: includeDeleted, page: 1 })
        }
        onStatusChange={(next) => setFilters({ status: next, page: 1 })}
        selectedStatuses={filters.status}
        values={{ includeDeleted: filters.include_deleted }}
      />
    </div>
  );
}
