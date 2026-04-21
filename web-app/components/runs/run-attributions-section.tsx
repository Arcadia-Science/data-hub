import { RanByCell } from "@/components/instruments/runs-table/ran-by-cell";
import type { RunAttribution } from "@/lib/api/instrument-runs";

// Used on the run detail page to show (and mutate) attributions next to the
// run header. We reuse RanByCell so the claim/remove UX matches the list.
// Wrapped in a `group` so the cell's hover-only affordances reveal correctly
// whether the user hovers the label area or the avatars.
export function RunAttributionsSection({
  instrumentId,
  runId,
  attributions,
}: {
  instrumentId: string;
  runId: string;
  attributions: RunAttribution[];
}) {
  return (
    <div className="group flex items-center gap-3 rounded-lg border bg-card/50 px-4 py-2.5">
      <span className="text-xs font-medium text-muted-foreground">Ran by</span>
      <RanByCell
        instrumentId={instrumentId}
        runId={runId}
        attributions={attributions}
      />
    </div>
  );
}
