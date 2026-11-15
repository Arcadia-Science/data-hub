import type { NextRequest } from "next/server";
import {
  authorize,
  requireAdminForSession,
  requireExplicitTokenScope,
} from "@/lib/api/auth";
import { apiError, NOT_FOUND } from "@/lib/api/errors";
import { getInstrumentConfirmReview } from "@/lib/api/instrument-confirm-review";

// What the Confirm review dialog shows before an admin confirms a pending
// instrument: its watcher's folder, host and the name of the token that
// registered it. Admins only, like the other routes that expose a watcher's
// settings. Only that dialog reads it, so it stays out of the OpenAPI document.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ instrumentId: string }> }
) {
  const authResult = await authorize(request, "watchers:admin");
  if (authResult instanceof Response) {
    return authResult;
  }
  // Browser sessions must belong to an admin. Tokens must list
  // `watchers:admin` themselves, so the token on a lab PC, which can read
  // watchers, can't read another instrument's folder and host.
  const adminGate =
    (await requireAdminForSession(authResult)) ??
    requireExplicitTokenScope(authResult, "watchers:admin");
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
