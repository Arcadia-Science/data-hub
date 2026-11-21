"use client";

import { Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import type {
  FilesCategoryFilter,
  FilesLifecycleFilter,
} from "@/lib/api/instrument-runs";
import { FILES_LIFECYCLE_FILTER_VALUES } from "@/lib/runs/file-lifecycle-filter";
import { cn } from "@/lib/utils";
import { FILE_STATUS_CONFIG } from "./file-status-config";

// The swatches match the Raw and Processed badges in the table.
const FILE_TYPE_OPTIONS: {
  label: string;
  swatchClassName: string;
  value: FilesCategoryFilter;
}[] = [
  { value: "raw", label: "Raw", swatchClassName: "bg-blue-500" },
  { value: "processed", label: "Processed", swatchClassName: "bg-purple-500" },
];

function toggled<T>(values: readonly T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((v) => v !== value)
    : [...values, value];
}

// Lives in its own module so the popover's command menu library loads when the
// popover opens instead of with the toolbar.
export function FileFiltersList({
  categories,
  deletedCount,
  onCategoriesChange,
  onShowDeletedChange,
  onStatusesChange,
  showDeleted,
  statuses,
}: {
  categories: FilesCategoryFilter[];
  deletedCount: number;
  onCategoriesChange: (next: FilesCategoryFilter[]) => void;
  onShowDeletedChange: (next: boolean) => void;
  onStatusesChange: (next: FilesLifecycleFilter[]) => void;
  showDeleted: boolean;
  statuses: FilesLifecycleFilter[];
}) {
  // The menu has no search box, so nothing in it takes focus on its own and the
  // popover focuses its frame, where the arrow keys and Enter do nothing. The
  // list handles them, so it takes focus when the menu opens.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.focus();
  }, []);

  return (
    <Command>
      <CommandList label="File filters" ref={listRef}>
        <CommandGroup>
          <CommandItem
            data-checked={showDeleted}
            onSelect={() => onShowDeletedChange(!showDeleted)}
            value="Show deleted files"
          >
            <Trash2 className="size-3.5 text-muted-foreground" />
            <span className="flex-1">Show deleted files</span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {deletedCount}
            </span>
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Type">
          {FILE_TYPE_OPTIONS.map((option) => (
            <CommandItem
              data-checked={categories.includes(option.value)}
              key={option.value}
              onSelect={() =>
                onCategoriesChange(toggled(categories, option.value))
              }
              value={option.label}
            >
              <span
                aria-hidden
                className={cn("size-2 rounded-xs", option.swatchClassName)}
              />
              {option.label}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Status">
          {FILES_LIFECYCLE_FILTER_VALUES.map((status) => {
            const { Icon, className, label } = FILE_STATUS_CONFIG[status];
            return (
              <CommandItem
                data-checked={statuses.includes(status)}
                key={status}
                onSelect={() => onStatusesChange(toggled(statuses, status))}
                value={label}
              >
                <Icon className={className} />
                {label}
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}
