"use client";

import { ListFilter, X } from "lucide-react";
import { useQueryStates } from "nuqs";
import type { DateRange } from "@/components/runs/runs-date-filter";
import { useTablePending } from "@/components/table-pending";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { WatcherRangeFilter } from "@/components/watchers/watcher-range-filter";
import { watcherDetailSearchParams } from "@/lib/search-params";
import { EVENT_TYPE_OPTIONS } from "@/lib/watchers/event-messages";

/**
 * The Activity tab's filters: the event types to list and the days to list them
 * for. Both live in the URL, so a filtered log is a link.
 */
export function EventLogToolbar({
  rangeFallback,
}: {
  /** What the range picker shows when the URL names no range. */
  rangeFallback: DateRange;
}) {
  // shallow: false pushes a change to the URL and renders the page again on the
  // server, so the events are read again with the new filters.
  const { startTransition } = useTablePending();
  const [filters, setFilters] = useQueryStates(watcherDetailSearchParams, {
    shallow: false,
    startTransition,
  });

  const hasFilters =
    filters.event_type.length > 0 ||
    filters.date_from !== null ||
    filters.date_to !== null ||
    filters.since !== null ||
    filters.events_since !== null;

  function toggleEventType(type: string) {
    const current = filters.event_type;
    const next = current.includes(type)
      ? current.filter((t) => t !== type)
      : [...current, type];
    setFilters({ event_type: next, shown: null });
  }

  function clearFilters() {
    setFilters({
      event_type: [],
      date_from: null,
      date_to: null,
      since: null,
      events_since: null,
      shown: null,
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {hasFilters && (
        <Button
          className="h-9 gap-1 text-xs"
          onClick={clearFilters}
          size="sm"
          variant="ghost"
        >
          <X className="size-3" />
          Clear
        </Button>
      )}

      <Popover>
        <PopoverTrigger asChild>
          <Button className="h-9 gap-2 font-normal" size="sm" variant="outline">
            <ListFilter
              aria-hidden="true"
              className="size-3.5 text-muted-foreground"
            />
            <span className="text-sm">Event type</span>
            {filters.event_type.length > 0 && (
              <span className="rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">
                {filters.event_type.length}
                <span className="sr-only"> selected</span>
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-56 p-2">
          <div className="flex flex-col gap-1">
            {EVENT_TYPE_OPTIONS.map((option) => (
              <div
                className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-muted"
                key={option.value}
              >
                <Checkbox
                  checked={filters.event_type.includes(option.value)}
                  id={`event-type-${option.value}`}
                  onCheckedChange={() => toggleEventType(option.value)}
                />
                <Label
                  className="flex-1 cursor-pointer font-normal"
                  htmlFor={`event-type-${option.value}`}
                >
                  {option.label}
                </Label>
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      <WatcherRangeFilter fallback={rangeFallback} />
    </div>
  );
}
