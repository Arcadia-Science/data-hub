"use client";

import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { parseAsInteger, useQueryStates } from "nuqs";
import { useTablePending } from "@/components/table-pending";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TableHead } from "@/components/ui/table";
import { type RUN_SORT_FIELDS, runSortSearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

// Same parsers on the dashboard, a member's runs page, and every instrument
// page, so this header does not need a source prop. `page` resets with the
// sort so a new order does not land on an empty page.
const runListSortParams = {
  ...runSortSearchParams,
  page: parseAsInteger.withDefault(1),
};

type RunSortField = (typeof RUN_SORT_FIELDS)[number];

export function SortableColumnHeader({
  label,
  field,
}: {
  label: string;
  field: RunSortField;
}) {
  const { startTransition } = useTablePending();
  const [sortState, setSortState] = useQueryStates(runListSortParams, {
    shallow: false,
    startTransition,
  });

  const isActive = sortState.sort === field;

  return (
    <TableHead
      aria-sort={
        isActive
          ? sortState.order === "asc"
            ? "ascending"
            : "descending"
          : undefined
      }
    >
      <div className="flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              className={cn(
                "-mr-2 h-8 gap-1 font-medium",
                isActive && "text-foreground"
              )}
              size="sm"
              variant="ghost"
            >
              {isActive ? (
                sortState.order === "asc" ? (
                  <ArrowUp className="size-3" />
                ) : (
                  <ArrowDown className="size-3" />
                )
              ) : (
                <ChevronsUpDown className="size-3 opacity-50" />
              )}
              {label}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuRadioGroup
              onValueChange={(value) => {
                if (value !== "asc" && value !== "desc") {
                  return;
                }
                setSortState({ sort: field, order: value, page: 1 });
              }}
              value={isActive ? sortState.order : ""}
            >
              <DropdownMenuRadioItem value="asc">
                Sort ascending
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="desc">
                Sort descending
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </TableHead>
  );
}
