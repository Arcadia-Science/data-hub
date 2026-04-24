import type { RunListRow } from "@/lib/api/instrument-runs";
import { SearchX } from "lucide-react";

import { RunsTableFooter } from "./runs-table-footer";

// Re-export under the historical name so imports like
// `import type { RunRow } from "@/components/instruments/runs-table"`
// keep working. The type itself is derived server-side.
export type RunRow = RunListRow;

export type RanByOption = { value: string; label: string };

export type RunsTableProps = {
  data: RunRow[];
  instrumentId: string;
  ranByOptions: RanByOption[];
};

/**
 * Thin wrapper around the per-instrument table variants.
 *
 * Previously this component owned a big `switch (instrumentType)` with one
 * optional `filterOptions` prop per instrument type (plus a non-null assertion
 * at every call site). That scaled poorly — every new instrument forced a new
 * optional prop here and a new `!` in the caller.
 *
 * The shell is now purely structural: the empty-state card when there are no
 * rows, otherwise the bordered frame + footer around whichever table variant
 * the caller chose to render as `children`. Picking the variant is the
 * caller's job, which lets each page compose the right discriminated
 * filter-options narrowing without routing them through this shell.
 */
export function InstrumentRunsTableShell({
  isEmpty,
  hasFilters,
  shownCount,
  totalCount,
  pendingUploadCount,
  unattributedCount,
  ranByYouCount,
  children,
}: {
  isEmpty: boolean;
  hasFilters: boolean;
  shownCount: number;
  totalCount: number;
  pendingUploadCount: number;
  unattributedCount: number;
  ranByYouCount: number;
  children: React.ReactNode;
}) {
  if (isEmpty) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-16">
        <SearchX className="size-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          {hasFilters
            ? "No runs match your filters."
            : "No instrument runs yet."}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border">
      {children}
      <RunsTableFooter
        shownCount={shownCount}
        totalCount={totalCount}
        pendingUploadCount={pendingUploadCount}
        unattributedCount={unattributedCount}
        ranByYouCount={ranByYouCount}
      />
    </div>
  );
}
