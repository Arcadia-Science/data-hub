import type { NextRequest } from "next/server";
import { authorize, requireAdminForSession } from "@/lib/api/auth";
import { apiError, NOT_FOUND } from "@/lib/api/errors";
import { getInstrumentConfirmReview } from "@/lib/api/instrument-confirm-review";

// What the Confirm review dialog shows before an admin confirms a pending
// instrument. Only that dialog reads it, so it stays out of the OpenAPI document.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ instrumentId: string }> }
) {
  const authResult = await authorize(request, "watchers:read");
  if (authResult instanceof Response) {
    return authResult;
  }
  // Browser sessions must belong to an admin. Tokens are checked by scope alone.
  const adminGate = await requireAdminForSession(authResult);
  if (adminGate) {
    return adminGate;
  }

  const { instrumentId } = await params;
  const review = await getInstrumentConfirmReview(instrumentId);
  if (!review) {
    return apiError(404, NOT_FOUND, `Instrument '${instrumentId}' not found`);
  }

  return Response.json(review);
}
