"use client";

import { useTablePending } from "@/components/table-pending";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { instrumentDetailSearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";
import { ChevronsUpDown, ListFilter } from "lucide-react";
import { useQueryStates } from "nuqs";

type FilterParamKey =
  | "wavelength"
  | "measurement_mode"
  | "measurement_type"
  | "capture_type"
  | "imaging_mode"
  | "gel_wavelength"
  | "gel_color"
  | "dye_channel"
  | "hina_channel"
  | "hina_dimension"
  | "hina_size"
  | "ran_by";

// Options accept either plain strings (value == label) or { value, label }
// pairs for cases where the URL-stable value and the display label differ
// (e.g., `ran_by` stores a userId but renders the user's display name).
export type FilterOption = string | { value: string; label: string };

function normalizeOption(option: FilterOption): {
  value: string;
  label: string;
} {
  return typeof option === "string" ? { value: option, label: option } : option;
}

export function FilterableColumnHeader({
  label,
  paramKey,
  options,
}: {
  label: string;
  paramKey: FilterParamKey;
  options: FilterOption[];
}) {
  const { startTransition } = useTablePending();
  const [filters, setFilters] = useQueryStates(instrumentDetailSearchParams, {
    shallow: false,
    throttleMs: 300,
    startTransition,
  });

  const currentValue = filters[paramKey];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "-ml-2 h-8 gap-1 font-medium",
            currentValue && "text-foreground"
          )}
        >
          {currentValue ? (
            <ListFilter className="size-3" />
          ) : (
            <ChevronsUpDown className="size-3 opacity-50" />
          )}
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuRadioGroup
          value={currentValue ?? ""}
          onValueChange={(value) =>
            setFilters({ [paramKey]: value || null, page: 1 })
          }
        >
          <DropdownMenuRadioItem value="">All</DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {options.map((option) => {
            const { value, label } = normalizeOption(option);
            return (
              <DropdownMenuRadioItem key={value} value={value}>
                {label}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
