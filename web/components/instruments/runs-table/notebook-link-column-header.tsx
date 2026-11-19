"use client";

import { ChevronsUpDown, ListFilter } from "lucide-react";
import dynamic from "next/dynamic";
import { useQueryStates } from "nuqs";
import { useState } from "react";
import { LoadErrorBoundary } from "@/components/load-error-boundary";
import { useTablePending } from "@/components/table-pending";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import type { NotebookFilterOption } from "@/lib/api/notebooks";
import { preloader } from "@/lib/preload";
import {
  type NotebookFilter,
  notebookFilterParams,
  readNotebookFilter,
} from "@/lib/runs/notebook-filter";
import {
  instrumentDetailSearchParams,
  notebookFilterSearchParams,
} from "@/lib/search-params";
import { cn } from "@/lib/utils";
import { FILTERED_COLUMN_HEADER_CLASS_NAME } from "./filterable-column-header";

// The dashboard's params map uses the same parsers for these keys, so one map
// serves every runs table.
const filterParams = {
  ...notebookFilterSearchParams,
  page: instrumentDetailSearchParams.page,
};

const loadNotebookLinkFilterList = () =>
  import("./notebook-link-filter-list").then((m) => m.NotebookLinkFilterList);

const preloadNotebookLinkFilterList = preloader(loadNotebookLinkFilterList);

const NotebookLinkFilterList = dynamic(loadNotebookLinkFilterList, {
  ssr: false,
  loading: () => (
    <div aria-hidden className="flex flex-col gap-2 p-2">
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-6 w-full" />
      <Skeleton className="h-6 w-full" />
    </div>
  ),
});

/**
 * The "Lab Notebook" column header: a menu that filters the runs table to
 * runs in any notebook, in none, or in one notebook the viewer picks.
 */
export function NotebookLinkColumnHeader({
  options,
}: {
  options: NotebookFilterOption[];
}) {
  const { startTransition } = useTablePending();
  const [params, setParams] = useQueryStates(filterParams, {
    shallow: false,
    throttleMs: 300,
    startTransition,
  });
  const [open, setOpen] = useState(false);
  const filter = readNotebookFilter(params);
  const filtered = filter.kind !== "all";

  function select(next: NotebookFilter) {
    setOpen(false);
    setParams({ ...notebookFilterParams(next), page: 1 });
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          className={cn(
            "-ml-2 h-8 gap-1 font-medium",
            filtered && FILTERED_COLUMN_HEADER_CLASS_NAME
          )}
          onFocus={preloadNotebookLinkFilterList}
          onMouseEnter={preloadNotebookLinkFilterList}
          size="sm"
          variant="ghost"
        >
          {filtered ? (
            <ListFilter className="size-3" />
          ) : (
            <ChevronsUpDown className="size-3 opacity-50" />
          )}
          Lab Notebook
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-75 p-0">
        <LoadErrorBoundary>
          <NotebookLinkFilterList
            filter={filter}
            onSelect={select}
            options={options}
          />
        </LoadErrorBoundary>
      </PopoverContent>
    </Popover>
  );
}
