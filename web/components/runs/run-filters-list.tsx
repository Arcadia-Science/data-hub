"use client";
import {
  RUN_FILTERS,
  type RunFilterValues,
} from "@/components/runs/run-filters";
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { RUN_STATUS_OPTIONS, type RunStatus } from "@/lib/runs/run-status";

// Lives in its own module so the popover's command menu library loads when the
// popover opens instead of with the toolbar.
export function RunFiltersList({
  values,
  onChange,
  selectedStatuses,
  onStatusChange,
}: {
  values: RunFilterValues;
  onChange: (next: RunFilterValues) => void;
  selectedStatuses?: RunStatus[];
  onStatusChange?: (next: RunStatus[]) => void;
}) {
  const showStatus =
    selectedStatuses !== undefined && onStatusChange !== undefined;

  function toggleStatus(status: RunStatus) {
    const current = selectedStatuses ?? [];
    const next = current.includes(status)
      ? current.filter((s) => s !== status)
      : [...current, status];
    onStatusChange?.(next);
  }

  return (
    <Command>
      <CommandList>
        <CommandGroup>
          {RUN_FILTERS.map((filter) => {
            const Icon = filter.icon;
            const active = values[filter.key];
            return (
              <CommandItem
                data-checked={active}
                key={filter.key}
                onSelect={() => onChange({ ...values, [filter.key]: !active })}
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
                    <Icon className={status.colorClassName} />
                    {status.label}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </Command>
  );
}
