"use client";

import { ListFilter } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";
import { LoadErrorBoundary } from "@/components/load-error-boundary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  FilesCategoryFilter,
  FilesLifecycleFilter,
} from "@/lib/api/instrument-runs";
import { preloader } from "@/lib/preload";
import { countActiveFileFilters } from "@/lib/runs/file-filters";
import { CODE_BADGE_COLORS } from "@/lib/ui-classes";
import { cn } from "@/lib/utils";

// The menu uses the command palette library, which most page visits never
// need. It loads when the popover first opens, or earlier when the pointer or
// focus reaches the button.
const loadFileFiltersList = () =>
  import("@/components/runs/file-filters-list").then((m) => m.FileFiltersList);

const preloadFileFiltersList = preloader(loadFileFiltersList);

const FileFiltersList = dynamic(loadFileFiltersList, {
  ssr: false,
  loading: () => (
    <div aria-hidden className="flex flex-col gap-2 p-2">
      <Skeleton className="h-6 w-full" />
      <Skeleton className="h-6 w-full" />
    </div>
  ),
});

export function FileFiltersCombobox({
  categories,
  deletedCount,
  onCategoriesChange,
  onShowDeletedChange,
  onStatusesChange,
  showDeleted,
  statuses,
}: {
  categories: FilesCategoryFilter[];
  // Deleted files that match the current search and filters.
  deletedCount: number;
  onCategoriesChange: (next: FilesCategoryFilter[]) => void;
  onShowDeletedChange: (next: boolean) => void;
  onStatusesChange: (next: FilesLifecycleFilter[]) => void;
  showDeleted: boolean;
  statuses: FilesLifecycleFilter[];
}) {
  const [open, setOpen] = useState(false);
  const activeCount = countActiveFileFilters({
    categories,
    showDeleted,
    statuses,
  });

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-expanded={open}
          className="h-8 gap-2 font-normal"
          onFocus={preloadFileFiltersList}
          onMouseEnter={preloadFileFiltersList}
          role="combobox"
          size="sm"
          variant="outline"
        >
          <ListFilter className="size-3.5 text-muted-foreground" />
          <span className="text-sm">Add filter</span>
          {activeCount > 0 && (
            <Badge
              className={cn("ml-0.5 px-1.5 text-[10px]", CODE_BADGE_COLORS)}
              variant="secondary"
            >
              {activeCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <LoadErrorBoundary>
          <FileFiltersList
            categories={categories}
            deletedCount={deletedCount}
            onCategoriesChange={onCategoriesChange}
            onShowDeletedChange={onShowDeletedChange}
            onStatusesChange={onStatusesChange}
            showDeleted={showDeleted}
            statuses={statuses}
          />
        </LoadErrorBoundary>
      </PopoverContent>
    </Popover>
  );
}
