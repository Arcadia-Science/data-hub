import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/api/auth";
import { apiError, INTERNAL_ERROR } from "@/lib/api/errors";
import { readJsonBody } from "@/lib/api/openapi";
import { IntegrationSecretsKeyError } from "@/lib/crypto/integration-secrets";
import {
  disconnectLinear,
  getLinearConfigForAdmin,
  linearConfigPutBodySchema,
  updateLinearConfig,
} from "@/lib/linear/config";
import { linearConfigResponse } from "@/lib/linear/config-response";

// Admin-only Linear app settings. Secrets are never returned: the response
// says whether each one is set. PUT saves the team, project, labels, and
// signing secret. Credentials go through `/connect`, which checks them first.

export async function GET() {
  const authResult = await requireAdmin();
  if (authResult instanceof Response) {
    return authResult;
  }
  return Response.json(linearConfigResponse(await getLinearConfigForAdmin()));
}

export async function PUT(request: NextRequest) {
  const authResult = await requireAdmin();
  if (authResult instanceof Response) {
    return authResult;
  }

  const body = await readJsonBody(request, linearConfigPutBodySchema);
  if (body instanceof Response) {
    return body;
  }

  try {
    return Response.json(
      linearConfigResponse(await updateLinearConfig(body, authResult.userId))
    );
  } catch (err) {
    if (err instanceof IntegrationSecretsKeyError) {
      return apiError(500, INTERNAL_ERROR, err.message);
    }
    throw err;
  }
}

export async function DELETE() {
  const authResult = await requireAdmin();
  if (authResult instanceof Response) {
    return authResult;
  }
  await disconnectLinear();
  return Response.json(linearConfigResponse(await getLinearConfigForAdmin()));
}
