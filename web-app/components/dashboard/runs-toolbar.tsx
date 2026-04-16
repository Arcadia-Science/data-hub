"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toDateInputValue } from "@/lib/date";
import { dashboardSearchParams, hasActiveFilters } from "@/lib/search-params";
import { cn } from "@/lib/utils";
import { Check, ChevronsUpDown, Search, X } from "lucide-react";
import { useQueryStates } from "nuqs";
import { useMemo, useState } from "react";

type Instrument = {
  id: string;
  displayName: string;
};

const DATE_PRESETS = [
  { value: "today", label: "Last 24 hours", days: 0 },
  { value: "3d", label: "Last 3 days", days: 3 },
  { value: "1w", label: "Last week", days: 7 },
  { value: "2w", label: "Last 2 weeks", days: 14 },
  { value: "1m", label: "Last month", days: 30 },
] as const;

function dateFromDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return toDateInputValue(d);
}

function resolvePreset(dateFrom: string | null): string {
  if (!dateFrom) return "today";
  for (const preset of DATE_PRESETS) {
    if (dateFrom === dateFromDaysAgo(preset.days)) return preset.value;
  }
  return "";
}

export function RunsToolbar({ instruments }: { instruments: Instrument[] }) {
  const [filters, setFilters] = useQueryStates(dashboardSearchParams, {
    shallow: false,
    throttleMs: 300,
  });

  const [instrumentOpen, setInstrumentOpen] = useState(false);

  const hasFilters = hasActiveFilters(filters);

  const activePreset = useMemo(
    () => resolvePreset(filters.date_from),
    [filters.date_from]
  );

  // Reset to page 1 whenever filters change to avoid landing on an empty page.
  function toggleInstrument(id: string) {
    const current = filters.instrument_id;
    const next = current.includes(id)
      ? current.filter((i) => i !== id)
      : [...current, id];
    setFilters({ instrument_id: next, page: 1 });
  }

  function clearFilters() {
    setFilters({
      search: "",
      instrument_id: [],
      date_from: null,
      date_to: null,
      include_deleted: false,
      page: 1,
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* Search */}
          <div className="relative w-64">
            <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search runs..."
              value={filters.search}
              onChange={(e) => setFilters({ search: e.target.value, page: 1 })}
              className="pl-9"
            />
          </div>

          {/* Instrument multi-select */}
          <Popover open={instrumentOpen} onOpenChange={setInstrumentOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-9 gap-1.5"
                role="combobox"
                aria-expanded={instrumentOpen}
              >
                <ChevronsUpDown className="size-3.5 opacity-50" />
                Instrument
                {filters.instrument_id.length > 0 && (
                  <Badge
                    variant="secondary"
                    className="ml-1 px-1.5 text-[10px]"
                  >
                    {filters.instrument_id.length}
                  </Badge>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-0" align="start">
              <Command>
                <CommandInput placeholder="Filter instruments..." />
                <CommandList>
                  <CommandEmpty>No instruments found.</CommandEmpty>
                  <CommandGroup>
                    {instruments.map((inst) => {
                      const selected = filters.instrument_id.includes(inst.id);
                      return (
                        <CommandItem
                          key={inst.id}
                          value={inst.displayName}
                          onSelect={() => toggleInstrument(inst.id)}
                        >
                          <Check
                            className={cn(
                              "mr-2 size-4",
                              selected ? "opacity-100" : "opacity-0"
                            )}
                          />
                          {inst.displayName}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Clear filters */}
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

          {/* Date range preset */}
          <Select
            value={activePreset}
            onValueChange={(value) => {
              const preset = DATE_PRESETS.find((p) => p.value === value);
              if (preset) {
                setFilters({
                  date_from: dateFromDaysAgo(preset.days),
                  date_to: null,
                  page: 1,
                });
              }
            }}
          >
            <SelectTrigger className="min-h-8.5 w-40 text-sm">
              <SelectValue placeholder="Date range" />
            </SelectTrigger>
            <SelectContent>
              {DATE_PRESETS.map((p) => (
                <SelectItem key={p.value} value={p.value} className="text-sm">
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
