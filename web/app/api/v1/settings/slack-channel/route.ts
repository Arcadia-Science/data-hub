import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/api/auth";
import { apiError, VALIDATION_ERROR } from "@/lib/api/errors";
import {
  getSlackChannelConfigForAdmin,
  upsertSlackChannelWebhookUrl,
} from "@/lib/slack/channel-config";
import { slackChannelWebhookPutBodySchema } from "@/lib/slack/webhook-url";

// Admin-only read/write of the singleton `slack_channel_config` row,
// edited via the "Slack channel" section on `/settings/notifications`.
// The webhook URL is never returned on GET — only a `configured` flag.

interface SlackChannelResponse {
  configured: boolean;
  updated_at: string | null;
  updated_by: {
    id: string;
    name: string | null;
    email: string | null;
  } | null;
}

async function readCurrent(): Promise<SlackChannelResponse> {
  const config = await getSlackChannelConfigForAdmin();

  return {
    configured: config.configured,
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

  return Response.json(await readCurrent());
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

  const parsed = slackChannelWebhookPutBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError(400, VALIDATION_ERROR, "Invalid request body", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    });
  }

  await upsertSlackChannelWebhookUrl(
    parsed.data.webhook_url,
    authResult.userId
  );

  return Response.json(await readCurrent());
}
