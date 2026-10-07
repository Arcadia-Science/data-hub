// Saved Linear OAuth app settings. Client secret and webhook signing secret
// are encrypted. Nothing falls back to an environment variable: Linear is
// off until an admin saves a client ID, client secret, and team.

import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  type FeedbackKind,
  feedbackKindSchema,
} from "@/lib/api/feedback-schema";
import {
  inspectSavedSecret,
  readMaybeEncryptedSecret,
} from "@/lib/crypto/integration-secrets";
import { db } from "@/lib/db";
import { linearIntegrationConfig, users } from "@/lib/db/schema";
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
import {
  clearLinearTokenCache,
  type LinearChoice,
  type LinearCredentials,
} from "./client";

const optionalText = z.string().trim().min(1).nullable().optional();

export const linearChoiceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1),
});

export type LinearLabelChoices = Record<FeedbackKind, LinearChoice | null>;

const optionalChoice = linearChoiceSchema.nullable().optional();

export const linearConfigPutBodySchema = z
  .object({
    client_id: optionalText,
    client_secret: optionalText,
    webhook_secret: optionalText,
    team: optionalChoice,
    project: optionalChoice,
    labels: z
      .partialRecord(feedbackKindSchema, linearChoiceSchema.nullable())
      .optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "No Linear settings to save",
  });

export type LinearConfigPutBody = z.infer<typeof linearConfigPutBodySchema>;

export const linearTestBodySchema = z.object({
  client_id: z.string().trim().min(1).optional(),
  client_secret: z.string().trim().min(1).optional(),
});

export interface LinearConfigForAdmin {
  clientId: PlainFieldStatus;
  clientSecret: SecretFieldStatus;
  labels: LinearLabelChoices;
  lastUpdated: LastUpdated | null;
  lastWebhookAt: Date | null;
  project: LinearChoice | null;
  team: LinearChoice | null;
  webhookSecret: SecretFieldStatus;
}

export interface SavedLinearCredentials extends LinearCredentials {
  webhookSecret: string | null;
}

function choice(
  id: string | null | undefined,
  name: string | null | undefined
): LinearChoice | null {
  if (!(id && name)) {
    return null;
  }
  return { id, name };
}

const configColumns = {
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
};

type ConfigRow = {
  [K in keyof typeof configColumns]: string | null;
};

function labelsFromRow(row: ConfigRow | null | undefined): LinearLabelChoices {
  return {
    bug: choice(row?.bugLabelId, row?.bugLabelName),
    feature_request: choice(row?.featureLabelId, row?.featureLabelName),
    other: choice(row?.otherLabelId, row?.otherLabelName),
  };
}

// `sent` is what the admin submitted: `undefined` leaves the choice alone and
// `null` clears it. `keepSaved` is false once the team changes.
function nextChoice(
  saved: LinearChoice | null,
  sent: LinearChoice | null | undefined,
  keepSaved: boolean
): LinearChoice | null {
  if (sent !== undefined) {
    return sent;
  }
  return keepSaved ? saved : null;
}

async function loadRow() {
  const [row] = await db
    .select({
      ...configColumns,
      lastWebhookAt: linearIntegrationConfig.lastWebhookAt,
      updatedAt: linearIntegrationConfig.updatedAt,
      ...lastUpdatedByColumns,
    })
    .from(linearIntegrationConfig)
    .leftJoin(users, eq(users.id, linearIntegrationConfig.updatedBy));
  return row ?? null;
}

export async function getLinearCredentials(): Promise<SavedLinearCredentials | null> {
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
  // No environment variable backs these, so `unreadable` means the saved
  // value cannot be opened and `set` is false.
  const savedSecret = (stored: string | null | undefined) =>
    secretFieldStatus(
      resolveIntegrationField(inspectSavedSecret(stored ?? null))
    );
  return {
    clientId: plainFieldStatus(
      resolveIntegrationField(savedPlainValue(row?.clientId ?? null))
    ),
    clientSecret: savedSecret(row?.clientSecret),
    webhookSecret: savedSecret(row?.webhookSecret),
    team: choice(row?.teamId, row?.teamName),
    project: choice(row?.projectId, row?.projectName),
    labels: labelsFromRow(row),
    lastWebhookAt: row?.lastWebhookAt ?? null,
    lastUpdated: toLastUpdated(row),
  };
}

export async function updateLinearConfig(
  patch: LinearConfigPutBody,
  updatedBy: string
): Promise<LinearConfigForAdmin> {
  await db.transaction(async (tx) => {
    // Locks the singleton row so two admins saving at once apply one after
    // the other. The team change below is decided from the locked row, so
    // it cannot be based on a stale read.
    await tx
      .insert(linearIntegrationConfig)
      .values({ id: true, updatedBy })
      .onConflictDoNothing();
    const [row] = await tx
      .select(configColumns)
      .from(linearIntegrationConfig)
      .where(eq(linearIntegrationConfig.id, true))
      .for("update");

    const savedTeam = choice(row?.teamId, row?.teamName);
    const team = patch.team === undefined ? savedTeam : patch.team;
    // A project or label belongs to one team, so a team change drops saved
    // ones. Choices sent in the same save came from the new team's lists and
    // stay. With no team, nothing is kept.
    const keepSaved = team != null && team.id === savedTeam?.id;
    const pick = (
      saved: LinearChoice | null,
      sent: LinearChoice | null | undefined
    ) => (team == null ? null : nextChoice(saved, sent, keepSaved));

    const project = pick(
      choice(row?.projectId, row?.projectName),
      patch.project
    );
    const savedLabels = labelsFromRow(row);
    const labels: LinearLabelChoices = {
      bug: pick(savedLabels.bug, patch.labels?.bug),
      feature_request: pick(
        savedLabels.feature_request,
        patch.labels?.feature_request
      ),
      other: pick(savedLabels.other, patch.labels?.other),
    };

    await tx
      .update(linearIntegrationConfig)
      .set({
        clientId: nextPlain(row?.clientId ?? null, patch.client_id),
        clientSecret: nextSecret(
          row?.clientSecret ?? null,
          patch.client_secret
        ),
        webhookSecret: nextSecret(
          row?.webhookSecret ?? null,
          patch.webhook_secret
        ),
        teamId: team?.id ?? null,
        teamName: team?.name ?? null,
        projectId: project?.id ?? null,
        projectName: project?.name ?? null,
        bugLabelId: labels.bug?.id ?? null,
        bugLabelName: labels.bug?.name ?? null,
        featureLabelId: labels.feature_request?.id ?? null,
        featureLabelName: labels.feature_request?.name ?? null,
        otherLabelId: labels.other?.id ?? null,
        otherLabelName: labels.other?.name ?? null,
        updatedAt: new Date(),
        updatedBy,
      })
      .where(eq(linearIntegrationConfig.id, true));
  });

  if (patch.client_id !== undefined || patch.client_secret !== undefined) {
    clearLinearTokenCache();
  }
  return getLinearConfigForAdmin();
}
