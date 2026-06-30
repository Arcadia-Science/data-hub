"use client";

import { X } from "lucide-react";
import { useQueryStates } from "nuqs";
import { useTablePending } from "@/components/table-pending";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { todayDateString } from "@/lib/date";
import { watcherDetailSearchParams } from "@/lib/search-params";

export function StatusToolbar() {
  // Tying URL updates to the surrounding TablePendingProvider's transition lets
  // <HeartbeatChart> swap to a loading skeleton while the new server data is in
  // flight, instead of briefly flashing the empty state when the previously
  // loaded heartbeats no longer fall inside the new date window.
  const { startTransition } = useTablePending();
  const [filters, setFilters] = useQueryStates(watcherDetailSearchParams, {
    shallow: false,
    throttleMs: 300,
    startTransition,
  });

  const today = todayDateString();
  const isNonDefault = filters.since !== null && filters.since !== today;

  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label="Status since"
        className="h-8 w-36 text-xs"
        onChange={(e) => setFilters({ since: e.target.value || null })}
        type="date"
        value={filters.since ?? today}
      />
      {isNonDefault && (
        <Button
          className="h-8 gap-1 text-xs"
          onClick={() => setFilters({ since: null })}
          size="sm"
          variant="ghost"
        >
          <X className="size-3" />
          Clear
        </Button>
      )}
    </div>
  );
}
