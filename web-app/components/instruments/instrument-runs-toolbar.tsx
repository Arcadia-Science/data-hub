"use client";

import { useTablePending } from "@/components/table-pending";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { instrumentDetailSearchParams } from "@/lib/search-params";
import { CalendarDays, Search, Trash2, X } from "lucide-react";
import { useQueryStates } from "nuqs";

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
            placeholder="Search runs..."
            value={filters.search}
            onChange={(e) => setFilters({ search: e.target.value, page: 1 })}
            className="pl-9"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearFilters}
              className="h-8 gap-1 text-xs"
            >
              <X className="size-3" />
              Clear
            </Button>
          )}

          <div className="flex items-center gap-2">
            <CalendarDays className="size-3.5 text-muted-foreground" />
            <Input
              type="date"
              value={filters.date_from ?? ""}
              onChange={(e) =>
                setFilters({
                  date_from: e.target.value || null,
                  page: 1,
                })
              }
              className="h-9 w-36 text-xs"
              aria-label="Date from"
            />
            <span className="text-xs text-muted-foreground">&ndash;</span>
            <Input
              type="date"
              value={filters.date_to ?? ""}
              onChange={(e) =>
                setFilters({
                  date_to: e.target.value || null,
                  page: 1,
                })
              }
              className="h-9 w-36 text-xs"
              aria-label="Date to"
            />
          </div>

          <div className="flex items-center gap-2">
            <Switch
              id="include-deleted-detail"
              checked={filters.include_deleted}
              onCheckedChange={(checked) =>
                setFilters({ include_deleted: checked, page: 1 })
              }
            />
            <Label
              htmlFor="include-deleted-detail"
              className="flex cursor-pointer items-center gap-1 text-xs"
            >
              <Trash2 className="size-3" />
              Deleted
            </Label>
          </div>
        </div>
      </div>
    </div>
  );
}
