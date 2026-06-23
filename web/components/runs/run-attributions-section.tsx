import { RanByCell } from "@/components/instruments/runs-table/ran-by-cell";
import type { RunAttribution } from "@/lib/api/instrument-runs";

// Used inline in the run header's metadata row (alongside Created/Updated
// timestamps) to show and mutate attributions. Reuses RanByCell so the
// claim/remove UX matches the list.
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
    <div className="flex items-center gap-2">
      <span>Ran By</span>
      <RanByCell
        attributions={attributions}
        instrumentId={instrumentId}
        runId={runId}
      />
    </div>
  );
}
