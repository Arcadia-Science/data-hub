// Slack app credentials for DMs and "Connect Slack".
//
// A saved column wins over the matching environment variable. Clearing the
// column (null) makes that variable the source again. Bot token and client
// secret are encrypted before they are written.

import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  encryptIntegrationSecret,
  readMaybeEncryptedSecret,
} from "@/lib/crypto/integration-secrets";
import { db } from "@/lib/db";
import { slackAppConfig, users } from "@/lib/db/schema";

export type SlackAppConfigSource = "database" | "environment";

export interface SlackAppCredentials {
  botToken: string | null;
  clientId: string | null;
  clientSecret: string | null;
  teamId: string | null;
}

export interface SlackSecretFieldStatus {
  set: boolean;
  source: SlackAppConfigSource | null;
}

export interface SlackPlainFieldStatus extends SlackSecretFieldStatus {
  value: string | null;
}

export interface SlackAppConfigForAdmin {
  botToken: SlackSecretFieldStatus;
  clientId: SlackPlainFieldStatus;
  clientSecret: SlackSecretFieldStatus;
  teamId: SlackPlainFieldStatus;
  updatedAt: Date | null;
  updatedByEmail: string | null;
  updatedById: string | null;
  updatedByName: string | null;
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

export function resolveSlackSetting(
  stored: string | null,
  envValue: string | undefined
): { source: SlackAppConfigSource | null; value: string | null } {
  const fromDb = stored?.trim() ? stored.trim() : null;
  if (fromDb) {
    return { value: fromDb, source: "database" };
  }
  const fromEnv = envValue?.trim() ? envValue.trim() : null;
  if (fromEnv) {
    return { value: fromEnv, source: "environment" };
  }
  return { value: null, source: null };
}

function secretStatus(
  resolved: ReturnType<typeof resolveSlackSetting>
): SlackSecretFieldStatus {
  return {
    set: resolved.value != null,
    source: resolved.source,
  };
}

function plainStatus(
  resolved: ReturnType<typeof resolveSlackSetting>
): SlackPlainFieldStatus {
  return {
    set: resolved.value != null,
    source: resolved.source,
    value: resolved.value,
  };
}

async function loadRow() {
  const [row] = await db
    .select({
      botToken: slackAppConfig.botToken,
      clientId: slackAppConfig.clientId,
      clientSecret: slackAppConfig.clientSecret,
      teamId: slackAppConfig.teamId,
      updatedAt: slackAppConfig.updatedAt,
      updatedById: users.id,
      updatedByName: users.name,
      updatedByEmail: users.email,
    })
    .from(slackAppConfig)
    .leftJoin(users, eq(users.id, slackAppConfig.updatedBy));
  return row ?? null;
}

function resolvedFromRow(row: Awaited<ReturnType<typeof loadRow>>) {
  return {
    botToken: resolveSlackSetting(
      readMaybeEncryptedSecret(row?.botToken ?? null),
      process.env.SLACK_BOT_TOKEN
    ),
    clientId: resolveSlackSetting(
      row?.clientId ?? null,
      process.env.SLACK_CLIENT_ID
    ),
    clientSecret: resolveSlackSetting(
      readMaybeEncryptedSecret(row?.clientSecret ?? null),
      process.env.SLACK_CLIENT_SECRET
    ),
    teamId: resolveSlackSetting(row?.teamId ?? null, process.env.SLACK_TEAM_ID),
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
    botToken: secretStatus(resolved.botToken),
    clientId: plainStatus(resolved.clientId),
    clientSecret: secretStatus(resolved.clientSecret),
    teamId: plainStatus(resolved.teamId),
    updatedAt: row?.updatedAt ?? null,
    updatedById: row?.updatedById ?? null,
    updatedByName: row?.updatedByName ?? null,
    updatedByEmail: row?.updatedByEmail ?? null,
  };
}

function nextPlain(
  current: string | null,
  patch: string | null | undefined
): string | null {
  if (patch === undefined) {
    return current;
  }
  return patch;
}

function nextSecret(
  current: string | null,
  patch: string | null | undefined
): string | null {
  if (patch === undefined) {
    return current;
  }
  if (patch === null) {
    return null;
  }
  return encryptIntegrationSecret(patch);
}

export async function updateSlackAppConfig(
  patch: SlackAppConfigPutBody,
  updatedBy: string
): Promise<SlackAppConfigForAdmin> {
  const row = await loadRow();
  const now = new Date();
  const values = {
    id: true as const,
    botToken: nextSecret(row?.botToken ?? null, patch.bot_token),
    clientId: nextPlain(row?.clientId ?? null, patch.client_id),
    clientSecret: nextSecret(row?.clientSecret ?? null, patch.client_secret),
    teamId: nextPlain(row?.teamId ?? null, patch.team_id),
    updatedAt: now,
    updatedBy,
  };

  await db
    .insert(slackAppConfig)
    .values(values)
    .onConflictDoUpdate({
      target: slackAppConfig.id,
      set: {
        botToken: values.botToken,
        clientId: values.clientId,
        clientSecret: values.clientSecret,
        teamId: values.teamId,
        updatedAt: now,
        updatedBy,
      },
    });

  return getSlackAppConfigForAdmin();
}
