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
  CommandSeparator,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { RUN_STATUS_OPTIONS, type RunStatus } from "@/lib/runs/run-status";
import { cn } from "@/lib/utils";

interface FilterValues {
  includeDeleted: boolean;
}

interface FilterDef {
  icon: ComponentType<{ className?: string }>;
  key: keyof FilterValues;
  label: string;
}

const FILTERS: readonly FilterDef[] = [
  { key: "includeDeleted", label: "Show deleted runs", icon: Trash2 },
] as const;

export function RunFiltersCombobox({
  values,
  onChange,
  selectedStatuses,
  onStatusChange,
}: {
  values: FilterValues;
  onChange: (next: FilterValues) => void;
  // When both are provided, a multi-select STATUS group is rendered.
  selectedStatuses?: RunStatus[];
  onStatusChange?: (next: RunStatus[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const showStatus =
    selectedStatuses !== undefined && onStatusChange !== undefined;
  const activeCount =
    FILTERS.reduce((count, f) => (values[f.key] ? count + 1 : count), 0) +
    (selectedStatuses?.length ?? 0);

  function toggleStatus(status: RunStatus) {
    const current = selectedStatuses ?? [];
    const next = current.includes(status)
      ? current.filter((s) => s !== status)
      : [...current, status];
    onStatusChange?.(next);
  }

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
            {showStatus && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Status">
                  {RUN_STATUS_OPTIONS.map((status) => {
                    const Icon = status.Icon;
                    const active = selectedStatuses?.includes(status.value);
                    return (
                      <CommandItem
                        data-checked={active}
                        key={status.value}
                        onSelect={() => toggleStatus(status.value)}
                        value={status.label}
                      >
                        <Icon
                          className={cn(
                            status.colorClassName,
                            status.spin && "animate-spin"
                          )}
                        />
                        {status.label}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
