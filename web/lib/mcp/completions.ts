import { buildRunListQuery } from "@/lib/api/instrument-runs";
import { getInstrumentListWithCounts } from "@/lib/api/instruments";

interface CompletionContext {
  arguments?: Record<string, string>;
}

export async function completeInstrumentId(value: string): Promise<string[]> {
  const instruments = await getInstrumentListWithCounts();
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
  const result = await buildRunListQuery({
    instrumentId,
    page: 1,
    perPage: 50,
    includeDeleted: false,
    sort: "acquired_at",
    order: "desc",
  });
  const needle = value.toLowerCase();
  return result.data
    .map((row) => row.run_id)
    .filter((id) => id.toLowerCase().startsWith(needle));
}
