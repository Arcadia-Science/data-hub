import { getInstruments } from "@/lib/api/dashboard";
import { buildRunListQuery } from "@/lib/api/instrument-runs";

interface CompletionContext {
  arguments?: Record<string, string>;
}

export async function completeInstrumentId(value: string): Promise<string[]> {
  // IDs only — avoid the run/watcher count join used by the instruments list.
  const instruments = await getInstruments();
  const needle = value.toLowerCase();
  return instruments
    .map((i) => i.id)
    .filter((id) => id.toLowerCase().startsWith(needle));
}

export async function completeRunId(
  value: string,
  context?: CompletionContext
): Promise<string[]> {
  const instrumentId = context?.arguments?.instrumentId;
  if (!instrumentId) {
    return [];
  }
  // Push the typed prefix into the DB filter so we aren't limited to the
  // 50 most recent runs. The SDK caps completion values at 100.
  const result = await buildRunListQuery({
    instrumentId,
    search: value,
    page: 1,
    perPage: 100,
    includeDeleted: false,
    sort: "acquired_at",
    order: "desc",
  });
  return result.data.map((row) => row.run_id);
}
