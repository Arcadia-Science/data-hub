"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ListFilter, Trash2 } from "lucide-react";
import { useState, type ComponentType } from "react";

type FilterValues = {
  includeDeleted: boolean;
};

type FilterDef = {
  key: keyof FilterValues;
  label: string;
  icon: ComponentType<{ className?: string }>;
};

const FILTERS: readonly FilterDef[] = [
  { key: "includeDeleted", label: "Show deleted runs", icon: Trash2 },
] as const;

export function RunFiltersCombobox({
  values,
  onChange,
}: {
  values: FilterValues;
  onChange: (next: FilterValues) => void;
}) {
  const [open, setOpen] = useState(false);
  const activeCount = FILTERS.reduce(
    (count, f) => (values[f.key] ? count + 1 : count),
    0
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-9 gap-2 font-normal"
          role="combobox"
          aria-expanded={open}
        >
          <ListFilter className="size-3.5 text-muted-foreground" />
          <span className="text-sm">Add filter</span>
          {activeCount > 0 && (
            <Badge variant="secondary" className="ml-0.5 px-1.5 text-[10px]">
              {activeCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="end">
        <Command>
          <CommandList>
            <CommandGroup>
              {FILTERS.map((filter) => {
                const Icon = filter.icon;
                const active = values[filter.key];
                return (
                  <CommandItem
                    key={filter.key}
                    value={filter.label}
                    data-checked={active}
                    onSelect={() =>
                      onChange({ ...values, [filter.key]: !active })
                    }
                  >
                    <Icon className="size-3.5 text-muted-foreground" />
                    {filter.label}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
