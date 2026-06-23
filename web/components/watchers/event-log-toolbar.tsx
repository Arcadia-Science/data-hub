"use client";

import { CalendarDays, Filter, X } from "lucide-react";
import { useQueryStates } from "nuqs";
import { useTablePending } from "@/components/table-pending";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { todayDateString } from "@/lib/date";
import { watcherDetailSearchParams } from "@/lib/search-params";

const EVENT_TYPES = [
  { value: "watcher_started", label: "Started" },
  { value: "watcher_stopped", label: "Stopped" },
  { value: "file_uploaded", label: "File Uploaded" },
  { value: "upload_failed", label: "Upload Failed" },
  { value: "run_reported", label: "Run Reported" },
  { value: "config_synced", label: "Config Synced" },
  { value: "error", label: "Error" },
] as const;

export function EventLogToolbar() {
  // shallow: false pushes filter changes to the URL and triggers a full
  // server-side re-render, so the event list refetches with the new filters.
  // startTransition ties the refetch to the surrounding table's pending UI.
  const { startTransition } = useTablePending();
  const [filters, setFilters] = useQueryStates(watcherDetailSearchParams, {
    shallow: false,
    throttleMs: 300,
    startTransition,
  });

  const today = todayDateString();
  const hasFilters =
    filters.event_type.length > 0 ||
    (filters.events_since !== null && filters.events_since !== today);

  function toggleEventType(type: string) {
    const current = filters.event_type;
    const next = current.includes(type)
      ? current.filter((t) => t !== type)
      : [...current, type];
    setFilters({ event_type: next, logs_page: null });
  }

  function clearFilters() {
    setFilters({
      event_type: [],
      events_since: null,
      logs_page: null,
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {hasFilters && (
        <Button
          className="h-8 gap-1 text-xs"
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
          <Button className="h-8 gap-1 text-sm" size="sm" variant="outline">
            <Filter className="size-3" />
            Event Type
            {filters.event_type.length > 0 && (
              <span className="ml-1 rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">
                {filters.event_type.length}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-48 p-2">
          <div className="flex flex-col gap-1">
            {EVENT_TYPES.map((et) => (
              <div
                className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-muted"
                key={et.value}
              >
                <Checkbox
                  checked={filters.event_type.includes(et.value)}
                  id={`event-type-${et.value}`}
                  onCheckedChange={() => toggleEventType(et.value)}
                />
                <Label
                  className="flex-1 cursor-pointer font-normal"
                  htmlFor={`event-type-${et.value}`}
                >
                  {et.label}
                </Label>
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      <div className="flex items-center gap-2">
        <CalendarDays className="size-3.5 text-muted-foreground" />
        <Input
          aria-label="Events since"
          className="h-8 w-36 text-xs"
          onChange={(e) =>
            setFilters({
              events_since: e.target.value || null,
              logs_page: null,
            })
          }
          type="date"
          value={filters.events_since ?? today}
        />
      </div>
    </div>
  );
}
