import { authenticateRequest } from "@/lib/api/auth";
import { apiError, UNAUTHORIZED } from "@/lib/api/errors";
import { buildRunListQuery } from "@/lib/api/instrument-runs";
import { parseIntParam } from "@/lib/api/validators";
import type { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// GET /api/v1/instrument-runs
//
// Cross-instrument run list for the dashboard. Same response shape as the
// per-instrument endpoint but without requiring an instrumentId in the path.
// Accepts an optional instrument_id query param to narrow results.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const authResult = await authenticateRequest(request);
  if (!authResult) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }

  const { searchParams } = request.nextUrl;

  const result = await buildRunListQuery({
    instrumentId: searchParams.get("instrument_id") ?? undefined,
    source: searchParams.get("source") ?? undefined,
    search: searchParams.get("search") ?? undefined,
    sort: searchParams.get("sort") ?? undefined,
    order: searchParams.get("order") ?? undefined,
    dateFrom: searchParams.get("date_from") ?? undefined,
    dateTo: searchParams.get("date_to") ?? undefined,
    page: parseIntParam(searchParams.get("page"), {
      default: 1,
      min: 1,
    }),
    perPage: parseIntParam(searchParams.get("per_page"), {
      default: 10,
      min: 1,
      max: 100,
    }),
    includeDeleted: searchParams.get("include_deleted") === "true",
    ranBy: searchParams.get("ran_by") ?? undefined,
  });

  return Response.json(result);
}
