"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { todayDateString } from "@/lib/date";
import { watcherDetailSearchParams } from "@/lib/search-params";
import { X } from "lucide-react";
import { useQueryStates } from "nuqs";

export function StatusToolbar() {
  const [filters, setFilters] = useQueryStates(watcherDetailSearchParams, {
    shallow: false,
    throttleMs: 300,
  });

  const today = todayDateString();
  const isNonDefault = filters.since !== null && filters.since !== today;

  return (
    <div className="flex items-center gap-2">
      <Input
        type="date"
        value={filters.since ?? today}
        onChange={(e) => setFilters({ since: e.target.value || null })}
        className="h-8 w-36 text-xs"
        aria-label="Status since"
      />
      {isNonDefault && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setFilters({ since: null })}
          className="h-8 gap-1 text-xs"
        >
          <X className="size-3" />
          Clear
        </Button>
      )}
    </div>
  );
}
