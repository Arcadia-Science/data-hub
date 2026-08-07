import type { NextRequest } from "next/server";
import { authorize } from "@/lib/api/auth";
import { apiError, NOT_FOUND, VALIDATION_ERROR } from "@/lib/api/errors";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import { getReportItemsPage } from "@/lib/api/report-items";
import { parseIntParam } from "@/lib/api/validators";
import {
  isReportItemKind,
  REPORT_ITEM_KINDS,
  REPORT_ITEMS_MAX_LIMIT,
  REPORT_ITEMS_WINDOW,
} from "@/lib/runs/report-items";

interface RouteContext {
  params: Promise<{ instrumentId: string; runId: string }>;
}

// GET /api/v1/instruments/:instrumentId/runs/:runId/report-items — uses
// offset/limit, not page/per_page, because a seeker addresses item indices.
export async function GET(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "files:read");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { instrumentId, runId } = await params;
  const run = await lookupRunByNaturalKey(instrumentId, runId);
  if (!run) {
    return apiError(
      404,
      NOT_FOUND,
      `Run '${runId}' not found for instrument '${instrumentId}'`
    );
  }

  const { searchParams } = request.nextUrl;
  const kind = searchParams.get("kind") ?? "";
  if (!isReportItemKind(kind)) {
    return apiError(
      400,
      VALIDATION_ERROR,
      `kind must be one of: ${REPORT_ITEM_KINDS.join(", ")}`
    );
  }

  const anchor = Number.parseInt(searchParams.get("anchor") ?? "", 10);
  const page = await getReportItemsPage(run.id, {
    kind,
    anchorId: anchor > 0 ? anchor : undefined,
    search: searchParams.get("search") || undefined,
    offset: parseIntParam(searchParams.get("offset"), { default: 0, min: 0 }),
    limit: parseIntParam(searchParams.get("limit"), {
      default: REPORT_ITEMS_WINDOW,
      min: 1,
      max: REPORT_ITEMS_MAX_LIMIT,
    }),
  });

  return Response.json(page);
}
