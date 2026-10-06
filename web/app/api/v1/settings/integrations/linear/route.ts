import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/api/auth";
import { apiError, INTERNAL_ERROR, VALIDATION_ERROR } from "@/lib/api/errors";
import { IntegrationSecretsKeyError } from "@/lib/crypto/integration-secrets";
import {
  getLinearConfigForAdmin,
  type LinearConfigForAdmin,
  linearConfigPutBodySchema,
  updateLinearConfig,
} from "@/lib/linear/config";

function choice(value: { id: string; name: string } | null) {
  return value ? { id: value.id, name: value.name } : null;
}

function toResponse(config: LinearConfigForAdmin) {
  return {
    client_id: config.clientId,
    client_secret: config.clientSecret,
    webhook_secret: config.webhookSecret,
    team: choice(config.team),
    project: choice(config.project),
    labels: {
      bug: choice(config.bugLabel),
      feature_request: choice(config.featureLabel),
      other: choice(config.otherLabel),
    },
    last_webhook_at: config.lastWebhookAt
      ? config.lastWebhookAt.toISOString()
      : null,
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
  return Response.json(toResponse(await getLinearConfigForAdmin()));
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

  const parsed = linearConfigPutBodySchema.safeParse(rawBody);
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
    const updated = await updateLinearConfig(parsed.data, authResult.userId);
    return Response.json(toResponse(updated));
  } catch (err) {
    if (err instanceof IntegrationSecretsKeyError) {
      return apiError(500, INTERNAL_ERROR, err.message);
    }
    throw err;
  }
}
