// Slack app credentials for DMs and "Connect Slack".
//
// A saved column wins over the matching environment variable. Clearing the
// column (null) makes that variable the source again. Bot token and client
// secret are encrypted before they are written.

import { eq } from "drizzle-orm";
import { z } from "zod";
import { inspectSavedSecret } from "@/lib/crypto/integration-secrets";
import { db } from "@/lib/db";
import { slackAppConfig, users } from "@/lib/db/schema";
import { nextPlain, nextSecret } from "@/lib/integrations/config-patch";
import {
  type PlainFieldStatus,
  plainFieldStatus,
  resolveIntegrationField,
  type SecretFieldStatus,
  savedPlainValue,
  secretFieldStatus,
} from "@/lib/integrations/field-status";
import {
  type LastUpdated,
  lastUpdatedByColumns,
  toLastUpdated,
} from "@/lib/integrations/last-updated";

export interface SlackAppCredentials {
  botToken: string | null;
  clientId: string | null;
  clientSecret: string | null;
  teamId: string | null;
}

export interface SlackAppConfigForAdmin {
  botToken: SecretFieldStatus;
  clientId: PlainFieldStatus;
  clientSecret: SecretFieldStatus;
  lastUpdated: LastUpdated | null;
  teamId: PlainFieldStatus;
}

const optionalSecret = z.string().trim().min(1).nullable().optional();

export const slackAppConfigPutBodySchema = z
  .object({
    bot_token: z
      .string()
      .trim()
      .min(1, "Enter a bot token")
      .startsWith("xoxb-", "Bot tokens start with xoxb-")
      .nullable()
      .optional(),
    client_id: optionalSecret,
    client_secret: optionalSecret,
    team_id: optionalSecret,
  })
  .refine(
    (body) =>
      body.bot_token !== undefined ||
      body.client_id !== undefined ||
      body.client_secret !== undefined ||
      body.team_id !== undefined,
    { message: "No Slack settings to save" }
  );

export type SlackAppConfigPutBody = z.infer<typeof slackAppConfigPutBodySchema>;

const rowColumns = {
  botToken: slackAppConfig.botToken,
  clientId: slackAppConfig.clientId,
  clientSecret: slackAppConfig.clientSecret,
  teamId: slackAppConfig.teamId,
  updatedAt: slackAppConfig.updatedAt,
  ...lastUpdatedByColumns,
};

async function loadRow() {
  const [row] = await db
    .select(rowColumns)
    .from(slackAppConfig)
    .leftJoin(users, eq(users.id, slackAppConfig.updatedBy));
  return row ?? null;
}

function resolvedFromRow(row: Awaited<ReturnType<typeof loadRow>>) {
  return {
    botToken: resolveIntegrationField(
      inspectSavedSecret(row?.botToken ?? null),
      process.env.SLACK_BOT_TOKEN
    ),
    clientId: resolveIntegrationField(
      savedPlainValue(row?.clientId ?? null),
      process.env.SLACK_CLIENT_ID
    ),
    clientSecret: resolveIntegrationField(
      inspectSavedSecret(row?.clientSecret ?? null),
      process.env.SLACK_CLIENT_SECRET
    ),
    teamId: resolveIntegrationField(
      savedPlainValue(row?.teamId ?? null),
      process.env.SLACK_TEAM_ID
    ),
  };
}

export async function getSlackAppCredentials(): Promise<SlackAppCredentials> {
  const resolved = resolvedFromRow(await loadRow());
  return {
    botToken: resolved.botToken.value,
    clientId: resolved.clientId.value,
    clientSecret: resolved.clientSecret.value,
    teamId: resolved.teamId.value,
  };
}

export async function getSlackAppConfigForAdmin(): Promise<SlackAppConfigForAdmin> {
  const row = await loadRow();
  const resolved = resolvedFromRow(row);
  return {
    botToken: secretFieldStatus(resolved.botToken),
    clientId: plainFieldStatus(resolved.clientId),
    clientSecret: secretFieldStatus(resolved.clientSecret),
    teamId: plainFieldStatus(resolved.teamId),
    lastUpdated: toLastUpdated(row),
  };
}

export async function updateSlackAppConfig(
  patch: SlackAppConfigPutBody,
  updatedBy: string
): Promise<SlackAppConfigForAdmin> {
  await db.transaction(async (tx) => {
    // Locks the singleton row so two admins saving at once apply one after
    // the other instead of overwriting each other's fields. The insert makes
    // sure a first-ever save has a row to lock.
    await tx
      .insert(slackAppConfig)
      .values({ id: true, updatedBy })
      .onConflictDoNothing();
    const [row] = await tx
      .select({
        botToken: slackAppConfig.botToken,
        clientId: slackAppConfig.clientId,
        clientSecret: slackAppConfig.clientSecret,
        teamId: slackAppConfig.teamId,
      })
      .from(slackAppConfig)
      .where(eq(slackAppConfig.id, true))
      .for("update");

    await tx
      .update(slackAppConfig)
      .set({
        botToken: nextSecret(row?.botToken ?? null, patch.bot_token),
        clientId: nextPlain(row?.clientId ?? null, patch.client_id),
        clientSecret: nextSecret(
          row?.clientSecret ?? null,
          patch.client_secret
        ),
        teamId: nextPlain(row?.teamId ?? null, patch.team_id),
        updatedAt: new Date(),
        updatedBy,
      })
      .where(eq(slackAppConfig.id, true));
  });

  return getSlackAppConfigForAdmin();
}
