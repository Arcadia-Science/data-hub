"use client";

import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { useQueryStates } from "nuqs";
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
import {
  type NOTEBOOK_LIST_SORT_FIELDS,
  notebooksIndexSearchParams,
} from "@/lib/search-params";
import { cn } from "@/lib/utils";

type NotebookSortField = (typeof NOTEBOOK_LIST_SORT_FIELDS)[number];

const sortParams = {
  sort: notebooksIndexSearchParams.sort,
  order: notebooksIndexSearchParams.order,
  page: notebooksIndexSearchParams.page,
};

// The order a sort uses when the URL doesn't say, matching `listNotebooks`.
function defaultOrder(field: NotebookSortField): "asc" | "desc" {
  return field === "name" ? "asc" : "desc";
}

/**
 * A `/lab-notebooks` column header with a menu to sort by that column, the way
 * the runs tables sort by time. Picking an order goes back to page 1.
 */
export function NotebookSortHeader({
  label,
  field,
  align = "start",
}: {
  label: string;
  field: NotebookSortField;
  align?: "start" | "end";
}) {
  const { startTransition } = useTablePending();
  const [state, setState] = useQueryStates(sortParams, {
    shallow: false,
    startTransition,
  });

  const isActive = state.sort === field;
  const order = state.order ?? defaultOrder(field);

  let ariaSort: "ascending" | "descending" | undefined;
  if (isActive) {
    ariaSort = order === "asc" ? "ascending" : "descending";
  }

  let icon = <ChevronsUpDown className="size-3 opacity-50" />;
  if (isActive) {
    icon =
      order === "asc" ? (
        <ArrowUp className="size-3" />
      ) : (
        <ArrowDown className="size-3" />
      );
  }

  return (
    <TableHead aria-sort={ariaSort}>
      <div className={cn("flex", align === "end" && "justify-end")}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              className={cn(
                "h-8 gap-1 font-medium",
                align === "end" ? "-mr-2" : "-ml-2",
                isActive && "text-foreground"
              )}
              size="sm"
              variant="ghost"
            >
              {icon}
              {label}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align={align === "end" ? "end" : "start"}
            className="w-44"
          >
            <DropdownMenuRadioGroup
              onValueChange={(value) => {
                if (value !== "asc" && value !== "desc") {
                  return;
                }
                setState({
                  sort: field,
                  // The column's own default stays out of the URL.
                  order: value === defaultOrder(field) ? null : value,
                  page: null,
                });
              }}
              value={isActive ? order : ""}
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
