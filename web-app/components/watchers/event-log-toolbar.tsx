"use client";

import { useTablePending } from "@/components/table-pending";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { watcherDetailSearchParams } from "@/lib/search-params";
import { CalendarDays, Filter, X } from "lucide-react";
import { useQueryStates } from "nuqs";

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

  const hasFilters =
    filters.event_type.length > 0 || filters.events_since !== null;

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
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="h-8 gap-1 text-xs">
            <Filter className="size-3" />
            Event Type
            {filters.event_type.length > 0 && (
              <span className="ml-1 rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">
                {filters.event_type.length}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-48 p-2" align="start">
          <div className="flex flex-col gap-1">
            {EVENT_TYPES.map((et) => (
              <label
                key={et.value}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-muted"
              >
                <Checkbox
                  checked={filters.event_type.includes(et.value)}
                  onCheckedChange={() => toggleEventType(et.value)}
                />
                {et.label}
              </label>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      <div className="flex items-center gap-2">
        <CalendarDays className="size-3.5 text-muted-foreground" />
        <Input
          type="date"
          value={filters.events_since ?? ""}
          onChange={(e) =>
            setFilters({
              events_since: e.target.value || null,
              logs_page: null,
            })
          }
          className="h-8 w-36 text-xs"
          aria-label="Events since"
        />
      </div>

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
    </div>
  );
}
