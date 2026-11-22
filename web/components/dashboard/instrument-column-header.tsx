"use client";

import { ChevronsUpDown, ListFilter } from "lucide-react";
import dynamic from "next/dynamic";
import { useQueryStates } from "nuqs";
import { FILTERED_COLUMN_HEADER_CLASS_NAME } from "@/components/instruments/runs-table/filterable-column-header";
import { LoadErrorBoundary } from "@/components/load-error-boundary";
import { useTablePending } from "@/components/table-pending";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { preloader } from "@/lib/preload";
import { dashboardSearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

export interface InstrumentFilterOption {
  displayName: string;
  id: string;
}

const filterParams = {
  instrument_id: dashboardSearchParams.instrument_id,
  page: dashboardSearchParams.page,
};

// The list uses the command palette library, which the runs table doesn't
// otherwise need. It loads when the menu first opens, or earlier when the
// pointer or focus reaches the header.
const loadInstrumentFilterList = () =>
  import("@/components/dashboard/instrument-filter-list").then(
    (m) => m.InstrumentFilterList
  );

const preloadInstrumentFilterList = preloader(loadInstrumentFilterList);

const InstrumentFilterList = dynamic(loadInstrumentFilterList, {
  ssr: false,
  loading: () => (
    <div aria-hidden className="flex flex-col gap-2 p-2">
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-6 w-full" />
      <Skeleton className="h-6 w-full" />
    </div>
  ),
});

/**
 * The "Instrument" column header: a menu that filters the runs table to one
 * or more instruments. A change goes back to page 1.
 */
export function InstrumentColumnHeader({
  instruments,
}: {
  instruments: InstrumentFilterOption[];
}) {
  const { startTransition } = useTablePending();
  const [params, setParams] = useQueryStates(filterParams, {
    shallow: false,
    throttleMs: 300,
    startTransition,
  });
  const selectedIds = params.instrument_id;
  const filtered = selectedIds.length > 0;

  function toggle(id: string) {
    const next = selectedIds.includes(id)
      ? selectedIds.filter((selected) => selected !== id)
      : [...selectedIds, id];
    setParams({ instrument_id: next, page: 1 });
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          className={cn(
            "-ml-2 h-8 gap-1 font-medium",
            filtered && FILTERED_COLUMN_HEADER_CLASS_NAME
          )}
          onFocus={preloadInstrumentFilterList}
          onMouseEnter={preloadInstrumentFilterList}
          size="sm"
          variant="ghost"
        >
          {filtered ? (
            <ListFilter className="size-3" />
          ) : (
            <ChevronsUpDown className="size-3 opacity-50" />
          )}
          Instrument
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <LoadErrorBoundary>
          <InstrumentFilterList
            instruments={instruments}
            onToggle={toggle}
            selectedIds={selectedIds}
          />
        </LoadErrorBoundary>
      </PopoverContent>
    </Popover>
  );
}
