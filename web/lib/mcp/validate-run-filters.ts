import { getInstrumentFilterOptions } from "@/lib/api/instrument-runs";
import { getInstrumentById } from "@/lib/api/instruments";
import {
  RUN_METADATA_FILTER_DEFS,
  type RunMetadataFilterArgs,
  type RunMetadataFilterKey,
} from "@/lib/api/run-metadata-filters";

const FILTER_KEYS = RUN_METADATA_FILTER_DEFS.map(
  (def) => def.key
) as RunMetadataFilterKey[];

const KEY_TO_KIND = Object.fromEntries(
  RUN_METADATA_FILTER_DEFS.map((def) => [def.key, def.kind])
) as Record<
  RunMetadataFilterKey,
  (typeof RUN_METADATA_FILTER_DEFS)[number]["kind"]
>;

const KEY_TO_ALLOWED = Object.fromEntries(
  RUN_METADATA_FILTER_DEFS.map((def) => [def.key, def.allowedValues])
) as Record<
  RunMetadataFilterKey,
  (typeof RUN_METADATA_FILTER_DEFS)[number]["allowedValues"]
>;

// When a single instrument is scoped, reject metadata values that are not in
// that instrument's filter-options so agents get a corrective enum list.
export async function validateSearchRunsMetadataFilters(
  instrumentId: string,
  args: RunMetadataFilterArgs
): Promise<string | null> {
  const hasAny = FILTER_KEYS.some((key) => args[key] !== undefined);
  if (!hasAny) {
    return null;
  }

  const instrument = await getInstrumentById(instrumentId);
  if (!instrument) {
    return null;
  }

  const options = await getInstrumentFilterOptions(
    instrument.instrumentType,
    instrumentId
  );

  for (const key of FILTER_KEYS) {
    const value = args[key];
    if (value === undefined) {
      continue;
    }
    // Generic instruments have no filter enum to validate against, so we can't
    // produce a corrective list — let these through untouched.
    if (options.kind === "default") {
      continue;
    }
    // Reject filters that don't apply to this instrument's type instead of
    // ignoring them, so an agent can't believe a filter narrowed the query
    // when it was silently dropped.
    if (KEY_TO_KIND[key] !== options.kind) {
      return (
        `Filter ${key}="${value}" does not apply to instrument '${instrumentId}' (type ${options.kind}). ` +
        `See datahub://instruments/${instrumentId}/filter-options for applicable filters.`
      );
    }
    const allowed = KEY_TO_ALLOWED[key](options);
    if (!allowed.includes(value)) {
      return (
        `Invalid ${key}="${value}" for instrument '${instrumentId}'. ` +
        `Expected one of: ${allowed.length > 0 ? allowed.map((v) => JSON.stringify(v)).join(", ") : "(none available)"}. ` +
        `See datahub://instruments/${instrumentId}/filter-options.`
      );
    }
  }

  return null;
}
