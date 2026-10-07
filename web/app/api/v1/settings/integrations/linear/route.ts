import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/api/auth";
import { apiError, INTERNAL_ERROR } from "@/lib/api/errors";
import { readJsonBody } from "@/lib/api/openapi";
import {
  IntegrationSecretsKeyError,
  type IntegrationSecretsKeyStatus,
  integrationSecretsKeyStatus,
} from "@/lib/crypto/integration-secrets";
import { lastUpdatedResponse } from "@/lib/integrations/last-updated";
import {
  disconnectLinear,
  getLinearConfigForAdmin,
  type LinearConfigForAdmin,
  linearConfigPutBodySchema,
  updateLinearConfig,
} from "@/lib/linear/config";

// Admin-only Linear app settings. Secrets are never returned: the response
// says whether each one is set. The PUT body mirrors this response, so a
// client can read, change one field, and send it back.

export function linearConfigResponse(
  config: LinearConfigForAdmin,
  keyStatus: IntegrationSecretsKeyStatus = integrationSecretsKeyStatus()
) {
  return {
    client_id: config.clientId,
    client_secret: config.clientSecret,
    webhook_secret: config.webhookSecret,
    team: config.team,
    team_key: config.teamKey,
    project: config.project,
    project_url: config.projectUrl,
    labels: config.labels,
    workspace_id: config.workspaceId,
    workspace_name: config.workspaceName,
    workspace_url_key: config.workspaceUrlKey,
    webhook_rejections: config.webhookRejections,
    last_webhook_rejected_at: config.lastWebhookRejectedAt
      ? config.lastWebhookRejectedAt.toISOString()
      : null,
    last_webhook_rejection_reason: config.lastWebhookRejectionReason,
    last_webhook_at: config.lastWebhookAt
      ? config.lastWebhookAt.toISOString()
      : null,
    secrets_key: keyStatus,
    ...lastUpdatedResponse(config.lastUpdated),
  };
}

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
