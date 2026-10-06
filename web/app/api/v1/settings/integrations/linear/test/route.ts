import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/api/auth";
import { apiError, VALIDATION_ERROR } from "@/lib/api/errors";
import { LinearRequestError, testLinearConnection } from "@/lib/linear/client";
import {
  getLinearCredentials,
  linearTestBodySchema,
} from "@/lib/linear/config";

export async function POST(request: NextRequest) {
  const authResult = await requireAdmin();
  if (authResult instanceof Response) {
    return authResult;
  }

  let rawBody: unknown = {};
  const text = await request.text();
  if (text.length > 0) {
    try {
      rawBody = JSON.parse(text);
    } catch {
      return apiError(400, VALIDATION_ERROR, "Invalid JSON body");
    }
  }

  const parsed = linearTestBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError(400, VALIDATION_ERROR, "Invalid request body");
  }

  const saved = await getLinearCredentials();
  const clientId = parsed.data.client_id ?? saved?.clientId ?? null;
  const clientSecret = parsed.data.client_secret ?? saved?.clientSecret ?? null;
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
      return apiError(502, "LINEAR_UNAVAILABLE", err.message);
    }
    throw err;
  }
}
