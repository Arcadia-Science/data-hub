"use client";

import { ChevronsUpDown, ListFilter } from "lucide-react";
import {
  type Nullable,
  type UseQueryStatesKeysMap,
  useQueryStates,
  type Values,
} from "nuqs";
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

// The header drives a single nullable-string radio filter and resets the page,
// so it works with any nuqs parser map exposing the target column key plus a
// `page` key. Defaults to the per-instrument params; the dashboard tables pass
// `dashboardSearchParams` instead.
type ColumnFilterKeyMap = UseQueryStatesKeysMap & { page: unknown };

// Column-filter keys are the nullable-string entries in the parser map
// (`parseAsString` without a default). Keys whose parser carries a default —
// page/per_page/search/include_deleted — resolve to non-null values and are
// excluded automatically, so adding a new `parseAsString` filter to a params
// map makes it a valid `paramKey` with no hand-maintenance here.
type FilterParamKey<KeyMap extends UseQueryStatesKeysMap> = {
  [K in keyof Values<KeyMap>]: null extends Values<KeyMap>[K]
    ? Values<KeyMap>[K] extends string | null
      ? K
      : never
    : never;
}[keyof Values<KeyMap>] &
  string;

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

export function FilterableColumnHeader<
  KeyMap extends ColumnFilterKeyMap = typeof instrumentDetailSearchParams,
>({
  label,
  paramKey,
  options,
  searchParams = instrumentDetailSearchParams as unknown as KeyMap,
}: {
  label: string;
  paramKey: FilterParamKey<KeyMap>;
  options: FilterOption[];
  searchParams?: KeyMap;
}) {
  const { startTransition } = useTablePending();
  const [filters, setFilters] = useQueryStates(searchParams, {
    shallow: false,
    throttleMs: 300,
    startTransition,
  });

  const currentValue = (filters[paramKey] ?? null) as string | null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className={cn(
            "-ml-2 h-8 gap-1 font-medium",
            currentValue && "text-foreground"
          )}
          size="sm"
          variant="ghost"
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
          onValueChange={(value) =>
            setFilters({
              [paramKey]: value || null,
              page: 1,
            } as Partial<Nullable<Values<KeyMap>>>)
          }
          value={currentValue ?? ""}
        >
          <DropdownMenuRadioItem value="">All</DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {options.map((option) => {
            const { value, label: optionLabel } = normalizeOption(option);
            return (
              <DropdownMenuRadioItem key={value} value={value}>
                {optionLabel}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
