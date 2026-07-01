import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { slackChannelConfig, users } from "@/lib/db/schema";

export interface SlackChannelConfigForAdmin {
  configured: boolean;
  updatedAt: Date | null;
  updatedByEmail: string | null;
  updatedById: string | null;
  updatedByName: string | null;
}

export async function getSlackChannelWebhookUrl(): Promise<string | null> {
  const [row] = await db
    .select({ webhookUrl: slackChannelConfig.webhookUrl })
    .from(slackChannelConfig);

  return row?.webhookUrl ?? null;
}

export async function getSlackChannelConfigForAdmin(): Promise<SlackChannelConfigForAdmin> {
  const [row] = await db
    .select({
      webhookUrl: slackChannelConfig.webhookUrl,
      updatedAt: slackChannelConfig.updatedAt,
      updatedById: users.id,
      updatedByName: users.name,
      updatedByEmail: users.email,
    })
    .from(slackChannelConfig)
    .leftJoin(users, eq(users.id, slackChannelConfig.updatedBy));

  if (!row) {
    return {
      configured: false,
      updatedAt: null,
      updatedById: null,
      updatedByName: null,
      updatedByEmail: null,
    };
  }

  return {
    configured: row.webhookUrl != null && row.webhookUrl.length > 0,
    updatedAt: row.updatedAt,
    updatedById: row.updatedById,
    updatedByName: row.updatedByName,
    updatedByEmail: row.updatedByEmail,
  };
}

export async function upsertSlackChannelWebhookUrl(
  webhookUrl: string | null,
  updatedBy: string
): Promise<SlackChannelConfigForAdmin> {
  const now = new Date();
  await db
    .insert(slackChannelConfig)
    .values({
      id: true,
      webhookUrl,
      updatedAt: now,
      updatedBy,
    })
    .onConflictDoUpdate({
      target: slackChannelConfig.id,
      set: {
        webhookUrl,
        updatedAt: now,
        updatedBy,
      },
    });

  return getSlackChannelConfigForAdmin();
}
