"use client";

import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type SortOrder = "asc" | "desc";

/**
 * A column header with a menu to sort by that column. It only draws the header:
 * the caller says whether this column is the sorted one, reads the order from
 * wherever the sort lives (a URL, in every table so far), and writes the new
 * order back in `onOrderChange`.
 *
 * `align` is the side of the cell the button sits on, so number columns can
 * line up with their cells. `trailing` renders beside the button, for a control
 * that belongs to the column, such as a legend.
 */
export function SortableTableHead({
  active,
  align = "start",
  label,
  onOrderChange,
  order,
  trailing,
}: {
  // Whether the table is sorted by this column.
  active: boolean;
  align?: "start" | "end";
  label: string;
  onOrderChange: (order: SortOrder) => void;
  // The direction the table is sorted in. Only shown while `active`.
  order: SortOrder;
  trailing?: ReactNode;
}) {
  const isEnd = align === "end";

  let ariaSort: "ascending" | "descending" | undefined;
  if (active) {
    ariaSort = order === "asc" ? "ascending" : "descending";
  }

  let icon = <ChevronsUpDown className="size-3 opacity-50" />;
  if (active) {
    icon =
      order === "asc" ? (
        <ArrowUp className="size-3" />
      ) : (
        <ArrowDown className="size-3" />
      );
  }

  return (
    <TableHead aria-sort={ariaSort}>
      <div className={cn("flex items-center", isEnd && "justify-end")}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              className={cn(
                "h-8 gap-1 font-medium",
                isEnd ? "-mr-2" : "-ml-2",
                active && "text-foreground"
              )}
              size="sm"
              variant="ghost"
            >
              {icon}
              {label}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align={isEnd ? "end" : "start"} className="w-44">
            <DropdownMenuRadioGroup
              onValueChange={(value) => {
                if (value === "asc" || value === "desc") {
                  onOrderChange(value);
                }
              }}
              value={active ? order : ""}
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
        {trailing}
      </div>
    </TableHead>
  );
}
