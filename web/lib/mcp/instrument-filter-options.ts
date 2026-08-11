import { getInstrumentFilterOptions } from "@/lib/api/instrument-runs";
import { getInstrumentById } from "@/lib/api/instruments";

export type ResolveInstrumentFilterOptionsResult =
  | { ok: true; options: object }
  | { ok: false; error: string };

/** Shared lookup for the filter-options resource and MCP tool. */
export async function resolveInstrumentFilterOptions(
  instrumentId: string
): Promise<ResolveInstrumentFilterOptionsResult> {
  const instrument = await getInstrumentById(instrumentId);
  if (!instrument) {
    return { ok: false, error: `Instrument '${instrumentId}' not found` };
  }

  const result = await getInstrumentFilterOptions(
    instrument.instrumentType,
    instrumentId
  );
  if (result.kind === "default") {
    return {
      ok: false,
      error: `Instrument type '${instrument.instrumentType}' has no structured filter options`,
    };
  }

  return { ok: true, options: result.options };
}
