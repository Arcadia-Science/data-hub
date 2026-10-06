// Saved Linear OAuth app settings. Client secret and webhook signing secret
// are encrypted. Nothing falls back to an environment variable: Linear is
// off until an admin saves a client ID, client secret, and team.

import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  encryptIntegrationSecret,
  readMaybeEncryptedSecret,
} from "@/lib/crypto/integration-secrets";
import { db } from "@/lib/db";
import { linearIntegrationConfig, users } from "@/lib/db/schema";

const optionalText = z.string().trim().min(1).nullable().optional();
const optionalId = z.string().uuid().nullable().optional();

export const linearConfigPutBodySchema = z
  .object({
    client_id: optionalText,
    client_secret: optionalText,
    webhook_secret: optionalText,
    team_id: optionalId,
    team_name: optionalText,
    project_id: optionalId,
    project_name: optionalText,
    bug_label_id: optionalId,
    bug_label_name: optionalText,
    feature_label_id: optionalId,
    feature_label_name: optionalText,
    other_label_id: optionalId,
    other_label_name: optionalText,
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "No Linear settings to save",
  });

export type LinearConfigPutBody = z.infer<typeof linearConfigPutBodySchema>;

export const linearTestBodySchema = z.object({
  client_id: z.string().trim().min(1).optional(),
  client_secret: z.string().trim().min(1).optional(),
});

export interface LinearNamedChoice {
  id: string;
  name: string;
}

export interface LinearSecretStatus {
  set: boolean;
}

export interface LinearConfigForAdmin {
  bugLabel: LinearNamedChoice | null;
  clientId: string | null;
  clientSecret: LinearSecretStatus;
  featureLabel: LinearNamedChoice | null;
  lastWebhookAt: Date | null;
  otherLabel: LinearNamedChoice | null;
  project: LinearNamedChoice | null;
  team: LinearNamedChoice | null;
  updatedAt: Date | null;
  updatedByEmail: string | null;
  updatedById: string | null;
  updatedByName: string | null;
  webhookSecret: LinearSecretStatus;
}

export interface LinearCredentials {
  clientId: string;
  clientSecret: string;
  webhookSecret: string | null;
}

function choice(
  id: string | null | undefined,
  name: string | null | undefined
): LinearNamedChoice | null {
  if (!(id && name)) {
    return null;
  }
  return { id, name };
}

async function loadRow() {
  const [row] = await db
    .select({
      clientId: linearIntegrationConfig.clientId,
      clientSecret: linearIntegrationConfig.clientSecret,
      webhookSecret: linearIntegrationConfig.webhookSecret,
      teamId: linearIntegrationConfig.teamId,
      teamName: linearIntegrationConfig.teamName,
      projectId: linearIntegrationConfig.projectId,
      projectName: linearIntegrationConfig.projectName,
      bugLabelId: linearIntegrationConfig.bugLabelId,
      bugLabelName: linearIntegrationConfig.bugLabelName,
      featureLabelId: linearIntegrationConfig.featureLabelId,
      featureLabelName: linearIntegrationConfig.featureLabelName,
      otherLabelId: linearIntegrationConfig.otherLabelId,
      otherLabelName: linearIntegrationConfig.otherLabelName,
      lastWebhookAt: linearIntegrationConfig.lastWebhookAt,
      updatedAt: linearIntegrationConfig.updatedAt,
      updatedById: users.id,
      updatedByName: users.name,
      updatedByEmail: users.email,
    })
    .from(linearIntegrationConfig)
    .leftJoin(users, eq(users.id, linearIntegrationConfig.updatedBy));
  return row ?? null;
}

export async function getLinearCredentials(): Promise<LinearCredentials | null> {
  const row = await loadRow();
  const clientId = row?.clientId?.trim() ? row.clientId.trim() : null;
  const clientSecret = readMaybeEncryptedSecret(row?.clientSecret ?? null);
  if (!(clientId && clientSecret)) {
    return null;
  }
  return {
    clientId,
    clientSecret,
    webhookSecret: readMaybeEncryptedSecret(row?.webhookSecret ?? null),
  };
}

export async function getLinearConfigForAdmin(): Promise<LinearConfigForAdmin> {
  const row = await loadRow();
  return {
    clientId: row?.clientId ?? null,
    clientSecret: {
      set: readMaybeEncryptedSecret(row?.clientSecret ?? null) != null,
    },
    webhookSecret: {
      set: readMaybeEncryptedSecret(row?.webhookSecret ?? null) != null,
    },
    team: choice(row?.teamId, row?.teamName),
    project: choice(row?.projectId, row?.projectName),
    bugLabel: choice(row?.bugLabelId, row?.bugLabelName),
    featureLabel: choice(row?.featureLabelId, row?.featureLabelName),
    otherLabel: choice(row?.otherLabelId, row?.otherLabelName),
    lastWebhookAt: row?.lastWebhookAt ?? null,
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

export async function updateLinearConfig(
  patch: LinearConfigPutBody,
  updatedBy: string
): Promise<LinearConfigForAdmin> {
  const row = await loadRow();
  const teamChanged =
    patch.team_id !== undefined && patch.team_id !== (row?.teamId ?? null);
  const now = new Date();
  const projectId = nextPlain(
    teamChanged ? null : (row?.projectId ?? null),
    patch.project_id
  );
  const bugLabelId = nextPlain(
    teamChanged ? null : (row?.bugLabelId ?? null),
    patch.bug_label_id
  );
  const featureLabelId = nextPlain(
    teamChanged ? null : (row?.featureLabelId ?? null),
    patch.feature_label_id
  );
  const otherLabelId = nextPlain(
    teamChanged ? null : (row?.otherLabelId ?? null),
    patch.other_label_id
  );

  const teamId = nextPlain(row?.teamId ?? null, patch.team_id);
  const values = {
    id: true as const,
    clientId: nextPlain(row?.clientId ?? null, patch.client_id),
    clientSecret: nextSecret(row?.clientSecret ?? null, patch.client_secret),
    webhookSecret: nextSecret(row?.webhookSecret ?? null, patch.webhook_secret),
    teamId,
    teamName: teamId ? nextPlain(row?.teamName ?? null, patch.team_name) : null,
    projectId,
    projectName: projectId
      ? nextPlain(
          teamChanged ? null : (row?.projectName ?? null),
          patch.project_name
        )
      : null,
    bugLabelId,
    bugLabelName: bugLabelId
      ? nextPlain(
          teamChanged ? null : (row?.bugLabelName ?? null),
          patch.bug_label_name
        )
      : null,
    featureLabelId,
    featureLabelName: featureLabelId
      ? nextPlain(
          teamChanged ? null : (row?.featureLabelName ?? null),
          patch.feature_label_name
        )
      : null,
    otherLabelId,
    otherLabelName: otherLabelId
      ? nextPlain(
          teamChanged ? null : (row?.otherLabelName ?? null),
          patch.other_label_name
        )
      : null,
    updatedAt: now,
    updatedBy,
  };

  const { id: _id, ...update } = values;
  await db.insert(linearIntegrationConfig).values(values).onConflictDoUpdate({
    target: linearIntegrationConfig.id,
    set: update,
  });

  return getLinearConfigForAdmin();
}
