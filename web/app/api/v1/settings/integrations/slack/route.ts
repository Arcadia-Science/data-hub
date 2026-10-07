import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/api/auth";
import { apiError, INTERNAL_ERROR } from "@/lib/api/errors";
import { readJsonBody } from "@/lib/api/openapi";
import { IntegrationSecretsKeyError } from "@/lib/crypto/integration-secrets";
import { lastUpdatedResponse } from "@/lib/integrations/last-updated";
import {
  getSlackAppConfigForAdmin,
  type SlackAppConfigForAdmin,
  slackAppConfigPutBodySchema,
  updateSlackAppConfig,
} from "@/lib/slack/app-config";

// Admin-only Slack app credentials. Secrets are never returned: the
// response says whether each one is set and where its value comes from.

function toResponse(config: SlackAppConfigForAdmin) {
  return {
    bot_token: config.botToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    team_id: config.teamId,
    ...lastUpdatedResponse(config.lastUpdated),
  };
}

export async function GET() {
  const authResult = await requireAdmin();
  if (authResult instanceof Response) {
    return authResult;
  }

  return Response.json(toResponse(await getSlackAppConfigForAdmin()));
}

export async function PUT(request: NextRequest) {
  const authResult = await requireAdmin();
  if (authResult instanceof Response) {
    return authResult;
  }

  const body = await readJsonBody(request, slackAppConfigPutBodySchema);
  if (body instanceof Response) {
    return body;
  }

  try {
    return Response.json(
      toResponse(await updateSlackAppConfig(body, authResult.userId))
    );
  } catch (err) {
    if (err instanceof IntegrationSecretsKeyError) {
      return apiError(500, INTERNAL_ERROR, err.message);
    }
    throw err;
  }
}
