import { authenticateRequest } from "@/lib/api/auth";
import { apiError, UNAUTHORIZED } from "@/lib/api/errors";
import type { NextRequest } from "next/server";

type RouteContext = {
  params: Promise<{ instrumentId: string; runId: string }>;
};

// ---------------------------------------------------------------------------
// Analysis endpoints are stubbed until the Lambda invocation infrastructure
// is wired up. Returns 501 so clients can distinguish "not yet built" from
// other error states.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authResult = await authenticateRequest(request);
  if (!authResult) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }

  // Consume params to satisfy Next.js dynamic route requirements.
  await params;

  return Response.json(
    {
      error: {
        code: "NOT_IMPLEMENTED",
        message:
          "Analysis triggering is not yet implemented. This endpoint will invoke a Lambda function in a future release.",
      },
    },
    { status: 501 }
  );
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const authResult = await authenticateRequest(request);
  if (!authResult) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }

  await params;

  return Response.json(
    {
      error: {
        code: "NOT_IMPLEMENTED",
        message:
          "Analysis listing is not yet implemented. This endpoint will return analysis results in a future release.",
      },
    },
    { status: 501 }
  );
}
