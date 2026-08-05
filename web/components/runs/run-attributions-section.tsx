import { RanByCell } from "@/components/instruments/runs-table/ran-by-cell";
import type { RunAttribution } from "@/lib/api/instrument-runs";

// Used in the run summary card's "Ran By" field to show and mutate
// attributions. Reuses RanByCell so the claim/remove UX matches the list.
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
    <RanByCell
      attributions={attributions}
      compact
      instrumentId={instrumentId}
      runId={runId}
      showName
    />
  );
}
