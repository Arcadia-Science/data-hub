import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/api/auth";
import { apiError, INTERNAL_ERROR, VALIDATION_ERROR } from "@/lib/api/errors";
import { IntegrationSecretsKeyError } from "@/lib/crypto/integration-secrets";
import {
  getSlackAppConfigForAdmin,
  type SlackAppConfigForAdmin,
  slackAppConfigPutBodySchema,
  updateSlackAppConfig,
} from "@/lib/slack/app-config";

// Admin-only Slack app credentials. Secrets are never returned: the
// response says whether each one is set and whether it comes from the
// database or an environment variable.

function toResponse(config: SlackAppConfigForAdmin) {
  return {
    bot_token: config.botToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    team_id: config.teamId,
    updated_at: config.updatedAt ? config.updatedAt.toISOString() : null,
    updated_by: config.updatedById
      ? {
          id: config.updatedById,
          name: config.updatedByName,
          email: config.updatedByEmail,
        }
      : null,
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

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return apiError(400, VALIDATION_ERROR, "Invalid JSON body");
  }

  const parsed = slackAppConfigPutBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError(400, VALIDATION_ERROR, "Invalid request body", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    });
  }

  try {
    const updated = await updateSlackAppConfig(parsed.data, authResult.userId);
    return Response.json(toResponse(updated));
  } catch (err) {
    if (err instanceof IntegrationSecretsKeyError) {
      return apiError(500, INTERNAL_ERROR, err.message);
    }
    throw err;
  }
}
