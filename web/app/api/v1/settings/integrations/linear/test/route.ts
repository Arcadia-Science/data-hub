import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/api/auth";
import {
  apiError,
  LINEAR_UNAVAILABLE,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import { readJsonBody } from "@/lib/api/openapi";
import { LinearRequestError, testLinearConnection } from "@/lib/linear/client";
import {
  getLinearCredentials,
  linearTestBodySchema,
} from "@/lib/linear/config";

// Tests the credentials typed into the form when there are any, so an admin
// can check a new secret before saving it. Otherwise tests the saved ones.
export async function POST(request: NextRequest) {
  const authResult = await requireAdmin();
  if (authResult instanceof Response) {
    return authResult;
  }

  const body = await readJsonBody(request, linearTestBodySchema);
  if (body instanceof Response) {
    return body;
  }

  const saved = await getLinearCredentials();
  const clientId = body.client_id ?? saved?.clientId ?? null;
  const clientSecret = body.client_secret ?? saved?.clientSecret ?? null;
  if (!(clientId && clientSecret)) {
    return apiError(
      400,
      VALIDATION_ERROR,
      "Save a Linear client ID and client secret first."
    );
  }

  try {
    const result = await testLinearConnection({ clientId, clientSecret });
    return Response.json({ organization_name: result.organizationName });
  } catch (err) {
    if (err instanceof LinearRequestError) {
      return apiError(502, LINEAR_UNAVAILABLE, err.message);
    }
    throw err;
  }
}
