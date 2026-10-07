import { eq } from "drizzle-orm";
import {
  encryptIntegrationSecret,
  readMaybeEncryptedSecret,
} from "@/lib/crypto/integration-secrets";
import { db } from "@/lib/db";
import { slackChannelConfig, users } from "@/lib/db/schema";
import {
  type LastUpdated,
  lastUpdatedByColumns,
  toLastUpdated,
} from "@/lib/integrations/last-updated";

export interface SlackChannelConfigForAdmin {
  configured: boolean;
  lastUpdated: LastUpdated | null;
}

export async function getSlackChannelWebhookUrl(): Promise<string | null> {
  const [row] = await db
    .select({ webhookUrl: slackChannelConfig.webhookUrl })
    .from(slackChannelConfig);

  return readMaybeEncryptedSecret(row?.webhookUrl ?? null);
}

export async function getSlackChannelConfigForAdmin(): Promise<SlackChannelConfigForAdmin> {
  const [row] = await db
    .select({
      webhookUrl: slackChannelConfig.webhookUrl,
      updatedAt: slackChannelConfig.updatedAt,
      ...lastUpdatedByColumns,
    })
    .from(slackChannelConfig)
    .leftJoin(users, eq(users.id, slackChannelConfig.updatedBy));

  if (!row) {
    return { configured: false, lastUpdated: null };
  }

  return {
    configured: readMaybeEncryptedSecret(row.webhookUrl) != null,
    lastUpdated: toLastUpdated(row),
  };
}

export async function upsertSlackChannelWebhookUrl(
  webhookUrl: string | null,
  updatedBy: string
): Promise<SlackChannelConfigForAdmin> {
  const now = new Date();
  // Null clears the webhook. A URL is encrypted before it is written so a
  // database backup does not contain a working Slack webhook.
  const stored =
    webhookUrl == null ? null : encryptIntegrationSecret(webhookUrl);
  await db
    .insert(slackChannelConfig)
    .values({
      id: true,
      webhookUrl: stored,
      updatedAt: now,
      updatedBy,
    })
    .onConflictDoUpdate({
      target: slackChannelConfig.id,
      set: {
        webhookUrl: stored,
        updatedAt: now,
        updatedBy,
      },
    });

  return getSlackChannelConfigForAdmin();
}
