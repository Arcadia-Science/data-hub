"use client";

import { useQueryStates } from "nuqs";
import {
  type DateRange,
  RunsDateFilter,
} from "@/components/runs/runs-date-filter";
import { useTablePending } from "@/components/table-pending";
import { watcherDetailSearchParams } from "@/lib/search-params";
import { instantOrNull } from "@/lib/watchers/range";

/**
 * The days that Activity and Health show, as `RunsDateFilter` picks them. With
 * no range in the URL the tab shows its default, which is "Last 7 days" for a
 * current watcher. `fallback` is the range to show instead when the URL names
 * none and the default isn't that: a past watcher's last week, or the days that
 * an old link's `?since=` asked for.
 */
export function WatcherRangeFilter({ fallback }: { fallback: DateRange }) {
  // The new range is a server render away, so tie the URL change to the tab's
  // pending state: the content dims until it arrives.
  const { startTransition } = useTablePending();
  const [filters, setFilters] = useQueryStates(watcherDetailSearchParams, {
    shallow: false,
    startTransition,
  });

  // A value that isn't a date is no range: the picker can't write it down, and
  // the page ignores it too.
  const from = instantOrNull(filters.date_from);
  const to = instantOrNull(filters.date_to);
  const value: DateRange = from || to ? { from, to } : fallback;

  return (
    <RunsDateFilter
      align="end"
      defaultPreset="7d"
      onChange={(range) =>
        setFilters({
          date_from: range.from,
          date_to: range.to,
          // A new range replaces whatever an old link asked for, and starts the
          // list from its top again.
          since: null,
          events_since: null,
          shown: null,
        })
      }
      value={value}
    />
  );
}
