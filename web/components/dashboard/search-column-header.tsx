"use client";

import { ChevronsUpDown, ListFilter, Search } from "lucide-react";
import { type Nullable, useQueryStates, type Values } from "nuqs";
import { FILTERED_COLUMN_HEADER_CLASS_NAME } from "@/components/instruments/runs-table/filterable-column-header";
import { useTablePending } from "@/components/table-pending";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { dashboardSearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

const filterParams = {
  search: dashboardSearchParams.search,
  page: dashboardSearchParams.page,
  notebooks_q: dashboardSearchParams.notebooks_q,
  notebooks_page: dashboardSearchParams.notebooks_page,
};

// Each search, and the page of its own table that a new search goes back to.
const PAGE_FOR_SEARCH = {
  search: "page",
  notebooks_q: "notebooks_page",
} as const;

/**
 * A column header whose menu is a search box, such as Run ID on a runs table
 * or Name on Home's lab notebooks. It filters as you type and goes back to
 * the table's first page.
 */
export function SearchColumnHeader({
  inputLabel,
  label,
  param,
  placeholder,
}: {
  // The search box's accessible name.
  inputLabel: string;
  label: string;
  param: keyof typeof PAGE_FOR_SEARCH;
  placeholder: string;
}) {
  const { startTransition } = useTablePending();
  const [params, setParams] = useQueryStates(filterParams, {
    shallow: false,
    throttleMs: 300,
    startTransition,
  });
  const value = params[param];
  const filtered = value !== "";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          className={cn(
            "-ml-2 h-8 gap-1 font-medium",
            filtered && FILTERED_COLUMN_HEADER_CLASS_NAME
          )}
          size="sm"
          variant="ghost"
        >
          {filtered ? (
            <ListFilter className="size-3" />
          ) : (
            <ChevronsUpDown className="size-3 opacity-50" />
          )}
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <div className="relative">
          <Search
            aria-hidden="true"
            className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label={inputLabel}
            className="pl-9"
            onChange={(event) =>
              setParams({
                [param]: event.target.value,
                [PAGE_FOR_SEARCH[param]]: null,
              } as Partial<Nullable<Values<typeof filterParams>>>)
            }
            placeholder={placeholder}
            value={value}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
