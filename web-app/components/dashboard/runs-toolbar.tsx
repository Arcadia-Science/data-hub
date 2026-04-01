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
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { dashboardSearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";
import {
  CalendarDays,
  Check,
  ChevronsUpDown,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useQueryStates } from "nuqs";
import { useState } from "react";

type Instrument = {
  id: string;
  displayName: string;
};

export function RunsToolbar({ instruments }: { instruments: Instrument[] }) {
  const [filters, setFilters] = useQueryStates(dashboardSearchParams, {
    shallow: false,
    throttleMs: 300,
  });

  const [instrumentOpen, setInstrumentOpen] = useState(false);

  const hasFilters =
    filters.search !== "" ||
    filters.instrument_id.length > 0 ||
    filters.date_from !== null ||
    filters.date_to !== null ||
    filters.include_deleted;

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

          {/* Date range */}
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

          {/* Show deleted toggle */}
          <div className="flex items-center gap-2">
            <Switch
              id="include-deleted"
              checked={filters.include_deleted}
              onCheckedChange={(checked) =>
                setFilters({ include_deleted: checked, page: 1 })
              }
            />
            <Label
              htmlFor="include-deleted"
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
