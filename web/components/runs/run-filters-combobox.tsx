"use client";

import { ListFilter } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";
import { LoadErrorBoundary } from "@/components/load-error-boundary";
import {
  RUN_FILTERS,
  type RunFilterValues,
} from "@/components/runs/run-filters";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { preloader } from "@/lib/preload";
import type { RunStatus } from "@/lib/runs/run-status";

// The menu uses the command palette library, which most page visits never
// need. It loads when the popover first opens, or earlier when the pointer or
// focus reaches the button.
const loadRunFiltersList = () =>
  import("@/components/runs/run-filters-list").then((m) => m.RunFiltersList);

const preloadRunFiltersList = preloader(loadRunFiltersList);

const RunFiltersList = dynamic(loadRunFiltersList, {
  ssr: false,
  loading: () => (
    <div aria-hidden className="flex flex-col gap-2 p-2">
      <Skeleton className="h-6 w-full" />
      <Skeleton className="h-6 w-full" />
    </div>
  ),
});

export function RunFiltersCombobox({
  values,
  onChange,
  selectedStatuses,
  onStatusChange,
}: {
  values: RunFilterValues;
  onChange: (next: RunFilterValues) => void;
  // When both are provided, a multi-select STATUS group is rendered.
  selectedStatuses?: RunStatus[];
  onStatusChange?: (next: RunStatus[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const activeCount =
    RUN_FILTERS.reduce((count, f) => (values[f.key] ? count + 1 : count), 0) +
    (selectedStatuses?.length ?? 0);

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-expanded={open}
          className="h-9 gap-2 font-normal"
          onFocus={preloadRunFiltersList}
          onMouseEnter={preloadRunFiltersList}
          role="combobox"
          size="sm"
          variant="outline"
        >
          <ListFilter className="size-3.5 text-muted-foreground" />
          <span className="text-sm">Add filter</span>
          {activeCount > 0 && (
            <Badge className="ml-0.5 px-1.5 text-[10px]" variant="secondary">
              {activeCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <LoadErrorBoundary>
          <RunFiltersList
            onChange={onChange}
            onStatusChange={onStatusChange}
            selectedStatuses={selectedStatuses}
            values={values}
          />
        </LoadErrorBoundary>
      </PopoverContent>
    </Popover>
  );
}
