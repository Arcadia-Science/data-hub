import type { NextRequest } from "next/server";
import { surfaceEvent, trackEvent } from "@/lib/analytics/track";
import { authorize } from "@/lib/api/auth";
import { apiErrorFromResult } from "@/lib/api/errors";
import { bulkRemoveNotebookLinksBody, readJsonBody } from "@/lib/api/openapi";
import { bulkRemoveResultToWire } from "@/lib/api/run-notebook-link-wire";
import { bulkRemoveNotebookLinks } from "@/lib/api/run-notebook-links";

// ---------------------------------------------------------------------------
// POST /api/v1/instrument-runs/notebook-links/remove
//
// Remove links to the given pages from many runs. Body: { runs, urls }. Each
// URL removes any link to the same page. A POST rather than a DELETE with a
// body, which some proxies and clients drop.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const authResult = await authorize(request, "runs:link");
  if (authResult instanceof Response) {
    return authResult;
  }

  const payload = await readJsonBody(request, bulkRemoveNotebookLinksBody);
  if (payload instanceof Response) {
    return payload;
  }

  const result = await bulkRemoveNotebookLinks({
    runs: payload.runs.map((run) => ({
      instrumentId: run.instrument_id,
      runId: run.run_id,
    })),
    urls: payload.urls,
  });
  if (!result.ok) {
    return apiErrorFromResult(result);
  }

  const wire = bulkRemoveResultToWire(result.value);
  if (wire.counts.removed > 0) {
    trackEvent("notebook_link_removed", {
      ...surfaceEvent(authResult),
      runs: wire.counts.removed,
    });
  }

  return Response.json(wire);
}
