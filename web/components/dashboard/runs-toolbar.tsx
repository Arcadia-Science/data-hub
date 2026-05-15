"use client";

import { RunFiltersCombobox } from "@/components/runs/run-filters-combobox";
import { RunsDateFilter } from "@/components/runs/runs-date-filter";
import { useTablePending } from "@/components/table-pending";
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
import { dashboardSearchParams, hasActiveFilters } from "@/lib/search-params";
import { cn } from "@/lib/utils";
import { Check, ChevronsUpDown, Search, X } from "lucide-react";
import { useQueryStates } from "nuqs";
import { useState } from "react";

type Instrument = {
  id: string;
  displayName: string;
};

export function RunsToolbar({ instruments }: { instruments: Instrument[] }) {
  const { startTransition } = useTablePending();
  const [filters, setFilters] = useQueryStates(dashboardSearchParams, {
    shallow: false,
    throttleMs: 300,
    startTransition,
  });

  const [instrumentOpen, setInstrumentOpen] = useState(false);

  const hasFilters = hasActiveFilters(filters);

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
                Instruments
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
            <PopoverContent className="w-72 p-0" align="start">
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
              className="h-9 gap-1.5 text-sm font-normal"
            >
              <X className="size-3.5" />
              Clear
            </Button>
          )}

          <RunsDateFilter
            value={{ from: filters.date_from, to: filters.date_to }}
            onChange={(range) =>
              setFilters({
                date_from: range.from,
                date_to: range.to,
                page: 1,
              })
            }
            align="end"
            defaultPreset="24h"
          />

          <RunFiltersCombobox
            values={{ includeDeleted: filters.include_deleted }}
            onChange={({ includeDeleted }) =>
              setFilters({ include_deleted: includeDeleted, page: 1 })
            }
          />
        </div>
      </div>
    </div>
  );
}
