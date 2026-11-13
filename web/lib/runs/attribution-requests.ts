// Claims or unclaims runs for the signed-in person, one request per run.

export type AttributionMethod = "PUT" | "DELETE";

interface RunNaturalKey {
  instrumentId: string;
  runId: string;
}

export function ownAttributionUrl(instrumentId: string, runId: string): string {
  return `/api/v1/instruments/${encodeURIComponent(instrumentId)}/runs/${encodeURIComponent(runId)}/attributions/me`;
}

/** Sends every request even when some fail, and counts the results. */
export async function fanOutAttribution<Run extends RunNaturalKey>(
  method: AttributionMethod,
  runs: readonly Run[]
): Promise<{ ok: number; failed: number; failedRuns: Run[] }> {
  const results = await Promise.all(
    runs.map(async (run) => {
      try {
        const res = await fetch(
          ownAttributionUrl(run.instrumentId, run.runId),
          {
            method,
          }
        );
        return res.ok;
      } catch {
        return false;
      }
    })
  );
  const failedRuns = runs.filter((_, index) => !results[index]);
  return {
    ok: runs.length - failedRuns.length,
    failed: failedRuns.length,
    failedRuns,
  };
}
