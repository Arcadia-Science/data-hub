"use client";

import { useTablePending } from "@/components/table-pending";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { todayDateString } from "@/lib/date";
import { watcherDetailSearchParams } from "@/lib/search-params";
import { X } from "lucide-react";
import { useQueryStates } from "nuqs";

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
