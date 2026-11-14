import type { NextRequest } from "next/server";
import { surfaceEvent, trackEvent } from "@/lib/analytics/track";
import { actorRefFromAuth } from "@/lib/api/actor";
import { authorize } from "@/lib/api/auth";
import { apiErrorFromResult } from "@/lib/api/errors";
import { bulkAddNotebookLinkBody, readJsonBody } from "@/lib/api/openapi";
import { bulkAddResultToWire } from "@/lib/api/run-notebook-link-wire";
import { bulkAddNotebookLink } from "@/lib/api/run-notebook-links";
import { blankLabelToNull } from "@/lib/notebook-links/url";

// ---------------------------------------------------------------------------
// POST /api/v1/instrument-runs/notebook-links
//
// Add one lab notebook link to many runs, which can belong to different
// instruments. Body: { runs: [{ instrument_id, run_id }], url, label? }.
// Reports an outcome for each run instead of failing the whole request: runs
// that already link to the page keep their link, and deleted or missing runs
// are skipped.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const authResult = await authorize(request, "runs:link");
  if (authResult instanceof Response) {
    return authResult;
  }

  const payload = await readJsonBody(request, bulkAddNotebookLinkBody);
  if (payload instanceof Response) {
    return payload;
  }

  const result = await bulkAddNotebookLink({
    runs: payload.runs.map((run) => ({
      instrumentId: run.instrument_id,
      runId: run.run_id,
    })),
    url: payload.url,
    label: blankLabelToNull(payload.label ?? ""),
    actor: actorRefFromAuth(authResult),
  });
  if (!result.ok) {
    return apiErrorFromResult(result);
  }

  const wire = bulkAddResultToWire(result.value);
  if (wire.counts.added > 0) {
    trackEvent("notebook_link_added", {
      ...surfaceEvent(authResult),
      runs: wire.counts.added,
    });
  }

  return Response.json(wire);
}
