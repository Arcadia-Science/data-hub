"use client";

import { Search, X } from "lucide-react";
import { useQueryStates } from "nuqs";
import { RunFiltersCombobox } from "@/components/runs/run-filters-combobox";
import { RunsDateFilter } from "@/components/runs/runs-date-filter";
import { useTablePending } from "@/components/table-pending";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { instrumentDetailSearchParams } from "@/lib/search-params";

export function InstrumentRunsToolbar() {
  // shallow: false triggers a server-side re-fetch on every URL change so the
  // table data stays in sync. throttleMs debounces rapid keystrokes in search.
  // startTransition ties the refetch to the table's pending/stale treatment.
  const { startTransition } = useTablePending();
  const [filters, setFilters] = useQueryStates(instrumentDetailSearchParams, {
    shallow: false,
    throttleMs: 300,
    startTransition,
  });

  const hasFilters =
    filters.search !== "" ||
    filters.date_from !== null ||
    filters.date_to !== null ||
    filters.include_deleted ||
    filters.wavelength !== null ||
    filters.measurement_mode !== null ||
    filters.measurement_type !== null;

  function clearFilters() {
    setFilters({
      search: "",
      date_from: null,
      date_to: null,
      include_deleted: false,
      wavelength: null,
      measurement_mode: null,
      measurement_type: null,
      page: 1,
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="relative w-64">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            onChange={(e) => setFilters({ search: e.target.value, page: 1 })}
            placeholder="Search runs..."
            value={filters.search}
          />
        </div>

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
            values={{ includeDeleted: filters.include_deleted }}
          />
        </div>
      </div>
    </div>
  );
}
