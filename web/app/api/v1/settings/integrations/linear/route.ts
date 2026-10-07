import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/api/auth";
import { apiError, INTERNAL_ERROR } from "@/lib/api/errors";
import { readJsonBody } from "@/lib/api/openapi";
import { IntegrationSecretsKeyError } from "@/lib/crypto/integration-secrets";
import { lastUpdatedResponse } from "@/lib/integrations/last-updated";
import {
  getLinearConfigForAdmin,
  type LinearConfigForAdmin,
  linearConfigPutBodySchema,
  updateLinearConfig,
} from "@/lib/linear/config";

// Admin-only Linear app settings. Secrets are never returned: the response
// says whether each one is set. The PUT body mirrors this response, so a
// client can read, change one field, and send it back.

function toResponse(config: LinearConfigForAdmin) {
  return {
    client_id: config.clientId,
    client_secret: config.clientSecret,
    webhook_secret: config.webhookSecret,
    team: config.team,
    project: config.project,
    labels: config.labels,
    last_webhook_at: config.lastWebhookAt
      ? config.lastWebhookAt.toISOString()
      : null,
    ...lastUpdatedResponse(config.lastUpdated),
  };
}

export async function GET() {
  const authResult = await requireAdmin();
  if (authResult instanceof Response) {
    return authResult;
  }
  return Response.json(toResponse(await getLinearConfigForAdmin()));
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
      toResponse(await updateLinearConfig(body, authResult.userId))
    );
  } catch (err) {
    if (err instanceof IntegrationSecretsKeyError) {
      return apiError(500, INTERNAL_ERROR, err.message);
    }
    throw err;
  }
}
