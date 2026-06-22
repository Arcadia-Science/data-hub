"use client";

import { ListFilter, Trash2 } from "lucide-react";
import { type ComponentType, useState } from "react";
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
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-expanded={open}
          className="h-9 gap-2 font-normal"
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
        <Command>
          <CommandList>
            <CommandGroup>
              {FILTERS.map((filter) => {
                const Icon = filter.icon;
                const active = values[filter.key];
                return (
                  <CommandItem
                    data-checked={active}
                    key={filter.key}
                    onSelect={() =>
                      onChange({ ...values, [filter.key]: !active })
                    }
                    value={filter.label}
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
